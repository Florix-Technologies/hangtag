// Payments on a bill: cash, UPI or card, or a split over any of them. The parts must add up to the amount due exactly
// before a sale can complete; cash may be handed over in excess, and the rest is change.
// How each part was confirmed is kept with it (its verification):
//   verified   — the payment provider confirmed the money (a UPI QR or a card payment link paid through the provider);
//   recorded   — cash, or a card paid on a separate card machine, marked received by the cashier (its reference optional);
//   unverified — UPI checked by eye by the cashier; its transaction reference (UTR) is optional.
// Showing a QR never pays anything: a provider part counts only once its payment intent says "verified".
// No card number, CVV or PIN is ever taken: at most the last 4 digits, and a reference that looks like a card number is
// refused. Pure; amounts in rupees in and out, compared in paise.
import { sumP, toPaise, toRupees, tooPrecise } from './paise.js';
import { inrx } from '../../shared/formatting/money.js';
import { providerFee } from './payment-provider.js';
import { VOUCHER, voucherPartError } from './vouchers.js';

export const PAY_METHODS=["cash","upi","card"];
export const PAY_LABELS={cash:"Cash",upi:"UPI",card:"Card",due:"On account",voucher:"Gift voucher"};
/* A gift voucher (domain/sales/vouchers.js) pays like a method of its own: never cash or bank money, one per bill */
export { VOUCHER };
/* The part of a bill left on a saved customer's account (paid later: domain/customers/credit.js). Never money in the drawer
   or the bank, so it is not a payment: the bill keeps it as dueAmt. A return may also be refunded to the account ("due"). */
export const DUE="due";
/* How a UPI or card part is taken: by hand, or through the payment provider */
export const PAY_VIA={upi:["manual","qr"],card:["terminal","link"]};
export const VIA_LABELS={manual:"UPI (checked by hand)",qr:"UPI QR (verified)",terminal:"Card machine",link:"Card link (verified)"};
export const PROVIDER_VIA=["qr","link"];
export const VERIFY_LABELS={verified:"Verified",recorded:"Recorded",unverified:"Unverified"};
/* A payment intent at the provider (a QR or a payment link) */
export const INTENT_STATES=["pending","verified","failed","cancelled","expired","unmatched"];
export const INTENT_LABELS={pending:"Payment pending",verified:"Payment received",failed:"Payment failed",cancelled:"Cancelled",expired:"Expired",unmatched:"Received, not matched to this bill"};

/* One payment id per bill and method: the same bill never gets the same method twice, and uploads never duplicate it */
export const paymentId=(saleId,method)=>`${saleId}:${method}`;

