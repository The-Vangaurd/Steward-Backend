import { OrderStatus } from '@prisma/client';

/**
 * Forward transitions only.
 * COMPLETED and CANCELLED are terminal — no transitions out of them.
 *
 * Lifecycle: NEW → PREPARING → READY → COMPLETED
 *            Any active state → CANCELLED
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.NEW]:       [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY,     OrderStatus.CANCELLED],
  [OrderStatus.READY]:     [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

/**
 * Reverse / undo transitions supported by the kitchen undo feature.
 *
 * Design constraints:
 *  - Only one step back is allowed at a time.
 *  - NEW cannot be rolled back (it's the initial state).
 *  - COMPLETED and CANCELLED are terminal — rolling them back is not supported.
 */
export const ORDER_STATUS_UNDO_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus>> = {
  [OrderStatus.PREPARING]: OrderStatus.NEW,
  [OrderStatus.READY]:     OrderStatus.PREPARING,
};

export function getAllowedOrderStatusTransitions(status: OrderStatus): OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[status] ?? [];
}

export function isValidOrderStatusTransition(
  currentStatus: OrderStatus,
  nextStatus: OrderStatus,
): boolean {
  return getAllowedOrderStatusTransitions(currentStatus).includes(nextStatus);
}

export function getUndoStatus(currentStatus: OrderStatus): OrderStatus | null {
  return ORDER_STATUS_UNDO_TRANSITIONS[currentStatus] ?? null;
}

export function validateUndoTransition(currentStatus: OrderStatus): OrderStatus {
  const prev = getUndoStatus(currentStatus);

  if (!prev) {
    const reason =
      currentStatus === OrderStatus.COMPLETED
        ? 'COMPLETED orders cannot be undone — downstream events may have fired. Create a new order instead.'
        : currentStatus === OrderStatus.CANCELLED
        ? 'CANCELLED orders cannot be undone — the customer may have been notified. Create a new order instead.'
        : currentStatus === OrderStatus.NEW
        ? 'NEW is the initial state; there is nothing to undo.'
        : `Undo is not supported for status ${currentStatus}.`;

    throw new Error(reason);
  }

  return prev;
}
