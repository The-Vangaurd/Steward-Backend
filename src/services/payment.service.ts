import crypto from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { prisma } from '../config/database';

export const paymentService = {
  async createRazorpayOrder(stewardOrderId: string) {
    // Fetch the order to get the amount
    const order = await prisma.order.findUnique({ where: { id: stewardOrderId } });
    if (!order) throw ApiError.notFound('Order not found');

    const amountPaise = Math.round(Number(order.totalAmount) * 100);

    const body = JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      receipt: stewardOrderId,
    });

    const auth = Buffer.from(
      `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`
    ).toString('base64');

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body,
    });

    if (!response.ok) {
      throw ApiError.internal('Payment gateway error');
    }

    const rzpOrder = await response.json() as { id: string };
    return {
      razorpayOrderId: rzpOrder.id,
      amount: amountPaise,
      currency: 'INR',
      keyId: env.RAZORPAY_KEY_ID,
    };
  },

  async verifyPayment(data: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
    stewardOrderId: string;
  }) {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, stewardOrderId } = data;

    const expectedSig = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET ?? '')
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (expectedSig !== razorpaySignature) {
      throw ApiError.badRequest('Invalid payment signature', 'PAYMENT_INVALID_SIG');
    }

    await prisma.order.update({
      where: { id: stewardOrderId },
      data: {
        paymentStatus: 'paid',
        razorpayOrderId,
        razorpayPaymentId,
      },
    });

    return { success: true };
  },
};
