-- Safe Migration Data Backfill: Populate new status values and timestamps

-- 1. Data Migration: Backfill new columns using legacy column values
UPDATE "orders"
SET "startedPreparingAt" = "preparedAt"
WHERE "preparedAt" IS NOT NULL AND "startedPreparingAt" IS NULL;

UPDATE "orders"
SET "completedAt" = "deliveredAt"
WHERE "deliveredAt" IS NOT NULL AND "completedAt" IS NULL;

-- 2. Data Migration: Map legacy statuses to new statuses
UPDATE "orders"
SET "status" = 'NEW'
WHERE "status" IN ('PENDING', 'CONFIRMED');

UPDATE "orders"
SET "status" = 'COMPLETED'
WHERE "status" = 'DELIVERED';
