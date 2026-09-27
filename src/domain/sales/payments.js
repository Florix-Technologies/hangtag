// Payments on a bill: cash, UPI or card, or a split over any of them. The shop records how the customer paid and an
// optional reference (UPI transaction id, card slip number) — there is no payment gateway. The parts must add up to
// the amount due exactly before a sale can complete; cash may be handed over in excess, and the rest is change.
// Pure; amounts in rupees in and out, compared in paise.
import { sumP, toPaise, toRupees, tooPrecise } from './paise.js';
import { inrx } from '../../shared/formatting/money.js';

export const PAY_METHODS=["cash","upi","card"];
export const PAY_LABELS={cash:"Cash",upi:"UPI",card:"Card"};

/* One payment id per bill and method: the same bill never gets the same method twice, and uploads never duplicate it */
export const paymentId=(saleId,method)=>`${saleId}:${method}`;

/* An optional reference: up to 40 letters, digits and - / . # */
export function checkReference(ref){
  const r=String(ref==null?"":ref).trim();
  if(!r) return null;
  if(r.length>40) return {error:"A reference can be at most 40 characters."};
  if(!/^[A-Za-z0-9][A-Za-z0-9 ./#-]*$/.test(r)) return {error:"Use letters, digits, spaces and - / . # in the reference."};
  return null;
}
const amountOf=v=>v==null||String(v).trim()===""?0:+v;

/* Checks the parts of a payment against the amount due (rupees).
   allocations: [{ method, amount, received? (cash handed over), ref? }] — empty or zero amounts are left out.
   → { ok: true, payments: [{ method, amount, received?, change?, ref? }], paid, received, change }
   or { error, method?, field?, paid, balance } (nothing is recorded) */
export function settlePayments(due,allocations){
  const D=toPaise(due), list=(allocations||[]).filter(a=>a&&amountOf(a.amount)!==0), seen=new Set();
  let paid=0;
  const fail=(error,a,field)=>({error,method:a&&a.method,field,paid:toRupees(paid),balance:toRupees(Math.max(0,D-paid))});
  for(const a of list){
    const v=amountOf(a.amount);
    if(!PAY_METHODS.includes(a.method)) return fail("Choose cash, UPI or card.",a,"method");
    if(seen.has(a.method)) return fail(`${PAY_LABELS[a.method]} is there twice. Put all of it on one line.`,a,"amount");
    seen.add(a.method);
    if(!Number.isFinite(v)) return fail(`Enter the ${PAY_LABELS[a.method]} amount as a number.`,a,"amount");
    if(v<0) return fail("A payment can't be negative.",a,"amount");
    if(tooPrecise(v)) return fail("Use at most 2 decimal places.",a,"amount");
    const r=checkReference(a.ref); if(r) return fail(r.error,a,"ref");
    paid+=toPaise(v);
  }
  if(paid<D) return fail(`${inrx(toRupees(D-paid))} still to pay.`,null,"amount");
  if(paid>D) return fail(`That's ${inrx(toRupees(paid-D))} more than the bill.`,null,"amount");
  const payments=[];let received=0,change=0;
  for(const a of list){
    const p={method:a.method,amount:+(+a.amount).toFixed(2)};
    if(a.method==="cash"){
      const got=amountOf(a.received)===0?toPaise(p.amount):toPaise(a.received);
      if(!Number.isFinite(got)||got<toPaise(p.amount)) return fail("Cash received is less than the cash amount.",a,"received");
      p.received=toRupees(got); p.change=toRupees(got-toPaise(p.amount));
      received+=got; change+=got-toPaise(p.amount);
    }else received+=toPaise(p.amount);
    const ref=String(a.ref==null?"":a.ref).trim(); if(ref&&a.method!=="cash") p.ref=ref;
    payments.push(p);
  }
  return {ok:true,payments,paid:toRupees(paid),received:toRupees(received),change:toRupees(change)};
}
/* Live figures for the payment screen: paid so far, balance still due, more than due, change from cash handed over */
export function paymentProgress(due,allocations){
  const D=toPaise(due), list=(allocations||[]).filter(Boolean);
  const paid=sumP(list.map(a=>{const v=amountOf(a.amount);return Number.isFinite(v)&&v>0?toPaise(v):0}));
  const cash=list.find(a=>a.method==="cash"), cp=cash?toPaise(amountOf(cash.amount))||0:0, got=cash?toPaise(amountOf(cash.received))||0:0;
  return {paid:toRupees(paid),balance:toRupees(Math.max(0,D-paid)),over:toRupees(Math.max(0,paid-D)),change:toRupees(got>cp&&cp>0?got-cp:0)};
}
/* A bill's payments. Bills saved before split payments have one method for everything that was due. */
export function paymentsOf(sale){
  if(Array.isArray(sale.payments)) return sale.payments;
  const due=Math.max(0,toPaise(sale.total)-toPaise(sale.credit));
  return due>0&&PAY_METHODS.includes(sale.pay)?[{id:paymentId(sale.id,sale.pay),method:sale.pay,amount:toRupees(due)}]:[];
}
/* "Cash", "UPI + Card" … */
export function payLabel(sale){
  const ps=paymentsOf(sale);
  return ps.length?ps.map(p=>PAY_LABELS[p.method]||p.method).join(" + "):sale.pay==="split"?"Split":(PAY_LABELS[sale.pay]||sale.pay||"");
}
