// A bill's state, read from what the shop already keeps (no records of its own): cancelled, still owed (per bill: payments
// collected later pay a customer's oldest bills first — domain/customers/credit.js billBalances), sold on credit, returned
// (credit notes) and its e-invoice. Used by the Bills workspace and the bill view. (Whether a receipt reached the customer
// is delivery/services/receipt-status.js: this device's automatic sends and the server's record — never guessed.)
import { store } from '../../../shared/state/store.js';
import { dueAmtOf } from '../../../domain/sales/payments.js';
import { einvoiceApplies } from '../../../domain/gst/einvoice.js';
import { D } from '../../inventory/services/ledger.js';
import { openBillBalances } from '../../customers/services/customer-account.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { usesEinvoice } from '../../commerce/use-cases/gst-documents.js';
import { receiptChip, receiptStatusOf } from '../../delivery/services/receipt-status.js';

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

/* What every bill needs to show its state, worked out once for a list: { owed: { [bill id]: rupees } } */
export const billContext = () => ({ owed: openBillBalances() });
/* A bill's state → { key, label, tone, owed } (key: cancelled / unpaid / paid; owed: rupees still to collect on it) and what
   else is true of it: sold on credit, returned or exchanged (with the value and its credit note numbers) */
export function billState(s, ctx = billContext()){
  const rets = D().retBySale[s.id] || [], owed = s.void ? 0 : (ctx.owed && ctx.owed[s.id]) || 0;
  const base = s.void ? { key: "cancelled", label: "Cancelled", tone: "bad" }
    : owed > 0 ? { key: "unpaid", label: "Unpaid", tone: "warn" } : { key: "paid", label: "Paid", tone: "ok" };
  return { ...base, owed, credit: !s.void && dueAmtOf(s) > 0, returned: rets.length > 0, exchanged: rets.some(r => r.kind === "exchange"), receipt: receiptStatusOf(s.id),
    returnedValue: rets.reduce((n, r) => n + (+r.value || 0), 0), creditNotes: rets.map(r => r.no).filter(Boolean) };
}
/* The chips that say it: the state first (with what is owed), then credit (once settled), returned / exchanged, e-invoice */
export function billChips(s, st){
  const chips = [[st.key === "unpaid" ? "Unpaid" : st.label, st.tone]];
  if(st.credit && st.key === "paid") chips.push(["Credit · settled", "info"]);
  if(st.returned) chips.push([st.exchanged ? "Exchanged" : "Returned", "warn"]);
  const ei = einvoiceStateOf(s); if(ei) chips.push(EINVOICE_LABELS[ei]);
  const rc = !s.void && receiptChip(st.receipt); if(rc) chips.push(rc);
  return chips;
}

/* The Bills workspace's filters (shown: only those the shop uses). test(bill, state) */
export const BILL_FILTERS = [
  { key: "all", label: "All", test: () => true },
  { key: "paid", label: "Paid", test: (s, st) => st.key === "paid" },
  { key: "unpaid", label: "Unpaid", test: (s, st) => st.key === "unpaid" },
  { key: "credit", label: "Credit", test: (s, st) => st.credit },
  { key: "returns", label: "Returned", test: (s, st) => st.returned },
  { key: "cancelled", label: "Cancelled", test: (s, st) => st.key === "cancelled" },
  { key: "einvoice", label: "E-Invoice", shown: () => usesEinvoice(), test: s => !!einvoiceStateOf(s) },
  // receipts that reached nobody yet (failed, or still queued)
  { key: "unsent", label: "Receipts not sent", shown: () => receiptsInUse(), test: (s, st) => !s.void && !!st.receipt && (st.receipt.state === "failed" || st.receipt.state === "queued") },
];
export const billFilters = () => BILL_FILTERS.filter(f => !f.shown || f.shown());
/* Does this shop send receipts (automatically, or any were sent from this device or loaded)? */
const receiptsInUse = () => Object.values(store.settings && store.settings.autoSend || {}).some(Boolean) || (store.deliveryQueue || []).length > 0 || Object.keys(store.deliveries || {}).length > 0;
