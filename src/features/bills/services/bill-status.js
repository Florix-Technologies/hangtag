// A bill's state, read from what the shop already keeps (no records of its own): cancelled, still owed (per bill: payments
// collected later pay a customer's oldest bills first — domain/customers/credit.js billBalances), sold on credit, returned
// (credit notes), its e-invoice, and its receipt sent to the customer. Used by the Bills workspace and the bill view.
import { store } from '../../../shared/state/store.js';
import { dueAmtOf } from '../../../domain/sales/payments.js';
import { einvoiceApplies } from '../../../domain/gst/einvoice.js';
import { D } from '../../inventory/services/ledger.js';
import { openBillBalances } from '../../customers/services/customer-account.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { usesEinvoice } from '../../commerce/use-cases/gst-documents.js';
import { autoJobs } from '../../delivery/use-cases/auto-delivery.js';
import { deliveriesOf } from '../../delivery/use-cases/send-invoice.js';

/* The e-invoice of a bill, as a short state: "" (doesn't need one), needs / ready / pending / generated / failed / cancelled.
   (The full check with what is missing is the bill's E-Invoice sheet: commerce/components/gst-documents.js) */
export function einvoiceStateOf(s){
  if(!s || !usesEinvoice()) return "";
  const rec = bizRepository().get("ei", s.id);
  if(rec && ["pending", "generated", "failed", "cancelled", "ready"].includes(rec.status)) return rec.status;
  return einvoiceApplies(s, store.settings) ? "needs" : "";
}
export const EINVOICE_LABELS = { needs: ["E-invoice to prepare", "warn"], ready: ["E-invoice ready", "info"], pending: ["E-invoice waiting to send", "info"],
  generated: ["E-invoice generated", "ok"], failed: ["E-invoice failed", "bad"], cancelled: ["E-invoice cancelled", "muted"] };

/* The receipt sent to the customer (by this device's automatic sends, and every send the server reported):
   "" (none), "sent", "sending" or "failed" */
export function deliveryStateOf(sid){
  const all = [...autoJobs(sid), ...deliveriesOf(sid)].map(x => x.status);
  if(all.some(x => x === "sent" || x === "delivered" || x === "read")) return "sent";
  if(all.some(x => x === "queued" || x === "sending")) return "sending";
  if(all.some(x => x === "failed" || x === "refused" || x === "undelivered")) return "failed";
  return "";
}
export const DELIVERY_LABELS = { sent: ["Receipt sent", "ok"], sending: ["Sending receipt", "info"], failed: ["Receipt not delivered", "bad"] };

/* What every bill needs to show its state, worked out once for a list: { owed: { [bill id]: rupees } } */
export const billContext = () => ({ owed: openBillBalances() });
/* A bill's state → { key, label, tone, owed } (key: cancelled / unpaid / paid) and what else is true of it */
export function billState(s, ctx = billContext()){
  const rets = D().retBySale[s.id] || [], owed = (ctx.owed && ctx.owed[s.id]) || 0;
  const base = s.void ? { key: "cancelled", label: "Cancelled", tone: "bad" }
    : owed > 0 ? { key: "unpaid", label: "Unpaid", tone: "warn" } : { key: "paid", label: "Paid", tone: "ok" };
  return { ...base, owed, credit: !s.void && dueAmtOf(s) > 0, returned: rets.length > 0, exchanged: rets.some(r => r.kind === "exchange"),
    returnedValue: rets.reduce((n, r) => n + (+r.value || 0), 0), creditNotes: rets.map(r => r.no).filter(Boolean) };
}

/* The Bills workspace's filters (shown: only those the shop uses). test(bill, state, ctx) */
export const BILL_FILTERS = [
  { key: "all", label: "All bills", test: () => true },
  { key: "unpaid", label: "Unpaid", test: (s, st) => st.key === "unpaid" },
  { key: "credit", label: "Credit", test: (s, st) => st.credit },
  { key: "returns", label: "Returns / Credit notes", test: (s, st) => st.returned },
  { key: "cancelled", label: "Cancelled", test: (s, st) => st.key === "cancelled" },
  { key: "einvoice", label: "E-Invoice", shown: () => usesEinvoice(), test: s => !!einvoiceStateOf(s) },
  { key: "delivery", label: "Delivery", test: s => !!deliveryStateOf(s.id) },
];
export const billFilters = () => BILL_FILTERS.filter(f => !f.shown || f.shown());
