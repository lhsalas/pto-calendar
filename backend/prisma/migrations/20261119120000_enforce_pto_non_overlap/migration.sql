-- #257: the database itself keeps one owner's PTO ranges apart.
--
-- The friendly preflight in the application is not an integrity mechanism:
-- two concurrent writers can both pass it. This constraint is the last line
-- of defence, so an overlapping range for the same owner can never be stored,
-- no matter which client, session or personal token wrote it.
--
-- The ranges are inclusive ('[]'), so two entries of one owner that share a
-- day overlap, including two half-day entries on the same day. Distinct owners
-- never overlap, because the owner is part of the constraint.
--
-- The migration is additive and non-destructive: it creates no row, changes no
-- row and deletes nothing. It fails closed: when the extension cannot be
-- created, or when the stored data already violates the rule, the whole
-- transaction is rolled back and the operator is told what to do.
--
-- Keep the lock, preflight and DDL in a single transaction.
BEGIN;
SET LOCAL search_path = pg_catalog, public, pg_temp;
SET LOCAL lock_timeout = '5s';

-- btree_gist is a trusted PostgreSQL contribution extension. It provides the
-- GiST operator class for the UUID equality that the owner part of the
-- constraint needs. It is created only when it is missing, and a missing
-- privilege fails the migration with an actionable message instead of
-- silently skipping the guard.
DO $extension$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_extension AS e
    JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace
    WHERE e.extname = 'btree_gist' AND n.nspname <> 'public'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'The PTO non-overlap guard requires btree_gist in the public schema for backup and restore. No data was changed. Ask the database administrator to review the extension placement before retrying.',
      ERRCODE = 'object_not_in_prerequisite_state';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist') THEN
    BEGIN
      CREATE EXTENSION btree_gist WITH SCHEMA public;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION USING
          MESSAGE = 'The PTO non-overlap guard needs the trusted btree_gist extension, which this role may not create. No data was changed. Ask an administrator to install btree_gist in public or to run this migration with a role that has the required CREATE privilege.',
          ERRCODE = 'insufficient_privilege';
      WHEN feature_not_supported THEN
        RAISE EXCEPTION USING
          MESSAGE = 'The PTO non-overlap guard needs the trusted btree_gist extension. No data was changed. Verify that the approved PostgreSQL image provides the extension before retrying.',
          ERRCODE = 'feature_not_supported';
    END;
  END IF;
END
$extension$;

-- The preflight and the constraint must see the same rows. The lock is taken
-- on the same table the constraint is added to and is held until the
-- transaction ends, so a concurrent writer cannot insert an overlapping row
-- between the count and the constraint.
LOCK TABLE "public"."pto_requests" IN ACCESS EXCLUSIVE MODE;

DO $migration$
DECLARE
  invalid_ranges bigint;
  overlapping bigint;
BEGIN
  -- A range that ends before it starts cannot be expressed as a daterange.
  SELECT count(*) INTO invalid_ranges
  FROM "public"."pto_requests"
  WHERE "end_date" < "start_date";

  -- The running maximum end date of the preceding entries of the same owner.
  -- An entry overlaps the previous ones when it starts on or before that
  -- maximum, because the ranges are inclusive.
  SELECT count(*) INTO overlapping
  FROM (
    SELECT "start_date",
           max("end_date") OVER (
             PARTITION BY "user_id"
             ORDER BY "start_date", "end_date"
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ) AS "previous_max_end"
    FROM "public"."pto_requests"
  ) AS "running"
  WHERE "previous_max_end" IS NOT NULL
    AND "start_date" <= "previous_max_end";

  IF invalid_ranges > 0 OR overlapping > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'The PTO non-overlap guard was not installed: %s stored entry/entries end before they start and %s stored entry/entries overlap another entry of the same owner. No data was changed and no entry was listed. Resolve these entries with the data steward, then run this migration again.',
        invalid_ranges,
        overlapping
      ),
      ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$migration$;

-- The guard itself. The name is fixed, so the application can recognize this
-- one violation and answer it with the same conflict as the preflight.
ALTER TABLE "public"."pto_requests"
  ADD CONSTRAINT "pto_requests_no_owner_overlap"
  EXCLUDE USING gist (
    "user_id" WITH =,
    pg_catalog.daterange("start_date", "end_date", '[]') WITH &&
  );

COMMIT;
