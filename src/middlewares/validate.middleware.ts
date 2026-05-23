import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ApiError } from '../utils/ApiError';
import { ERROR_CODES } from '../constants';

type ValidationTarget = 'body' | 'query' | 'params';

export const validate =
  (schema: ZodSchema, target: ValidationTarget = 'body') =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const details = (result.error as ZodError).flatten().fieldErrors;
      throw ApiError.badRequest(
        'Validation failed',
        ERROR_CODES.VALIDATION_ERROR,
        details,
      );
    }

    req[target] = result.data;
    next();
  };