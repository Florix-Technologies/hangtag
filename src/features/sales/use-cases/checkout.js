// Checkout (complete a sale with its payments) and cancelling/restoring bills.
import { lineLabel } from '../../../domain/catalog/options.js';
import { checkBillDiscounts, normalizeDiscount } from '../../../domain/sales/discounts.js';
import { DUE, paymentId, settlePayments } from '../../../domain/sales/payments.js';
import { store } from '../../../shared/state/store.js';
import { billCustomer, billTotals, gstContext, nextBillNo, rateOf } from '../services/totals.js';
import { explodeKits } from '../../../domain/catalog/bundles.js';
import { D, invalidate } from '../../inventory/services/ledger.js';
import { prod } from '../../products/services/catalog.js';
import { closeSheets } from '../components/bill-panel.js';
import { showPaid } from '../components/payment-done.js';
import { myOpenDocId } from '../services/sales-log.js';
import { currentSelling, sellingEventId } from '../../events/services/selling-context.js';
import { STORE } from '../../../domain/events/event.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { queueAutoDelivery } from '../../delivery/use-cases/auto-delivery.js';
import { toast } from '../../../shared/components/toast.js';
import { persistLocal, saveCart, savePrefs } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { uid } from '../../../shared/utils/ids.js';
import { can, canAny, denied, notAllowedText, userId } from '../../shop/services/access.js';
import { CANCEL_BILL } from '../../../domain/shop/permissions.js';
import { fulfilFromSale } from '../../orders/use-cases/orders.js';
import { restoreSerialError, trackSaleLines } from '../../inventory/services/tracking.js';
import { closeTableForSale } from '../../restaurant/use-cases/tables.js';

/* A complete bill record, or { error } when a discount is too big or the payments don't settle it.
   lines: bill lines · billDisc: the bill discount · pay: a method ("cash" | "upi" | "card") or one part without its amount
   ({ method, ref?, via?, last4? }) for the whole amount due, or the parts [{ method, amount, received?, ref?, via?, last4?, intent? }]
   · extra: { id? (fixed when a provider payment was started for it), cust?, credit?, kind?, ex?, event? (default: what this device is selling at),
     order? (the quotation / sales order the bill delivers: its lines keep the order's line numbers) }
   One part may be { method: "due", amount }: left on the customer's account (only a saved customer), kept as dueAmt */
export function newSaleRecord(lines,billDisc,pay,extra){
  const x=extra||{}, cust=x.cust!==undefined?x.cust:store.cartCust, credit=x.credit||0;
  // a kit is saved as its items (each with its share of the kit price), so the stock ledger takes out the items
  const K=explodeKits(lines,rateOf); if(K.error) return {error:K.error,field:"kit",line:K.line};
  lines=K.lines;
  const bad=checkBillDiscounts(lines,billDisc); if(bad) return {error:bad.error,field:"discount",line:bad.line};
  // serial numbers (each piece named, ready to sell) and batches (taken first-to-expire, or the batch chosen for the line)
  const TK=trackSaleLines(lines); if(TK.error) return {error:TK.error,field:"tracking",line:TK.line};
  const g=gstContext(cust), T=billTotals(lines,billDisc,cust), bc=billCustomer(cust);
  const due=Math.max(0,T.total-credit);
  const whole=typeof pay==="string"?{method:pay}:pay&&!Array.isArray(pay)?pay:null;
  const S=settlePayments(due,whole?(due>0?[{...whole,amount:due}]:[]):pay,{customer:!!(cust&&cust.id&&store.customers[cust.id])});
  if(S.error) return {error:S.error,field:S.field,method:S.method};
  const id=x.id||uid(), t=Date.now(), ev=x.event!==undefined?x.event:sellingEventId();
  // this device's own series of numbers that day (domain/sales/sale.js), so two phones selling offline never make the same one
  return {id,no:nextBillNo(D().sales,t),t,
    items:lines.map((c,k)=>{const L=T.lines[k], d=normalizeDiscount(c.disc), p=prod(c.p);
      return {ln:k,v:c.v,p:c.p,n:c.name,c:c.c||"",s:c.s||"",vl:lineLabel(c),ov:c.ov||[],sku:c.sku||"",q:c.q,...(c.u?{u:c.u}:{}),price:c.price,cost:c.cost==null?null:c.cost,
        ...(d?{disc:d}:{}),...(x.order&&c.ord===x.order&&c.oln!=null?{ord:c.ord,oln:c.oln}:{}),...(c.kit&&!Array.isArray(c.kit)?{kit:c.kit}:{}),dAmt:L.itemDisc,bdAmt:L.billDisc,gst:L.rate,hsn:p&&p.hsn||"",tx:L.taxable,cgst:L.cgst,sgst:L.sgst,igst:L.igst,lt:L.total,...TK.items[k]}}),
    sub:T.sub,disc:T.disc,itemDisc:T.itemDisc,billDisc:normalizeDiscount(billDisc),billDiscAmt:T.billDisc,
    taxable:T.taxable,tax:T.tax,cgst:T.cgst,sgst:T.sgst,igst:T.igst,taxRate:T.rate||0,taxIncl:T.incl,
    gst:{mode:g.mode,pos:g.pos,shopState:g.shopState,b2b:g.b2b},roundOff:T.roundOff,total:T.total,credit,
    kind:x.kind||"sale",ex:x.ex||null,...(ev?{event:ev}:{}),...(S.onAccount>0?{dueAmt:S.onAccount}:{}),...(x.order?{order:x.order}:{}),
    ...(x.table?{table:x.table,session:x.session||null}:{}),
    pay:S.payments.length>1?"split":S.payments.length?S.payments[0].method:S.onAccount>0?"credit":(whole&&whole.method||"cash"),
    payments:S.payments.map(p=>({id:paymentId(id,p.method),...p})),dev:store.dev,...(userId()?{user:userId()}:{}),
    cust:bc?{id:bc.id||null,name:bc.name,phone:bc.phone||"",...(bc.gstin?{gstin:bc.gstin}:{}),...(bc.type==="business"?{type:"business"}:{})}:null};
}
export function recordSale(sale){
  const id=myOpenDocId();
  store.localDays[id].sales.push(sale); store.dirty.add(id); persistLocal(); invalidate();
  // Queue for the cloud first, so the bill survives a closed tab or a dropped connection, then upload
  enqueue({ type:"sale", sale }); renderSync(); flushSbQueue();
}
/* Completes the sale on the bill. pay: a method for the whole amount, or the parts of a split payment.
   opts: { id? (the bill id a provider payment was made for), send? (false: no automatic receipt for this sale) }
   Returns the bill, { error } when the payments don't add up (nothing is saved), or null when there's nothing to do. */
