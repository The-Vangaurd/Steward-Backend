-- Safe Clean-up Migration: Remove deprecated columns and clean up legacy enum values with default constraint and history handling.

-- 1. Data Migration: Map legacy statuses in order_status_history to the new ones
UPDATE "order_status_history"
SET "status" = 'NEW'
WHERE "status" IN ('PENDING', 'CONFIRMED');

UPDATE "order_status_history"
SET "status" = 'COMPLETED'
WHERE "status" = 'DELIVERED';

-- 2. Rename old enum type
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";

-- 3. Create new enum type with only active/archived statuses
CREATE TYPE "OrderStatus" AS ENUM ('PREPARING', 'READY', 'CANCELLED', 'NEW', 'COMPLETED');

-- 4. Drop the default value constraint from status column
ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;

-- 5. Update orders table status column to use the new enum type
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus" USING "status"::text::"OrderStatus";

-- 6. Set the new default value constraint 'NEW'
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'NEW'::"OrderStatus";

-- 7. Update order status history table to use the new enum type
ALTER TABLE "order_status_history" ALTER COLUMN "status" TYPE "OrderStatus" USING "status"::text::"OrderStatus";

-- 8. Drop the old enum type
DROP TYPE "OrderStatus_old";

-- 9. Drop the deprecated columns
ALTER TABLE "orders" DROP COLUMN IF EXISTS "confirmedAt";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "preparedAt";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "deliveredAt";
