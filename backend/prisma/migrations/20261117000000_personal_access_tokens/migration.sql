-- Token rows are retained; deleting an owner requires an explicit retention policy.
CREATE TABLE "personal_access_tokens" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "display_prefix" VARCHAR(44) NOT NULL,
    "secret_digest" CHAR(64) NOT NULL,
    "scopes" VARCHAR(32)[] NOT NULL,
    "issued_session_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pat_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "pat_prefix_check" CHECK ("display_prefix" = 'pto_pat_' || "id"::text),
    CONSTRAINT "pat_digest_check" CHECK ("secret_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "pat_version_check" CHECK ("issued_session_version" >= 0),
    CONSTRAINT "pat_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '365 days'),
    CONSTRAINT "pat_scopes_check" CHECK (
      cardinality("scopes") > 0
      AND array_position("scopes", NULL) IS NULL
      AND "scopes" <@ ARRAY['pto:read', 'pto:notes:read', 'pto:create', 'pto:update:self', 'pto:delete:self', 'pto:update:team', 'pto:delete:team']::varchar[]
      AND (NOT ('pto:notes:read' = ANY("scopes")) OR 'pto:read' = ANY("scopes"))
      AND cardinality(array_positions("scopes", 'pto:read')) <= 1
      AND cardinality(array_positions("scopes", 'pto:notes:read')) <= 1
      AND cardinality(array_positions("scopes", 'pto:create')) <= 1
      AND cardinality(array_positions("scopes", 'pto:update:self')) <= 1
      AND cardinality(array_positions("scopes", 'pto:delete:self')) <= 1
      AND cardinality(array_positions("scopes", 'pto:update:team')) <= 1
      AND cardinality(array_positions("scopes", 'pto:delete:team')) <= 1
    ),
    CONSTRAINT "personal_access_tokens_owner_id_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "personal_access_tokens_owner_id_created_at_idx"
  ON "personal_access_tokens"("owner_id", "created_at");
