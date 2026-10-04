// Gift vouchers (domain/sales/vouchers.js): issue one (₹ amount, customer optional) — the database makes the secure code —
// and spend it on the payment screen as a way to pay. Issuing and spending happen online: the database locks the voucher
// so two tills can't spend the same balance, and a code works only at its own shop. Selling needs create_sale; cancelling
// an unused voucher manage_settings (the database checks both, and that vouchers are switched on).
import { VOUCHER, checkIssue, normCode, redeemable, voucherState } from '../../../domain/sales/vouchers.js';
import { paymentId } from '../../../domain/sales/payments.js';
import { toPaise, toRupees } from '../../../domain/sales/paise.js';
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { saveCashMoves } from '../../../shared/state/persistence.js';
import { denied } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { bizRepository } from '../repositories/biz-repository.js';

const online = () => !!store.sbClient && store.sbStatus === "connected";
const OFFLINE = { error: "Gift vouchers need the internet (the balance is checked in the cloud). Connect, then try again." };
const off = () => hasCap("uses_vouchers") ? null : { error: "Gift vouchers are switched off for this shop. Switch them on in Settings → Business → Features." };
export const usesVouchers = () => hasCap("uses_vouchers");
export const voucherList = () => bizRepository().list("gv").slice().sort((a, b) => b.t - a.t);
export const voucherStatus = v => voucherState(v, dayKey(Date.now()));
const fail = e => ({ error: e && e.message ? e.message : "The voucher couldn't be checked. Try again." });

/* x: { amount, expires, custId, method (how the customer paid for it), note } → { voucher } (with its code, to print) or { error, field } */
export async function issueVoucher(x){
  const no = denied("create_sale", "sell gift vouchers") || off(); if(no) return no;
  const bad = checkIssue(x || {}, dayKey(Date.now())); if(bad) return bad;
  if(!online()) return OFFLINE;
  try{
    const v = await use("cloud").issueVoucher({ amount: +x.amount, expires_on: x.expires || null, customer_id: x.custId || null, paid_method: x.method, note: x.note || null, device_id: store.dev, t: Date.now() });
    bizRepository().keep("gv", v);
    // cash paid for it is in the drawer now: the database added the cash book entry; this device shows the same one
    if(v.method === "cash"){ store.cashMoves = store.cashMoves || {}; store.cashMoves["gv:" + v.id] = { id: "gv:" + v.id, type: "in", amount: v.amount, reason: "Gift voucher sold GV-····-····-" + v.code.slice(-4), t: v.t, dev: store.dev }; saveCashMoves(); }
    return { voucher: v };
  }catch(e){ return fail(e); }
}
/* The bill on the payment screen pays (part of) itself with a voucher: the amount is taken off the voucher now, for this
   bill's voucher payment (the same press again changes nothing). due: what is still to pay without the voucher
   → { voucher: { id, code, amount, balance, redemption } } or { error } */
export async function useVoucher(rawCode, due, saleId){
  const no = denied("create_sale", "take payments") || off(); if(no) return no;
  const code = normCode(rawCode); if(!code) return { error: "That isn't a voucher code. It looks like GV-XXXX-XXXX-XXXX." };
  if(!online()) return OFFLINE;
  try{
    const cloud = use("cloud"), look = await cloud.voucherLookup(code);
    if(!look || !look.ok) return { error: look && look.message || "That voucher code wasn't found at this shop." };
    const can = redeemable({ balance: look.balance, status: look.status, expires: look.expires_on ? String(look.expires_on).slice(0, 10) : "" }, due, dayKey(Date.now()));
    if(can.error) return can;
    const r = await cloud.redeemVoucher(code, can.amount, saleId, paymentId(saleId, VOUCHER), Date.now());
    if(!r || !r.ok) return { error: r && r.message || "The voucher couldn't be used." };
    return { voucher: { id: r.id, code, amount: toRupees(toPaise(r.amount)), balance: +r.balance, redemption: r.redemption } };
  }catch(e){ return fail(e); }
}
/* The voucher came off a bill that wasn't completed: its amount goes back on it */
export async function releaseVoucher(saleId){
  if(!online()) return { error: "Offline: the voucher's amount goes back once the bill's payment is released online." };
  try{ return await use("cloud").releaseVoucher(paymentId(saleId, VOUCHER)); }catch(e){ return fail(e); }
}
export async function cancelVoucher(id, reason){
  const no = denied("manage_settings", "cancel gift vouchers"); if(no) return no;
  if(!online()) return OFFLINE;
  try{
    const r = await use("cloud").cancelVoucher(id, String(reason || "").trim());
    const v = bizRepository().get("gv", id); if(v) bizRepository().keep("gv", { ...v, status: "cancelled", cancelReason: String(reason || "").trim() });
    return r;
  }catch(e){ return fail(e); }
}
/* What happened to a voucher: spent on which bills, given back */
export async function voucherHistory(id){
  if(!online()) return { error: OFFLINE.error };
  try{ return { history: await use("cloud").voucherHistory(id) }; }catch(e){ return fail(e); }
}
/* The vouchers of the shop, from the cloud */
export async function refreshVouchers(){
  if(!online()) return { error: OFFLINE.error };
  try{ const got = await use("cloud").fetchBiz(); if(Array.isArray(got.gv)) bizRepository().replace("gv", Object.fromEntries(got.gv.map(v => [v.id, v]))); return { ok: true }; }catch(e){ return fail(e); }
}
