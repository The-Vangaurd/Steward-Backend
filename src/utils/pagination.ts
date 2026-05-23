import { PaginationMeta } from '../types';

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export const parsePagination = (
  pageRaw?: unknown,
  limitRaw?: unknown,
): PaginationParams => {
  const page = Math.max(1, parseInt(String(pageRaw ?? 1), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(limitRaw ?? 20), 10) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

export const buildPaginationMeta = (
  total: number,
  page: number,
  limit: number,
): PaginationMeta => {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
};