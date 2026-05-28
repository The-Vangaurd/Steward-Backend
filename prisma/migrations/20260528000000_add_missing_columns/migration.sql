-- AlterTable: add staffPin to users (nullable, for kitchen staff / waiter PIN login)
ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "staffPin" TEXT;

-- AlterTable: add restaurantCode to restaurants (unique 6-char code for staff login)
ALTER TABLE "restaurants"
ADD COLUMN IF NOT EXISTS "restaurantCode" VARCHAR(20);

-- Back-fill existing restaurants with a unique code so NOT NULL can be applied
-- Uses first 6 chars of id (already unique cuid)
UPDATE "restaurants"
SET "restaurantCode" = UPPER(SUBSTRING("id", 1, 6))
WHERE "restaurantCode" IS NULL;

-- Now enforce uniqueness (but keep nullable for safety during migration)
CREATE UNIQUE INDEX IF NOT EXISTS "restaurants_restaurantCode_key"
ON "restaurants"("restaurantCode");