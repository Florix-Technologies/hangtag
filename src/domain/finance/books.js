// Money records derived from bills and returns, kept apart from them:
//   financial transactions — one per payment on a bill (money in) and one per refund on a return (money out),
//     each pointing at the bill it came from;
//   cash book — the cash transactions, with a running cash balance;
//   bank book — the UPI and card transactions.
// Deterministic: the same bills and returns always give the same entries with the same ids ("ft:<payment id>",
// "ft:<return id>", "cb:…", "bb:…"), so nothing is ever counted twice, and the database posts the very same entries
// (supabase/schema.sql section 3e). A cancelled bill keeps its entries, marked cancelled, and they leave the balances.
// Pure; amounts in rupees, added up in paise.
import { PAY_METHODS, paymentsOf } from '../sales/payments.js';
import { sumP, toPaise, toRupees } from '../sales/paise.js';

const byTime=(a,b)=>a.t-b.t||(a.id<b.id?-1:a.id>b.id?1:0);

/* sales: bills with { id, no, t, void, payments | pay, total, credit } · returns: { id, sale, t, refund, pay } */
export function financialTransactions(sales,returns){
  const bill={}, out=[];
  (sales||[]).forEach(s=>{
    bill[s.id]=s;
    paymentsOf(s).forEach(p=>out.push({id:"ft:"+p.id,kind:"sale_receipt",dir:"in",method:p.method,amount:p.amount,saleId:s.id,billNo:s.no||"",
      paymentId:p.id,returnId:null,ref:p.ref||"",received:p.method==="cash"?(p.received==null?p.amount:p.received):null,change:p.change||0,
      t:s.t,status:s.void?"cancelled":"posted"}));
  });
  (returns||[]).forEach(r=>{
    if(!(toPaise(r.refund)>0)||!PAY_METHODS.includes(r.pay)) return;
    const s=bill[r.sale];
    out.push({id:"ft:"+r.id,kind:"refund",dir:"out",method:r.pay,amount:r.refund,saleId:r.sale,billNo:s&&s.no||"",paymentId:null,returnId:r.id,
      ref:"",received:null,change:0,t:r.t,status:s&&s.void?"cancelled":"posted"});
  });
  return out.sort(byTime);
}
/* Cash book between two times (ms, inclusive; leave out for everything): opening balance, entries with the balance after
   each, and the totals. Cash sales count what stays in the drawer (received − change). */
export function cashBook(txns,{from=-Infinity,to=Infinity}={}){
  const cash=(txns||[]).filter(x=>x.method==="cash").sort(byTime), live=x=>x.status==="posted", signed=x=>x.dir==="in"?toPaise(x.amount):-toPaise(x.amount);
  let bal=sumP(cash.filter(x=>live(x)&&x.t<from).map(signed));
  const opening=bal, entries=[];
  cash.filter(x=>x.t>=from&&x.t<=to).forEach(x=>{
    if(live(x)) bal+=signed(x);
    entries.push({id:"cb:"+x.id,finTxnId:x.id,type:x.kind==="refund"?"cash_refund":"cash_sale",t:x.t,saleId:x.saleId,billNo:x.billNo,returnId:x.returnId,
      in:x.dir==="in"?x.amount:0,out:x.dir==="out"?x.amount:0,received:x.received,change:x.change,status:x.status,balance:toRupees(bal)});
  });
  const P=entries.filter(live), add=f=>toRupees(sumP(P.map(f)));
  return {opening:toRupees(opening),entries,cashSales:add(e=>toPaise(e.in)),received:add(e=>toPaise(e.in?e.received:0)),changeGiven:add(e=>toPaise(e.change)),
    refunds:add(e=>toPaise(e.out)),closing:toRupees(bal),cancelled:entries.length-P.length};
}
/* Bank book (UPI and card) between two times: entries and totals per method */
export function bankBook(txns,{from=-Infinity,to=Infinity}={}){
  const live=x=>x.status==="posted";
  const entries=(txns||[]).filter(x=>(x.method==="upi"||x.method==="card")&&x.t>=from&&x.t<=to).sort(byTime).map(x=>({id:"bb:"+x.id,finTxnId:x.id,
    type:x.kind==="refund"?"refund":"receipt",method:x.method,t:x.t,saleId:x.saleId,billNo:x.billNo,returnId:x.returnId,ref:x.ref,
    in:x.dir==="in"?x.amount:0,out:x.dir==="out"?x.amount:0,status:x.status}));
  const P=entries.filter(live), add=f=>toRupees(sumP(P.map(f)));
  return {entries,upiIn:add(e=>e.method==="upi"?toPaise(e.in):0),cardIn:add(e=>e.method==="card"?toPaise(e.in):0),
    refunds:add(e=>toPaise(e.out)),net:add(e=>toPaise(e.in)-toPaise(e.out)),cancelled:entries.length-P.length};
}
/* Does a bill's money add up? Posted receipts must equal what was due (nothing for a cancelled bill). */
export function reconcileSale(sale,txns){
  const due=sale.void?0:Math.max(0,toPaise(sale.total)-toPaise(sale.credit));
  const got=sumP((txns||[]).filter(x=>x.saleId===sale.id&&x.kind==="sale_receipt"&&x.status==="posted").map(x=>toPaise(x.amount)));
  return {due:toRupees(due),received:toRupees(got),ok:due===got};
}
