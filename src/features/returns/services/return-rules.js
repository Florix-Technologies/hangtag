// Return values and limits for the bills on this device (the rules are in domain/returns/return-value.js).
import { store } from '../../../shared/state/store.js';
import { lineNo, quoteReturn, returnableQty, savedLine } from '../../../domain/returns/return-value.js';
import { nextDocNo } from '../../../domain/sales/sale.js';
import { normalizeDiscount } from '../../../domain/sales/discounts.js';
import { toRupees } from '../../../domain/sales/paise.js';
import { D } from '../../inventory/services/ledger.js';
import { stockOf } from '../../inventory/services/stock.js';

/* What one piece of a bill line was paid (its share of the line after discounts, with GST), from the saved bill */
export function unitValue(s,i){ return i.q?toRupees(Math.round(savedLine(s,i).lt/i.q)):0; }
/* Pieces of a bill line that can still be returned */
export function returnable(s,i,k){ return returnableQty(s,i,k,D().retBySale[s.id]||[]); }
/* The return being prepared (store.retState): its value, refund split and GST, or { error } */
export function retQuote(){ const s=D().saleById[store.retState.sid]; return quoteReturn(s,store.retState.q,D().retBySale[s.id]||[]); }
export function retValue(){ const Q=retQuote(); return Q.error?0:Q.value; }
/* An exchange's new bill is for the original bill's customer, with the original bill's percentage discount by default */
export const exchangeCustomer=s=>s.cust?{id:s.cust.id,name:s.cust.name,phone:s.cust.phone}:null;
export function exchangeDiscount(s){ const d=normalizeDiscount(s.billDisc); return d&&d.type==="percent"?d:null; }
/* Stock for an exchange's new items: what's on the shelf, plus pieces coming back in this same exchange (unless not for
   resale), less the new items already chosen */
export function exchangeAvail(s,picks,notForResale,newItems,vid){
  let back=0; const nfr=notForResale||{};
  s.items.forEach((i,k)=>{const ln=lineNo(i,k);if(!nfr[ln]&&D().resolve(i)===vid)back+=+((picks||{})[ln]||0)});
  return stockOf(vid)+back-(newItems||[]).filter(c=>c.v===vid).reduce((a,c)=>a+c.q,0);
}
export function exAvail(vid){
  const R=store.retState, s=R&&D().saleById[R.sid];
  return s?exchangeAvail(s,R.q,R.nfr,R.newItems,vid):stockOf(vid);
}
/* Serials of bill line ln that earlier returns took back */
export const returnedSerials=(s,ln)=>new Set((D().retBySale[s.id]||[]).flatMap(r=>(r.items||[]).filter(i=>i.ln===ln&&Array.isArray(i.sn)).flatMap(i=>i.sn)));
/* The next credit note number: this device's own series that day, like bill numbers (CN-260929-K3F001) */
export const creditNoteNo=t=>nextDocNo("CN-",D().rets,t,store.dev);
