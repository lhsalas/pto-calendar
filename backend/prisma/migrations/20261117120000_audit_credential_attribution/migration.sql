-- Credential attribution for audit rows (#252). Additive and nullable only.
-- Existing rows keep NULL attribution: no backfill, rewrite, cascade or deletion
-- of historical records. The new columns are plain values with no foreign keys,
-- so audit history survives personal-token revocation and metadata cleanup.

-- AlterTable
ALTER TABLE "audit_logs"
    ADD COLUMN "credential_type" VARCHAR(32),
    ADD COLUMN "source_token_id" UUID,
    ADD COLUMN "target_owner_id" UUID,
    ADD COLUMN "request_id" VARCHAR(200);

-- Constraints: closed credential vocabulary, a source token only for personal-token
-- credentials, and safe request IDs that can never carry a raw personal token.
ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_credential_type_check"
        CHECK ("credential_type" IS NULL OR "credential_type" IN ('session', 'personal_access_token', 'setup_token', 'operator')),
    ADD CONSTRAINT "audit_logs_source_token_check"
        CHECK ("source_token_id" IS NULL OR "credential_type" IS NOT DISTINCT FROM 'personal_access_token'),
    ADD CONSTRAINT "audit_logs_request_id_check"
        CHECK ("request_id" IS NULL OR ("request_id" ~ '^[A-Za-z0-9._-]{1,200}$' AND "request_id" !~* 'pto_pat_'));
