-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'admin';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "setup_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "setup_token_hash" VARCHAR(64),
ALTER COLUMN "password_hash" DROP NOT NULL;
