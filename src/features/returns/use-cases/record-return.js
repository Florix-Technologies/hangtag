// RecordReturn: a return for a refund, or an exchange (a return plus a new bill), from a completed bill on this device.
//   · The return is valued from the bill's saved figures (domain/returns/return-value.js): discounts and GST as charged,
//     round off only when the whole bill comes back.
//   · An exchange's new bill is priced and taxed like any bill (checkout), for the original bill's customer, with the
//     original bill's percentage discount unless it is switched off, and tagged with the original bill's event. What comes
//     back is credit against it; the customer pays the rest, or gets the difference back, in whole rupees (the paise go to
//     the credit note's round off).
//   · Stock: returned pieces go back on the shelf unless marked not for resale; the new bill's pieces go out.
//   · Money: a refund posts a financial transaction and a cash or bank book entry (domain/finance/books.js; the database
//     posts the same); the new bill's payments post like any bill's.
import { lineLabel } from '../../../domain/catalog/options.js';
import { exchangeSettlement, quoteReturn } from '../../../domain/returns/return-value.js';
import { PAY_METHODS } from '../../../domain/sales/payments.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { billTotals } from '../../sales/services/totals.js';
import { newSaleRecord, recordSale } from '../../sales/use-cases/checkout.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { creditNoteNo, exchangeAvail, exchangeCustomer, exchangeDiscount } from '../services/return-rules.js';
import { returnRepository } from '../repositories/return-repository.js';
import { uid } from '../../../shared/utils/ids.js';

/* req: { sid, picks: { [line no]: pieces }, mode: "return" | "exchange", pay (refund method), collect (how the customer pays
   an exchange's difference: a method, or split parts), reason, notForResale: { [line no]: true }, newItems (exchange lines),
   keepDiscount (exchange: apply the original bill's % discount; default yes) }
   → { ret, sale (the exchange's new bill, or null), refund, collect } — or { error } and nothing is saved */
export function recordReturn(req){
  const d=D(), s=d.saleById[req.sid];
  if(!s) return {error:"That bill isn't on this device."};
  if(s.void) return {error:"This bill is cancelled, so nothing on it can be returned."};
  const Q=quoteReturn(s,req.picks||{},d.retBySale[s.id]||[]);
  if(Q.error) return {error:Q.error};
  if(!Q.lines.length) return {error:"Choose at least one item coming back."};
  const ex=req.mode==="exchange", nfr=req.notForResale||{}, t=Date.now(), exId=ex?"x"+uid():null;
  let newSale=null, S={credit:0,refund:Q.value,collect:0,roundOff:0,value:Q.value};
  if(ex){
    const items=req.newItems||[];
    if(!items.length) return {error:"Add the new items for the exchange, or switch to Return."};
    for(const c of items) if(exchangeAvail(s,req.picks,nfr,items,c.v)<0) return {error:`Not enough ${c.name} ${lineLabel(c)} in stock.`};
    const cust=exchangeCustomer(s), billDisc=req.keepDiscount===false?null:exchangeDiscount(s);
    S=exchangeSettlement(Q.value,billTotals(items,billDisc,cust).total);
    newSale=newSaleRecord(items,billDisc,req.collect||"cash",{kind:"exchange",ex:exId,cust,credit:S.credit,event:s.event||null});
    if(newSale.error) return {error:newSale.error};
  }
  if(S.refund>0&&!PAY_METHODS.includes(req.pay)) return {error:"Choose how the refund is paid."};
  const byLn={}; s.items.forEach((i,k)=>{byLn[i.ln!=null?i.ln:k]=i});
  const items=Q.lines.map(L=>{const i=byLn[L.ln];
    return {ln:L.ln,v:d.resolve(i)||i.v,p:i.p,n:i.n,c:i.c||"",s:i.s||"",vl:lineLabel(i),ov:i.ov||[],sku:i.sku||"",q:L.q,price:L.unit,value:L.value,
      cost:i.cost==null?null:i.cost,restock:!nfr[L.ln],tx:L.tx,cgst:L.cgst,sgst:L.sgst,igst:L.igst,gst:L.rate,hsn:L.hsn}});
  const ret={id:"r"+uid(),no:creditNoteNo(t),sale:s.id,t,kind:ex?"exchange":"return",ex:exId,refund:S.refund,pay:PAY_METHODS.includes(req.pay)?req.pay:"cash",
    value:S.value,ro:Math.round((Q.roundOff+S.roundOff)*100)/100,note:String(req.reason||"").slice(0,200),dev:store.dev,items};
  // the new bill first (it is paid now), then the return; both are on this device before anything uploads
  if(newSale){ store.lastSale=newSale; recordSale(newSale); }
  returnRepository().record(ret);
  renderSync(); flushSbQueue();
  return {ret,sale:newSale,refund:S.refund,collect:S.collect};
}
