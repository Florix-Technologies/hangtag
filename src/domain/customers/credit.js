// Customer credit ("on account"): what a saved customer owes the shop. A bill may leave part of its total, or all of it, on
// the customer's account (the bill's dueAmt; domain/sales/payments.js settlePayments with a "due" part). What they owe:
//   Σ amounts on account of their bills (cancelled bills left out)
//   − returns on those bills refunded to the account ("due": no money moves, it only takes off what they owe)
//   − payments collected later (collections: cash, UPI or card, posted to the cash or bank book like a bill's payment).
// The database keeps the same rules (supabase/schema.sql section 3m). Pure; rupees in and out, added up in paise.
import { PAY_LABELS, PAY_METHODS, checkReference, dueAmtOf, paymentsOf } from '../sales/payments.js';
import { sumP, toPaise, toRupees, tooPrecise } from '../sales/paise.js';
import { inrx } from '../../shared/formatting/money.js';

const live=c=>c&&c.status!=="cancelled";
/* How much of a bill is still on account: its amount on account less returns on it already refunded to the account */
export function dueRefundRoom(sale,returns){
  if(!sale||sale.void) return 0;
  const taken=sumP((returns||[]).filter(r=>r.sale===sale.id&&r.pay==="due").map(r=>toPaise(r.refund)));
  return toRupees(Math.max(0,toPaise(dueAmtOf(sale))-taken));
}
/* One customer's account from the bills, returns and collections on this device.
   → { purchases (Σ bills, less exchange credit), paidAtSale, onAccount, refundedToAccount, collected, paid (at the till +
       collected), outstanding, bills (count), entries: newest first [{ id, kind: "bill" | "refund" | "collection", t, no, amount,
       charge (added to what they owe), credit (taken off), balance (owed after it), method?, ref?, saleId?, status? }] } */
export function customerAccount(cid,{sales,returns,collections}={}){
  const bills=(sales||[]).filter(s=>!s.void&&s.cust&&s.cust.id===cid), ids=new Set(bills.map(s=>s.id)), byId=Object.fromEntries(bills.map(s=>[s.id,s]));
  const rets=(returns||[]).filter(r=>ids.has(r.sale)&&r.pay==="due"&&toPaise(r.refund)>0);
  const cols=(collections||[]).filter(c=>c.cust===cid);
  const ev=[
    ...bills.map(s=>({id:s.id,kind:"bill",t:s.t,no:s.no||"",saleId:s.id,amount:Math.max(0,toPaise(s.total)-toPaise(s.credit)),
      paid:sumP(paymentsOf(s).map(p=>toPaise(p.amount))),charge:toPaise(dueAmtOf(s)),credit:0})),
    ...rets.map(r=>({id:r.id,kind:"refund",t:r.t,no:r.no||"",saleId:r.sale,billNo:(byId[r.sale]||{}).no||"",amount:toPaise(r.refund),charge:0,credit:toPaise(r.refund)})),
    ...cols.map(c=>({id:c.id,kind:"collection",t:c.t,no:"",amount:toPaise(c.amount),method:c.method,ref:c.ref||"",status:live(c)?"posted":"cancelled",
      charge:0,credit:live(c)?toPaise(c.amount):0})),
  ].sort((a,b)=>a.t-b.t||(a.id<b.id?-1:a.id>b.id?1:0));
  let bal=0;
  const entries=ev.map(e=>{bal+=e.charge-e.credit;return {...e,amount:toRupees(e.amount),charge:toRupees(e.charge),credit:toRupees(e.credit),...(e.paid!=null?{paid:toRupees(e.paid)}:{}),balance:toRupees(bal)}}).reverse();
  const P=f=>sumP(ev.map(f));
  const onAccount=P(e=>e.kind==="bill"?e.charge:0), refunded=P(e=>e.kind==="refund"?e.credit:0), collected=P(e=>e.kind==="collection"?e.credit:0), atSale=P(e=>e.kind==="bill"?e.paid:0);
  return {purchases:toRupees(P(e=>e.kind==="bill"?e.amount:0)),paidAtSale:toRupees(atSale),onAccount:toRupees(onAccount),refundedToAccount:toRupees(refunded),
    collected:toRupees(collected),paid:toRupees(atSale+collected),outstanding:toRupees(onAccount-refunded-collected),bills:bills.length,entries};
}
/* What every customer owes (only those with something on account or collected): { [customer id]: rupees } */
export function outstandingByCustomer({sales,returns,collections}={}){
  const P={}, add=(id,p)=>{if(id)P[id]=(P[id]||0)+p}, bill={};
  (sales||[]).forEach(s=>{bill[s.id]=s; if(!s.void&&s.cust&&s.cust.id&&dueAmtOf(s)>0) add(s.cust.id,toPaise(dueAmtOf(s)));});
  (returns||[]).forEach(r=>{const s=bill[r.sale]; if(s&&!s.void&&s.cust&&r.pay==="due") add(s.cust.id,-toPaise(r.refund));});
  (collections||[]).forEach(c=>{if(live(c)) add(c.cust,-toPaise(c.amount));});
  return Object.fromEntries(Object.entries(P).map(([k,v])=>[k,toRupees(v)]));
}
/* A payment collected from a customer: input { amount, method, ref?, note? }, outstanding (what they owe now).
   → { collection: { amount, method, ref?, verification, note? } } or { error, field } (nothing is recorded).
   Never more than they owe; UPI needs its reference (UTR) and is kept "unverified" (checked by hand); card needs the card
   machine's reference; a reference that looks like a card number is refused. */
export function checkCollection(input,outstanding){
  const i=input||{}, raw=String(i.amount==null?"":i.amount).trim(), v=+raw, method=i.method||"cash";
  if(!raw||!Number.isFinite(v)||v<=0) return {error:"Enter the amount received.",field:"amount"};
  if(tooPrecise(v)) return {error:"Use at most 2 decimal places.",field:"amount"};
  if(!(toPaise(outstanding)>0)) return {error:"This customer owes nothing.",field:"amount"};
  if(toPaise(v)>toPaise(outstanding)) return {error:`That's more than they owe (${inrx(outstanding)}).`,field:"amount"};
  if(!PAY_METHODS.includes(method)) return {error:"Choose cash, UPI or card.",field:"method"};
  const ref=String(i.ref==null?"":i.ref).trim(), bad=checkReference(ref);
  if(bad) return {error:bad.error,field:"ref"};
  if(method!=="cash"&&!ref) return {error:method==="upi"?"Enter the UPI transaction reference (UTR) from the customer's payment screen.":"Enter the approval or transaction reference from the card machine.",field:"ref"};
  const note=String(i.note==null?"":i.note).trim().replace(/\s+/g," ").slice(0,200);
  return {collection:{amount:toRupees(toPaise(v)),method,...(method!=="cash"?{ref}:{}),verification:method==="upi"?"unverified":"recorded",...(note?{note}:{})}};
}
/* "Cash", "UPI · ref 4123…" for a collection */
export const collectionLabel=c=>(PAY_LABELS[c.method]||c.method)+(c.ref?" · ref "+c.ref:"");
