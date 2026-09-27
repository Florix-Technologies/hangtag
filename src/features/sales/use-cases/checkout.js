// Checkout (complete a sale with its payments) and cancelling/restoring bills.
import { lineLabel } from '../../../domain/catalog/options.js';
import { checkBillDiscounts, normalizeDiscount } from '../../../domain/sales/discounts.js';
import { paymentId, settlePayments } from '../../../domain/sales/payments.js';
import { store } from '../../../shared/state/store.js';
import { billCustomer, billTotals, gstContext, invoiceNo } from '../services/totals.js';
import { D } from '../../inventory/services/ledger.js';
import { prod } from '../../products/services/catalog.js';
import { closeSheets } from '../components/bill-panel.js';
import { showPaid } from '../components/payment-done.js';
import { myOpenDocId } from '../services/sales-log.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { toast } from '../../../shared/components/toast.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { persistLocal, saveCart } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { uid } from '../../../shared/utils/ids.js';

/* A complete bill record, or { error } when a discount is too big or the payments don't settle it.
   lines: bill lines · billDisc: the bill discount · pay: a method ("cash" | "upi" | "card") for the whole amount due,
   or the parts [{ method, amount, received?, ref? }] · extra: { cust?, credit?, kind?, ex? } */
export function newSaleRecord(lines,billDisc,pay,extra){
  const x=extra||{}, cust=x.cust!==undefined?x.cust:store.cartCust, credit=x.credit||0;
  const bad=checkBillDiscounts(lines,billDisc); if(bad) return {error:bad.error,field:"discount",line:bad.line};
  const g=gstContext(cust), T=billTotals(lines,billDisc,cust), bc=billCustomer(cust);
  const due=Math.max(0,T.total-credit);
  const S=settlePayments(due,typeof pay==="string"?(due>0?[{method:pay,amount:due}]:[]):pay);
  if(S.error) return {error:S.error,field:S.field,method:S.method};
  const id=uid(), t=Date.now(), seq=D().sales.filter(s=>dayKey(s.t)===dayKey(t)).length+1;
  return {id,no:invoiceNo(t,seq),t,
    items:lines.map((c,k)=>{const L=T.lines[k], d=normalizeDiscount(c.disc), p=prod(c.p);
      return {ln:k,v:c.v,p:c.p,n:c.name,c:c.c||"",s:c.s||"",vl:lineLabel(c),ov:c.ov||[],sku:c.sku||"",q:c.q,price:c.price,cost:c.cost==null?null:c.cost,
        ...(d?{disc:d}:{}),dAmt:L.itemDisc,bdAmt:L.billDisc,gst:L.rate,hsn:p&&p.hsn||"",tx:L.taxable,cgst:L.cgst,sgst:L.sgst,igst:L.igst,lt:L.total}}),
    sub:T.sub,disc:T.disc,itemDisc:T.itemDisc,billDisc:normalizeDiscount(billDisc),billDiscAmt:T.billDisc,
    taxable:T.taxable,tax:T.tax,cgst:T.cgst,sgst:T.sgst,igst:T.igst,taxRate:T.rate||0,taxIncl:T.incl,
    gst:{mode:g.mode,pos:g.pos,shopState:g.shopState,b2b:g.b2b},roundOff:T.roundOff,total:T.total,credit,
    kind:x.kind||"sale",ex:x.ex||null,
    pay:S.payments.length>1?"split":S.payments.length?S.payments[0].method:(typeof pay==="string"?pay:"cash"),
    payments:S.payments.map(p=>({id:paymentId(id,p.method),...p})),dev:store.dev,
    cust:bc?{id:bc.id||null,name:bc.name,phone:bc.phone||"",...(bc.gstin?{gstin:bc.gstin}:{}),...(bc.type==="business"?{type:"business"}:{})}:null};
}
export function recordSale(sale){
  const id=myOpenDocId();
  store.localDays[id].sales.push(sale); store.dirty.add(id); persistLocal();
  // Queue for the cloud first, so the bill survives a closed tab or a dropped connection, then upload
  enqueue({ type:"sale", sale }); renderSync(); flushSbQueue();
}
/* Completes the sale on the bill. pay: a method for the whole amount, or the parts of a split payment.
   Returns the bill, { error } when the payments don't add up (nothing is saved), or null when there's nothing to do. */
export async function checkout(pay){
  if(!store.cart.length||Date.now()-store.lastCheckout<600)return null;
  const sale=newSaleRecord(store.cart,store.disc,pay);
  if(sale.error) return sale;
  store.lastCheckout=Date.now();
  store.cart=[]; store.disc=null; store.cartCust=null; store.payState=null; saveCart();
  store.lastSale=sale;
  recordSale(sale);
  closeSheets(); renderAll();
  showPaid(sale);
  return sale;
}
/* ---------- cancel a wrong bill (puts the stock back; its payments leave the cash and bank books) ---------- */

export async function voidSale(sid){
  const r=D().retBySale[sid];
  if(r&&r.length){ toast("This bill has a return or exchange, so it can't be cancelled."); return; }
  const id=myOpenDocId(),v=store.localDays[id].voids;
  if(!v.includes(sid))v.push(sid);
  store.dirty.add(id); persistLocal(); renderAll();
  toast("Bill cancelled — its stock is back on the shelf.");
  enqueue({ type: "void", id: sid, isVoid: true }); renderSync(); flushSbQueue();
}
export async function unvoid(sid){
  Object.keys(store.localDays).forEach(id=>{const v=store.localDays[id].voids||[],i=v.indexOf(sid);if(i>-1){v.splice(i,1);store.dirty.add(id)}});
  Object.keys(store.remoteDays).forEach(id=>{const v=store.remoteDays[id].voids||[],i=v.indexOf(sid);if(i>-1)v.splice(i,1)});
  persistLocal(); renderAll(); toast("Bill restored.");
  enqueue({ type: "void", id: sid, isVoid: false }); renderSync(); flushSbQueue();
}
