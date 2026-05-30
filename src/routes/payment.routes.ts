import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { ApiError } from '../utils/ApiError';
import { paymentService } from '../services/payment.service';

const router = Router();

// POST /v1/payment/create-order
router.post(
  '/create-order',
  asyncHandler(async (req: Request, res: Response) => {
    const { stewardOrderId } = req.body;
    if (!stewardOrderId) {
      throw ApiError.badRequest('stewardOrderId is required', 'VALIDATION_ERROR');
    }
    const result = await paymentService.createRazorpayOrder(stewardOrderId);
    sendSuccess(res, 200, result);
  })
);

// POST /v1/payment/verify
router.post(
  '/verify',
  asyncHandler(async (req: Request, res: Response) => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, stewardOrderId } = req.body;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !stewardOrderId) {
      throw ApiError.badRequest(
        'razorpayOrderId, razorpayPaymentId, razorpaySignature, and stewardOrderId are all required',
        'VALIDATION_ERROR'
      );
    }
    const result = await paymentService.verifyPayment({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      stewardOrderId,
    });
    sendSuccess(res, 200, result);
  })
);

export default router;
