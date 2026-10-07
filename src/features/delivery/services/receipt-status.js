// Where a bill's receipt is — Queued, Sent, Delivered or Failed — from what this device queued to send by itself
// (use-cases/auto-delivery.js) and the server's record of every send (use-cases/send-invoice.js; "delivered" once the
// provider says so), merged by domain/invoices/delivery.js receiptStatus. Read-only: only what was recorded is shown.
import { receiptStatus } from '../../../domain/invoices/delivery.js';
import { autoJobs } from '../use-cases/auto-delivery.js';
import { deliveriesOf } from '../use-cases/send-invoice.js';

/* → { channels: [{ channel, state, to, error, at, wait? }], state: "" | queued | sent | delivered | failed } */
export const receiptStatusOf = sid => receiptStatus({ jobs: autoJobs(sid), history: deliveriesOf(sid) });
/* The chip that says it on a bill (nothing when no receipt was sent or queued) → [label, tone] | null */
export function receiptChip(st){
  const s = st && st.state;
  return s === "delivered" ? ["Receipt delivered", "ok"] : s === "sent" ? ["Receipt sent", "ok"] : s === "queued" ? ["Receipt queued", "info"] : s === "failed" ? ["Receipt not sent", "bad"] : null;
}
