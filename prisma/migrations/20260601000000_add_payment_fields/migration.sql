-- Add payment fields to Order table
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT NOT NULL DEFAULT 'cash';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "razorpayOrderId" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "razorpayPaymentId" TEXT;
