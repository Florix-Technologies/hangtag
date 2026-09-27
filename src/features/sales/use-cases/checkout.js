// Checkout and cancelling/restoring bills.
import { lineLabel } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { billTotals } from '../services/totals.js';
import { invoiceNo } from '../services/totals.js';
import { D } from '../../inventory/services/ledger.js';
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

export function newSaleRecord(lines,discount,pay,extra){
  const T=billTotals(lines,discount), t=Date.now(), seq=D().sales.filter(s=>dayKey(s.t)===dayKey(t)).length+1;
  return Object.assign({id:uid(),no:invoiceNo(t,seq),t,items:lines.map((c,k)=>({ln:k,v:c.v,p:c.p,n:c.name,c:c.c||"",s:c.s||"",vl:lineLabel(c),ov:c.ov||[],sku:c.sku||"",q:c.q,price:c.price,cost:c.cost==null?null:c.cost})),
    sub:T.sub,disc:T.disc,tax:T.tax,taxRate:T.rate,taxIncl:T.incl,total:T.total,credit:0,kind:"sale",ex:null,pay,dev:store.dev,
    cust:store.cartCust&&store.cartCust.name?{id:store.cartCust.id||null,name:store.cartCust.name,phone:store.cartCust.phone||""}:null},extra||{});
}
export function recordSale(sale){
  const id=myOpenDocId();
  store.localDays[id].sales.push(sale); store.dirty.add(id); persistLocal();
  // Queue for the cloud first, so the bill survives a closed tab or a dropped connection, then upload
  enqueue({ type:"sale", sale }); renderSync(); flushSbQueue();
}
export async function checkout(pay){
  if(!store.cart.length||Date.now()-store.lastCheckout<600)return;
  store.lastCheckout=Date.now();
  const sale=newSaleRecord(store.cart,store.disc,pay);
  store.cart=[]; store.disc=0; store.cartCust=null; saveCart();
  store.lastSale=sale;
  recordSale(sale);
  closeSheets(); renderAll();
  showPaid(sale);
}
/* ---------- cancel a wrong bill (puts the stock back) ---------- */

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
