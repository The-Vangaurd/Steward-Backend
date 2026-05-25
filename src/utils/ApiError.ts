// ApiError.ts — add serviceUnavailable() to the existing class
// Only the new method and the class shell are shown; merge with existing file.
//
// ADD this static method to your existing ApiError class:
//
//   static serviceUnavailable(message: string, code?: string): ApiError {
//     return new ApiError(503, message, code ?? 'SERVICE_UNAVAILABLE');
//   }
//
// ─────────────────────────────────────────────────────────────────────────────
// Full replacement if you prefer to overwrite the file entirely:

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(statusCode: number, message: string, code = 'INTERNAL_ERROR', isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, code?: string): ApiError {
    return new ApiError(400, message, code ?? 'BAD_REQUEST');
  }

  static unauthorized(message: string, code?: string): ApiError {
    return new ApiError(401, message, code ?? 'UNAUTHORIZED');
  }

  static forbidden(message: string, code?: string): ApiError {
    return new ApiError(403, message, code ?? 'FORBIDDEN');
  }

  static notFound(message: string, code?: string): ApiError {
    return new ApiError(404, message, code ?? 'NOT_FOUND');
  }

  static conflict(message: string, code?: string): ApiError {
    return new ApiError(409, message, code ?? 'CONFLICT');
  }

  static unprocessable(message: string, code?: string): ApiError {
    return new ApiError(422, message, code ?? 'UNPROCESSABLE');
  }

  /** 503 — used when an optional external service (e.g. Cloudinary) is unconfigured */
  static serviceUnavailable(message: string, code?: string): ApiError {
    return new ApiError(503, message, code ?? 'SERVICE_UNAVAILABLE');
  }

  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(500, message, 'INTERNAL_ERROR', false);
  }
}
