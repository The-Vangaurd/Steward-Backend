import { Request } from 'express';
import { UserRole } from '@prisma/client';

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  restaurantId: string | null;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  restaurantId: string | null;
  iat?: number;
  exp?: number;
}

// ─── API Response ─────────────────────────────────────────────────────────────

export type ApiResponse<T = unknown> =
  | {
      success: true;
      data?: T;
      meta?: PaginationMeta;
    }
  | {
      success: false;
      error: ApiErrorPayload;
    };

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
}

// ─── Health ───────────────────────────────────────────────────────────────────

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  timestamp: string;
  environment: string;
  services: {
    database: boolean;
    redis: boolean | 'disabled';
  };
}