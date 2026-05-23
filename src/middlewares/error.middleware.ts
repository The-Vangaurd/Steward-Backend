import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';
import { HTTP_STATUS } from '../constants';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  if (err instanceof ApiError) {
    if (!err.isOperational) {
      logger.error('Unexpected operational error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
      });
    }

    sendError(res, err.statusCode, err.message, err.code, err.details);
    return;
  }

  // Unknown / programming errors
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  sendError(
    res,
    HTTP_STATUS.INTERNAL_SERVER_ERROR,
    'Something went wrong',
    'INTERNAL_ERROR',
  );
};

export const notFoundHandler = (req: Request, res: Response): void => {
  sendError(
    res,
    HTTP_STATUS.NOT_FOUND,
    `Route ${req.method} ${req.path} not found`,
    'NOT_FOUND',
  );
};