-- Add guestId to orders
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "guestId" VARCHAR(100);
CREATE INDEX IF NOT EXISTS "orders_guestId_idx" ON "orders"("guestId");

-- Add shifts table
CREATE TABLE IF NOT EXISTS "shifts" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "name"         VARCHAR(100) NOT NULL,
  "dayOfWeek"    INTEGER NOT NULL,
  "startTime"    VARCHAR(5) NOT NULL,
  "endTime"      VARCHAR(5) NOT NULL,
  "isEnabled"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shifts_restaurantId_fkey" FOREIGN KEY ("restaurantId")
    REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "shifts_restaurantId_dayOfWeek_idx" ON "shifts"("restaurantId", "dayOfWeek");

-- Add audit_logs table
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "actorId"      TEXT,
  "actorEmail"   VARCHAR(255),
  "action"       VARCHAR(100) NOT NULL,
  "resourceType" VARCHAR(100) NOT NULL,
  "resourceId"   TEXT,
  "metadata"     JSONB,
  "ipAddress"    VARCHAR(45),
  "userAgent"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "audit_logs_restaurantId_createdAt_idx" ON "audit_logs"("restaurantId", "createdAt");
CREATE INDEX IF NOT EXISTS "audit_logs_restaurantId_action_idx"    ON "audit_logs"("restaurantId", "action");
CREATE INDEX IF NOT EXISTS "audit_logs_actorId_idx"                ON "audit_logs"("actorId");
