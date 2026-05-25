import { OrderStatus } from '@prisma/client';

/**
 * Forward transitions only.
 * DELIVERED and CANCELLED are terminal — no transitions out of them.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]:   [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY,     OrderStatus.CANCELLED],
  [OrderStatus.READY]:     [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

/**
 * Reverse / undo transitions supported by the kitchen undo feature.
 *
 * Design constraints:
 *  - Only one step back is allowed at a time (no multi-hop rollback).
 *  - PENDING cannot be rolled back (it's the initial state).
 *  - DELIVERED and CANCELLED are terminal — rolling them back is not
 *    supported because:
 *      a) DELIVERED may have triggered downstream billing/loyalty events.
 *      b) CANCELLED may have released stock or notified the customer.
 *    Operators must create a new order in these cases.
 *
 * If you need to support undo from DELIVERED/CANCELLED in the future,
 * add a compensation event log rather than reversing the state directly.
 */
export const ORDER_STATUS_UNDO_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus>> = {
  [OrderStatus.CONFIRMED]: OrderStatus.PENDING,
  [OrderStatus.PREPARING]: OrderStatus.CONFIRMED,
  [OrderStatus.READY]:     OrderStatus.PREPARING,
  // DELIVERED → undo NOT supported (terminal, may have external side-effects)
  // CANCELLED → undo NOT supported (terminal, may have external side-effects)
  // PENDING   → undo NOT supported (initial state, nothing to roll back to)
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

/**
 * Returns the previous status for a kitchen undo, or null if undo is
 * not permitted from the given state.
 */
export function getUndoStatus(currentStatus: OrderStatus): OrderStatus | null {
  return ORDER_STATUS_UNDO_TRANSITIONS[currentStatus] ?? null;
}

/**
 * Validates whether an undo transition is legal.
 * Throws a descriptive error message string (caller wraps in ApiError).
 */
export function validateUndoTransition(currentStatus: OrderStatus): OrderStatus {
  const prev = getUndoStatus(currentStatus);

  if (!prev) {
    const reason =
      currentStatus === OrderStatus.DELIVERED
        ? 'DELIVERED orders cannot be undone — downstream billing events may have fired. Create a new order instead.'
        : currentStatus === OrderStatus.CANCELLED
        ? 'CANCELLED orders cannot be undone — the customer may have been notified. Create a new order instead.'
        : currentStatus === OrderStatus.PENDING
        ? 'PENDING is the initial state; there is nothing to undo.'
        : `Undo is not supported for status ${currentStatus}.`;

    throw new Error(reason);
  }

  return prev;
}
