import { Response } from 'express';
import { ApiResponse, PaginationMeta } from '../types';

export const sendSuccess = <T>(
  res: Response,
  statusCode: number,
  data?: T,
  meta?: PaginationMeta,
): void => {
  const payload: ApiResponse<T> = {
    success: true,
    ...(data !== undefined && { data }),
    ...(meta && { meta }),
  };
  res.status(statusCode).json(payload);
};

export const sendError = (
  res: Response,
  statusCode: number,
  message: string,
  code: string,
  details?: unknown,
): void => {
  const payload: ApiResponse = {
    success: false,
    error: { code, message, ...(details !== undefined && { details }) },
  };
  res.status(statusCode).json(payload);
};
