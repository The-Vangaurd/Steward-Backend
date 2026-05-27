import { HTTP_STATUS, ERROR_CODES } from '../constants';

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(
    statusCode: number,
    message: string,
    code: string,
    details?: unknown,
    isOperational = true,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, code: string = ERROR_CODES.VALIDATION_ERROR, details?: unknown): ApiError {
    return new ApiError(HTTP_STATUS.BAD_REQUEST, message, code, details);
  }

  static unauthorized(message = 'Unauthorized', code: string = ERROR_CODES.UNAUTHORIZED): ApiError {
    return new ApiError(HTTP_STATUS.UNAUTHORIZED, message, code);
  }

  static forbidden(message = 'Forbidden', code: string = ERROR_CODES.FORBIDDEN): ApiError {
    return new ApiError(HTTP_STATUS.FORBIDDEN, message, code);
  }

  static notFound(message = 'Resource not found', code: string = ERROR_CODES.NOT_FOUND): ApiError {
    return new ApiError(HTTP_STATUS.NOT_FOUND, message, code);
  }

  static conflict(message: string, code: string = ERROR_CODES.CONFLICT): ApiError {
    return new ApiError(HTTP_STATUS.CONFLICT, message, code);
  }

  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, message, ERROR_CODES.INTERNAL_ERROR, undefined, false);
  }

  static serviceUnavailable(message = 'Service unavailable'): ApiError {
    return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, message, ERROR_CODES.SERVICE_UNAVAILABLE);
  }
}
