-- CreateTable: restaurant_settings
-- Adds per-restaurant customisation and financial settings.
-- taxRate defaults to 0.05 (5%) to preserve backward compatibility with
-- the previously hardcoded TAX_RATE constant.

CREATE TABLE "restaurant_settings" (
    "id"             TEXT NOT NULL,
    "restaurantId"   TEXT NOT NULL,
    "taxRate"        DECIMAL(6,4) NOT NULL DEFAULT 0.05,
    "serviceCharge"  DECIMAL(6,4) NOT NULL DEFAULT 0.00,
    "primaryColor"   VARCHAR(20),
    "secondaryColor" VARCHAR(20),
    "accentColor"    VARCHAR(20),
    "fontHeading"    VARCHAR(100),
    "fontBody"       VARCHAR(100),
    "customCss"      TEXT,
    "openingHours"   JSONB,
    "offlineMode"    BOOLEAN NOT NULL DEFAULT false,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "restaurant_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_settings_restaurantId_key"
    ON "restaurant_settings"("restaurantId");

ALTER TABLE "restaurant_settings"
    ADD CONSTRAINT "restaurant_settings_restaurantId_fkey"
    FOREIGN KEY ("restaurantId")
    REFERENCES "restaurants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Back-fill default settings for all existing restaurants
INSERT INTO "restaurant_settings" ("id", "restaurantId", "updatedAt")
SELECT
    'seed_' || replace(gen_random_uuid()::text, '-', ''),
    "id",
    NOW()
FROM "restaurants";

-- Index on sessions.expiresAt for the expired-session cleanup cron
CREATE INDEX IF NOT EXISTS "sessions_expiresAt_idx" ON "sessions"("expiresAt");
