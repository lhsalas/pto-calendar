-- #258: the claim of one create key for one owner and credential.
--
-- The row holds a digest of the client key, a keyed fingerprint of the
-- payload and the note-free result of the create. The key itself is never
-- stored, and the payload fingerprint is keyed, so the stored row cannot
-- reveal the note.
--
-- The table references no PTO entry and no personal token on purpose: a
-- deleted entry or a revoked credential must not erase or alter a result
-- that was already handed out. The owner is stored as a plain value for the
-- same reason, so no lock order or row drift follows from a foreign key.
--
-- The claim is unique per owner, credential kind, credential id and key
-- digest, so two concurrent writers with one key cannot both create.
CREATE TABLE "pto_create_replays" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "credential_kind" VARCHAR(16) NOT NULL,
    "credential_id" UUID NOT NULL,
    "key_digest" CHAR(64) NOT NULL,
    "payload_fingerprint" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pto_create_replays_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pto_create_replays_kind_check" CHECK ("credential_kind" IN ('pat', 'session')),
    CONSTRAINT "pto_create_replays_digest_check" CHECK ("key_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "pto_create_replays_fingerprint_check" CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "pto_create_replays_scope_key" ON "pto_create_replays"("owner_id", "credential_kind", "credential_id", "key_digest");

-- The cleanup of expired rows reads this index in expiry order.
CREATE INDEX "pto_create_replays_expires_at_idx" ON "pto_create_replays"("expires_at");
