import { prisma } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';

export const auditService = {
  async listAuditLogs(
    restaurantId: string,
    filters: {
      action?: string;
      resourceType?: string;
      from?: string;
      to?: string;
      page?: unknown;
      limit?: unknown;
    }
  ) {
    const pagination = parsePagination(filters.page, filters.limit);
    const where: any = { restaurantId };

    if (filters.action) {
      where.action = filters.action;
    }
    if (filters.resourceType) {
      where.resourceType = filters.resourceType;
    }
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) {
        where.createdAt.gte = new Date(filters.from);
      }
      if (filters.to) {
        where.createdAt.lte = new Date(filters.to);
      }
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      logs,
      meta: buildPaginationMeta(total, pagination.page, pagination.limit),
    };
  },

  async getFilters(restaurantId: string) {
    // Return lists of unique actions and resourceTypes for filters
    const [actionsRaw, resourceTypesRaw] = await Promise.all([
      prisma.auditLog.findMany({
        where: { restaurantId },
        select: { action: true },
        distinct: ['action'],
      }),
      prisma.auditLog.findMany({
        where: { restaurantId },
        select: { resourceType: true },
        distinct: ['resourceType'],
      }),
    ]);

    return {
      actions: actionsRaw.map((a) => a.action),
      resourceTypes: resourceTypesRaw.map((r) => r.resourceType),
    };
  },

  async createAuditLog(data: {
    restaurantId: string;
    actorId?: string;
    actorEmail?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return prisma.auditLog.create({
      data: {
        restaurantId: data.restaurantId,
        actorId: data.actorId,
        actorEmail: data.actorEmail,
        action: data.action,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        metadata: data.metadata || {},
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      },
    });
  },
};