export async function checkout(pay,opts){
  if(!store.cart.length||Date.now()-store.lastCheckout<600)return null;
  const o=opts||{};
  // a team member sells only with create_sale, and gives discounts only with apply_discount (the database checks the sale)
  if(!can("create_sale")) return {error:notAllowedText("sell")};
  if(!can("apply_discount")&&(normalizeDiscount(store.disc)||store.cart.some(c=>normalizeDiscount(c.disc)))) return {error:notAllowedText("give discounts")+" Remove the discount first."};
  if(o.id&&D().saleById[o.id]) return {error:"This bill is already saved."};
  // leaving part of the bill on the customer's account needs collect_credit (the database checks it too)
  if(Array.isArray(pay)&&pay.some(a=>a&&a.method===DUE&&+a.amount>0)&&!can("collect_credit")) return {error:notAllowedText("sell on credit")};
  // a bill from a quotation / sales order: the order then counts what it delivered (create_order, as for saving it)
  const ord=store.cartOrder&&store.cartOrder.id&&store.cart.some(c=>c.ord===store.cartOrder.id)?store.cartOrder.id:null;
  if(ord&&!can("create_order")) return {error:notAllowedText("bill orders")};
  // a restaurant table's bill: paying it closes the table's session (the table is free again)
  const tbl=store.cartTable&&store.cartTable.table?store.cartTable:null;
  const sale=newSaleRecord(store.cart,store.disc,pay,Object.assign(o.id?{id:o.id}:{},ord?{order:ord}:{},tbl?{table:tbl.table,session:(tbl.sessions||[])[0]||null}:{}));
  if(sale.error) return sale;
  store.lastCheckout=Date.now();
  store.cart=[]; store.disc=null; store.cartCust=null; store.cartOrder=null; store.payState=null; saveCart();
  store.lastSale=sale;
  recordSale(sale);
  if(ord) fulfilFromSale(sale);
  if(tbl) closeTableForSale(sale,tbl);
  // the receipt goes out by itself on the channels the shop turned on (unless turned off for this sale)
  if(o.send!==false) queueAutoDelivery(sale);
  // a device still set to an event that was closed (or removed) sold this bill at the store: it now sells at the store
  if(currentSelling().notice){ store.prefs.event=STORE; savePrefs(); }
  closeSheets(); renderAll();
  showPaid(sale);
  return sale;
}
/* ---------- cancel a wrong bill (puts the stock back; its payments leave the cash and bank books) ---------- */

/* The bill as kept in its day (D() hands out copies) */
const keptSale=sid=>{for(const d of [...Object.values(store.localDays),...Object.values(store.remoteDays)]){const s=(d.sales||[]).find(x=>x.id===sid);if(s)return s}return null};
export const VOID_REASONS=["Wrong items or price","Customer changed their mind","Payment didn't go through","Duplicate bill","Other"];
/* reason: why (required, 3-200 characters). → { ok } or { error } */
export async function voidSale(sid,reason){
  const no=denied(CANCEL_BILL,"cancel bills"); if(no) return no;
  const r=D().retBySale[sid];
  if(r&&r.length){ const e="This bill has a return or exchange, so it can't be cancelled. Use a return instead."; toast(e); return {error:e}; }
  const why=String(reason==null?"":reason).trim().replace(/\s+/g," ");
  if(why.length<3) return {error:"Say why the bill is cancelled."};
  const id=myOpenDocId(),v=store.localDays[id].voids, s=keptSale(sid);
  if(!v.includes(sid))v.push(sid);
  if(s) s.voidReason=why.slice(0,200);
  store.dirty.add(id); persistLocal(); invalidate(); renderAll();
  toast("Bill cancelled — its stock is back on the shelf.");
  enqueue({ type: "void", id: sid, isVoid: true, reason: why.slice(0,200) }); renderSync(); flushSbQueue();
  return {ok:true};
}
export async function unvoid(sid){
  if(!canAny(CANCEL_BILL)){ const e=notAllowedText("restore bills"); toast(e); return {error:e}; }
  // its serial numbers must still be free: a piece sold again on another bill can't be on this one too
  const se=restoreSerialError(D().saleById[sid]); if(se){ toast(se); return {error:se}; }
  Object.keys(store.localDays).forEach(id=>{const v=store.localDays[id].voids||[],i=v.indexOf(sid);if(i>-1){v.splice(i,1);store.dirty.add(id)}});
  Object.keys(store.remoteDays).forEach(id=>{const v=store.remoteDays[id].voids||[],i=v.indexOf(sid);if(i>-1)v.splice(i,1)});
  const s=keptSale(sid); if(s) delete s.voidReason;
  persistLocal(); invalidate(); renderAll(); toast("Bill restored.");
  enqueue({ type: "void", id: sid, isVoid: false }); renderSync(); flushSbQueue();
}