/* 13-19 digits that pass the Luhn check: a card number, which must never be typed in or kept */
export function looksLikeCardNumber(v){
  const d=String(v==null?"":v).replace(/[\s-]/g,"");
  if(!/^\d{13,19}$/.test(d)) return false;
  let sum=0;
  for(let i=0;i<d.length;i++){ let n=+d[d.length-1-i]; if(i%2){ n*=2; if(n>9) n-=9; } sum+=n; }
  return sum%10===0;
}
/* An optional reference: up to 40 letters, digits and - / . # — never a card number */
export function checkReference(ref){
  const r=String(ref==null?"":ref).trim();
  if(!r) return null;
  if(r.length>40) return {error:"A reference can be at most 40 characters."};
  if(!/^[A-Za-z0-9][A-Za-z0-9 ./#-]*$/.test(r)) return {error:"Use letters, digits, spaces and - / . # in the reference."};
  if(looksLikeCardNumber(r)) return {error:"That looks like a card number. Never type card numbers: use the approval code on the card machine slip."};
  return null;
}
/* The last 4 digits of a card (optional): exactly 4 digits, nothing more */
export function checkLast4(v){
  const d=String(v==null?"":v).trim();
  if(!d) return null;
  return /^\d{4}$/.test(d)?null:{error:"Enter only the last 4 digits of the card."};
}
const amountOf=v=>v==null||String(v).trim()===""?0:+v;
export const viaOf=a=>a.via||(a.method==="upi"?"manual":a.method==="card"?"terminal":undefined);

/* Checks the parts of a payment against the amount due (rupees).
   allocations: [{ method, amount, received? (cash handed over), ref?, via?, last4? (card), intent? ({ id, status, amount, paymentId }) }]
   — empty or zero amounts are left out. One part may be { method: "due", amount }: left on the customer's account, only
   when opts.customer (the bill has a saved customer); the rest must still add up exactly.
   → { ok: true, payments: [{ method, amount, verification, received?, change?, ref?, via?, last4?, intent?, providerRef? }], paid, received, change,
       onAccount? (only when part is left on account) }
   or { error, method?, field?, paid, balance } (nothing is recorded) */
export function settlePayments(due,allocations,opts){
  const D=toPaise(due), all=(allocations||[]).filter(a=>a&&amountOf(a.amount)!==0), seen=new Set();
  const list=all.filter(a=>a.method!==DUE&&a.method!==VOUCHER), acctParts=all.filter(a=>a.method===DUE), vParts=all.filter(a=>a.method===VOUCHER);
  let paid=0, acct=0;
  const fail=(error,a,field)=>({error,method:a&&a.method,field,paid:toRupees(paid),balance:toRupees(Math.max(0,D-paid-acct))});
  if(acctParts.length>1) return fail("The amount on account is there twice. Put all of it on one line.",acctParts[1],"amount");
  if(acctParts.length){
    const a=acctParts[0], v=amountOf(a.amount);
    if(!Number.isFinite(v)) return fail("Enter the amount on account as a number.",a,"amount");
    if(v<0) return fail("The amount on account can't be negative.",a,"amount");
    if(tooPrecise(v)) return fail("Use at most 2 decimal places.",a,"amount");
    if(!(opts&&opts.customer)) return fail("Add a saved customer to the bill to put part of it on their account.",a,"customer");
    acct=toPaise(v);
  }
  if(vParts.length>1) return fail("One gift voucher per bill. Pay the rest another way.",vParts[1],"voucher");
  let vouch=0;
  for(const a of vParts){
    const v=amountOf(a.amount);
    if(!Number.isFinite(v)||v<0||tooPrecise(v)) return fail("Enter the voucher amount.",a,"amount");
    vouch=toPaise(v);
  }
  paid+=vouch;
  for(const a of list){
    const v=amountOf(a.amount);
    if(!PAY_METHODS.includes(a.method)) return fail("Choose cash, UPI or card.",a,"method");
    if(seen.has(a.method)) return fail(`${PAY_LABELS[a.method]} is there twice. Put all of it on one line.`,a,"amount");
    seen.add(a.method);
    if(!Number.isFinite(v)) return fail(`Enter the ${PAY_LABELS[a.method]} amount as a number.`,a,"amount");
    if(v<0) return fail("A payment can't be negative.",a,"amount");
    if(tooPrecise(v)) return fail("Use at most 2 decimal places.",a,"amount");
    if(a.method!=="cash"&&!PAY_VIA[a.method].includes(viaOf(a))) return fail(`Choose how the ${PAY_LABELS[a.method]} payment is taken.`,a,"via");
    paid+=toPaise(v);
  }
  // the amounts first (they're typed first), then how each part was confirmed
  if(paid+acct<D) return fail(`${inrx(toRupees(D-paid-acct))} still to pay.`,null,"amount");
  if(paid+acct>D) return fail(`That's ${inrx(toRupees(paid+acct-D))} more than the bill.`,null,"amount");
  for(const a of vParts){ const e=voucherPartError(a); if(e) return fail(e,a,"voucher"); }
  for(const a of list){
    const v=amountOf(a.amount);
    if(PROVIDER_VIA.includes(viaOf(a))){
      const I=a.intent;
      if(!I||I.status!=="verified") return fail(`Waiting for the ${PAY_LABELS[a.method]} payment to be confirmed by the payment provider.`,a,"intent");
      if(toPaise(I.amount)!==toPaise(v)) return fail(`The ${PAY_LABELS[a.method]} payment received was ${inrx(I.amount)}, not ${inrx(v)}.`,a,"intent");
    }else{
      const r=checkReference(a.ref); if(r) return fail(r.error,a,"ref");
      if(a.method==="upi"&&!a.confirmed) return fail("Mark the UPI payment received after checking the customer's payment screen.",a,"confirmed");
      // a card on the shop's own machine: marked received once the machine approves it (a typed approval number says so too)
      if(a.method==="card"&&!a.confirmed&&!String(a.ref==null?"":a.ref).trim()) return fail("Mark the card payment received once the card machine approves it.",a,"confirmed");
    }
    if(a.method==="card"){ const l=checkLast4(a.last4); if(l) return fail(l.error,a,"last4"); }
  }
  const payments=[];let received=0,change=0;
  for(const a of list){
    const via=viaOf(a), p={method:a.method,amount:+(+a.amount).toFixed(2)};
    if(a.method==="cash"){
      const got=amountOf(a.received)===0?toPaise(p.amount):toPaise(a.received);
      if(!Number.isFinite(got)||got<toPaise(p.amount)) return fail("Cash received is less than the cash amount.",a,"received");
      p.received=toRupees(got); p.change=toRupees(got-toPaise(p.amount));
      received+=got; change+=got-toPaise(p.amount);
      p.verification="recorded";
    }else{
      received+=toPaise(p.amount); p.via=via;
      if(PROVIDER_VIA.includes(via)){
        p.verification="verified"; p.intent=a.intent.id; p.providerRef=String(a.intent.paymentId||a.intent.reference||"").slice(0,40);
        if(p.providerRef) p.ref=p.providerRef;
        const fee=providerFee(a.intent.providerFee); if(fee!=null) p.providerFee=fee;
      }else{
        p.verification=a.method==="upi"?"unverified":"recorded";
        const ref=String(a.ref==null?"":a.ref).trim(); if(ref) p.ref=ref;
      }
      if(a.method==="card"&&String(a.last4||"").trim()) p.last4=String(a.last4).trim();
    }
    payments.push(p);
  }
  // the voucher part: the database already took it off the voucher (its redemption); only the code's last 4 are shown
  for(const a of vParts){ received+=toPaise(a.amount); payments.push({method:VOUCHER,amount:+(+a.amount).toFixed(2),verification:"recorded",voucher:a.voucher.id,redemption:a.voucher.redemption,ref:"GV ···"+String(a.voucher.code||"").slice(-4)}); }
  return {ok:true,payments,paid:toRupees(paid),received:toRupees(received),change:toRupees(change),...(acct?{onAccount:toRupees(acct)}:{})};
}
/* Live figures for the payment screen: paid so far, balance still due, more than due, change from cash handed over, and
   the part left on the customer's account */
export function paymentProgress(due,allocations){
  const D=toPaise(due), all=(allocations||[]).filter(Boolean), list=all.filter(a=>a.method!==DUE);
  const pos=a=>{const v=amountOf(a.amount);return Number.isFinite(v)&&v>0?toPaise(v):0};
  const paid=sumP(list.map(pos)), acct=sumP(all.filter(a=>a.method===DUE).map(pos));
  const cash=list.find(a=>a.method==="cash"), cp=cash?toPaise(amountOf(cash.amount))||0:0, got=cash?toPaise(amountOf(cash.received))||0:0;
  return {paid:toRupees(paid),balance:toRupees(Math.max(0,D-paid-acct)),over:toRupees(Math.max(0,paid+acct-D)),change:toRupees(got>cp&&cp>0?got-cp:0),...(acct?{onAccount:toRupees(acct)}:{})};
}
/* What a bill left on the customer's account (0 for bills without one) */
export const dueAmtOf=sale=>sale&&+sale.dueAmt>0?+sale.dueAmt:0;
/* A bill's payments. Bills saved before split payments have one method for everything that was due. */
export function paymentsOf(sale){
  if(Array.isArray(sale.payments)) return sale.payments;
  const due=Math.max(0,toPaise(sale.total)-toPaise(sale.credit)-toPaise(dueAmtOf(sale)));
  return due>0&&PAY_METHODS.includes(sale.pay)?[{id:paymentId(sale.id,sale.pay),method:sale.pay,amount:toRupees(due)}]:[];
}
/* How a payment was confirmed. Payments saved before verification was kept count as recorded. */
export const verificationOf=p=>p&&p.verification||"recorded";
/* The bill's UPI parts still checked only by hand (a bill with any is labelled "Unverified") */
export const unverifiedPayments=sale=>paymentsOf(sale).filter(p=>verificationOf(p)==="unverified");
export const isUnverified=sale=>!sale.void&&unverifiedPayments(sale).length>0;
/* "Cash", "UPI + Card", "Cash + On account" … */
export function payLabel(sale){
  const ps=paymentsOf(sale), acct=dueAmtOf(sale)>0?[PAY_LABELS.due]:[];
  if(!ps.length&&acct.length) return acct[0];
  return ps.length?[...ps.map(p=>PAY_LABELS[p.method]||p.method),...acct].join(" + "):sale.pay==="split"?"Split":(PAY_LABELS[sale.pay]||sale.pay||"");
}
