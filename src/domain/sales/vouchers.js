// Digital gift vouchers: a customer pays ₹X now and spends it later, all at once or in parts. A voucher is a way to PAY
// (a tender on the payment screen), never a discount: the bill keeps its full price and GST, and the voucher part is one
// of its payments. Money came in when the voucher was sold.
// The code (GV-XXXX-XXXX-XXXX) is made from 60 random bits and printed as a QR; it works only at the shop that issued it.
// Spending is checked by the database while online: the voucher row is locked, its balance can't go below 0 and the same
// payment is never taken twice (supabase/schema.sql section 3r) — so two tills can't spend the same balance.
//   active → fully_redeemed (balance 0) · expired (past its last day) · cancelled (with a reason; never after a part was spent)
// Not loyalty points. Pure.
import { toPaise, toRupees, tooPrecise } from './paise.js';
import { inr } from '../../shared/formatting/money.js';

export const VOUCHER = "voucher";
export const VOUCHER_STATUSES = ["active", "fully_redeemed", "expired", "cancelled"];
export const VOUCHER_LABELS = { active: "Active", fully_redeemed: "Fully used", expired: "Expired", cancelled: "Cancelled" };
export const MAX_VOUCHER = 100000;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";   // no 0/O, 1/I: easy to read out and type
const CODE_RE = /^GV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
/* A new code from 12 random bytes (crypto.getRandomValues on the phone; the database checks it is unused) */
export function voucherCode(bytes){
  const b = Array.from(bytes || []);
  if(b.length < 12) throw new Error("A voucher code needs 12 random bytes.");
  const chars = b.slice(0, 12).map(x => ALPHABET[x % 32]).join("");
  return `GV-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
/* A code as typed or scanned ("gv 7k2m-…", a QR's text) → "GV-XXXX-XXXX-XXXX", or "" when it can't be one */
export function normCode(input){
  const raw = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^GV/, "").replace(/O/g, "0");
  if(raw.length !== 12) return "";
  const c = `GV-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  return CODE_RE.test(c) ? c : "";
}
export const codeOk = c => CODE_RE.test(String(c || ""));
/* Issuing: { amount, expires ("yyyy-mm-dd" | ""), method (how the customer paid for it) } · today: "yyyy-mm-dd" → { error, field } or null */
export function checkIssue(x, today){
  const a = +(x && x.amount);
  if(!(Number.isFinite(a) && a > 0)) return { error: "Enter the voucher amount.", field: "amount" };
  if(tooPrecise(a)) return { error: "Use at most 2 decimal places.", field: "amount" };
  if(a > MAX_VOUCHER) return { error: `A voucher can be up to ${inr(MAX_VOUCHER)}.`, field: "amount" };
  if(x.expires && !/^\d{4}-\d{2}-\d{2}$/.test(x.expires)) return { error: "Enter the last day as a date.", field: "expires" };
  if(x.expires && today && x.expires < today) return { error: "The last day is already past.", field: "expires" };
  if(!["cash", "upi", "card"].includes(x.method)) return { error: "How did the customer pay for the voucher?", field: "method" };
  return null;
}
/* The status a voucher shows today */
export function voucherState(v, today){
  if(!v) return "cancelled";
  if(v.status === "cancelled" || v.status === "fully_redeemed") return v.status;
  if(toPaise(v.balance) <= 0) return "fully_redeemed";
  if(v.expires && today && v.expires < today) return "expired";
  return "active";
}
/* Can this much of it pay a bill now? due: what is still to pay on the bill → { error } or { amount } (the most it can pay) */
export function redeemable(v, due, today){
  const st = voucherState(v, today);
  if(st === "expired") return { error: `This voucher expired on ${v.expires}.` };
  if(st === "fully_redeemed") return { error: "This voucher is fully used." };
  if(st === "cancelled") return { error: "This voucher was cancelled." };
  const d = toPaise(due);
  if(!(d > 0)) return { error: "Nothing is left to pay on this bill." };
  return { amount: toRupees(Math.min(toPaise(v.balance), d)) };
}
/* A voucher part of a payment as the payment screen keeps it: { method: "voucher", amount, voucher: { id, code, redemption } }.
   It counts only once the database took the amount off the voucher (redemption = its id). → error text or null */
export function voucherPartError(a){
  if(!a || a.method !== VOUCHER) return null;
  if(!a.voucher || !a.voucher.id) return "Scan or type the voucher code.";
  if(!a.voucher.redemption) return "The voucher balance hasn't been taken yet. Tap Use voucher again while online.";
  if(toPaise(a.voucher.amount) !== toPaise(a.amount)) return "The voucher amount changed. Use the voucher again.";
  return null;
}
