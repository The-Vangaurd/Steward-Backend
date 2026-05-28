-- Safe Migration DDL: Add NEW and COMPLETED order statuses, and new timestamps.

-- 1. Alter OrderStatus enum to add NEW and COMPLETED
ALTER TYPE "OrderStatus" ADD VALUE 'NEW';
ALTER TYPE "OrderStatus" ADD VALUE 'COMPLETED';

-- 2. Add new columns to the orders table safely
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "startedPreparingAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
