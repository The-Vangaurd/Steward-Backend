// ── SCHEMA CHANGE: OrderStatus enum refactored
// Old: PENDING | CONFIRMED | PREPARING | READY | DELIVERED | CANCELLED
// New: NEW      | PREPARING | READY     | COMPLETED | CANCELLED
//
// Migration notes:
//   PENDING   → NEW
//   CONFIRMED → NEW  (collapse: confirmed = already in kitchen queue)
//   DELIVERING→ (removed: not part of the simplified flow)
//   DELIVERED → COMPLETED
//   preparedAt renamed to startedPreparingAt
//   confirmedAt + deliveredAt removed
//
// Run: npx prisma migrate dev --name simplify_order_status

enum OrderStatus {
  NEW
  PREPARING
  READY
  COMPLETED
  CANCELLED
}
