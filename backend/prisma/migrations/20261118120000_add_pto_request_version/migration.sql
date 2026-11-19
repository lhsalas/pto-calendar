-- Additive and non-destructive: existing PTO entries keep their dates, notes
-- and day parts and start their version history at 1.
ALTER TABLE "pto_requests" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
