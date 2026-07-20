-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "country_code" VARCHAR(2),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "holidays_date_idx" ON "holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_country_code_key" ON "holidays"("date", "country_code");

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
