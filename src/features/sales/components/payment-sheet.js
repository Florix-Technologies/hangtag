// Payment screen: the bill's figures (subtotal, discount, taxable amount, GST, grand total), then how it's paid —
// cash (with the amount received and the change), UPI or card (with an optional reference), or split over them.
// The sale completes only when the payments add up to the grand total (domain/sales/payments.js).
import { PAY_LABELS, PAY_METHODS, paymentProgress, settlePayments } from '../../../domain/sales/payments.js';
import { toPaise, toRupees } from '../../../domain/sales/paise.js';
import { store } from '../../../shared/state/store.js';
import { billTotals } from '../services/totals.js';
import { cartPcs } from '../services/cart.js';
import { billNo } from '../services/sales-log.js';
import { billDiscountError } from '../use-cases/discounts.js';
import { checkout } from '../use-cases/checkout.js';
import { discountRowsHTML, gstRowsHTML, roundRowHTML, sumRow } from './bill-summary.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

const due=()=>billTotals(store.cart,store.disc).total;
/* store.payState = { mode: "single" | "split", method, recv (cash handed over), ref: { upi, card }, amt: { cash, upi, card }, err } */
export function openPayment(method){
  if(!store.cart.length) return;
  const bad=billDiscountError(); if(bad){ toast(bad); return; }
  store.payState={mode:"single",method:PAY_METHODS.includes(method)?method:"cash",recv:"",ref:{upi:"",card:""},amt:{cash:"",upi:"",card:""},err:""};
  renderPayment(true);
}
/* The parts of the payment as typed, for domain/sales/payments.js */
export function allocations(){
  const s=store.payState, D=due();
  if(s.mode==="single") return [{method:s.method,amount:D,received:s.method==="cash"?s.recv:undefined,ref:s.ref[s.method]}];
  return PAY_METHODS.map(m=>({method:m,amount:s.amt[m],received:m==="cash"?s.recv:undefined,ref:s.ref[m]}));
}
const quickCash=D=>[...new Set([100,500,2000].map(n=>Math.ceil((D+1)/n)*n))].filter(v=>v>D).slice(0,3);
function fieldsHTML(D){
  const s=store.payState, inp=(f,label,val,extra)=>`<label class="f"><span class="lab">${label}</span><input data-payf="${f}" value="${esc(val)}" autocomplete="off" ${extra}></label>`;
  const money='type="number" inputmode="decimal" min="0" step="any"';
  if(s.mode==="split") return `<div class="splitrows">${PAY_METHODS.map(m=>`<div class="splitrow"><span class="spl">${PAY_LABELS[m]}</span><input data-payf="amt:${m}" value="${esc(s.amt[m])}" ${money} placeholder="0" aria-label="${PAY_LABELS[m]} amount"><button type="button" class="btn xs" data-payrest="${m}">Rest</button></div>`
      +(m==="cash"?inp("recv","Cash received <small>(optional, for change)</small>",s.recv,money+' placeholder="Same as cash"'):inp("ref:"+m,`${PAY_LABELS[m]} reference <small>(optional)</small>`,s.ref[m],'maxlength="40"'))).join("")}</div>`;
  if(s.method==="cash") return inp("recv","Amount received",s.recv,`${money} placeholder="${esc(inr(D))} (exact)"`)+
    `<div class="quick">${quickCash(D).map(v=>`<button type="button" class="chip" data-payquick="${v}">${inr(v)}</button>`).join("")}</div>`;
  return inp("ref:"+s.method,s.method==="upi"?"UPI reference <small>(optional — transaction id)</small>":"Card reference <small>(optional — slip or approval no.)</small>",s.ref[s.method],'maxlength="40"')+
    `<p class="note">${s.method==="upi"?"Check the money has arrived in your UPI app, then complete the sale.":"Complete the sale once the card machine says approved."}</p>`;
}
function liveHTML(D){
  const s=store.payState, a=allocations(), P=paymentProgress(D,a), S=settlePayments(D,a);
  const change=S.ok?S.change:P.change;
  return `<div class="paylive"><div><span>Paid</span><b data-paypaid>${inrx(P.paid)}</b></div><div><span>Balance</span><b data-paybal class="${P.balance?"due":""}">${inrx(P.balance)}</b></div><div><span>Change</span><b data-paychange>${inrx(change)}</b></div></div>`+
    `<p class="err" id="payErr" role="alert"${S.ok&&!s.err?" hidden":""}>${esc(S.ok?s.err:S.error)}</p>`;
}
export function renderPayment(focus){
  const s=store.payState; if(!s||!store.cart.length){closeModal();return}
  const T=billTotals(store.cart,store.disc), D=T.total, pcs=cartPcs(), c=store.cartCust;
  const modes=[...PAY_METHODS.map(m=>[m,PAY_LABELS[m]]),["split","Split"]], cur=s.mode==="split"?"split":s.method;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet paysheet" id="paySheet" role="dialog" aria-modal="true" aria-labelledby="payT">
    <div class="sh-head"><div class="sh-t"><h3 id="payT">Payment</h3><p>Bill #${billNo()} · ${pcs} piece${pcs===1?"":"s"} · ${c&&c.name?esc(c.name):"Walk-in"}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="paysum">${sumRow("Subtotal",inr(T.sub))}${T.disc?discountRowsHTML(T,store.disc):sumRow("Discount",inr(0),"muted")}${gstRowsHTML(T)}${roundRowHTML(T)}
      <div class="row tot"><span>Grand total</span><span class="grand" data-paydue>${inr(D)}</span></div></div>
    <div class="seg paymodes" role="group" aria-label="Payment method">${modes.map(([k,l])=>`<button type="button" data-paymode="${k}" aria-pressed="${cur===k}">${l}</button>`).join("")}</div>
    <div class="payfields">${fieldsHTML(D)}</div>
    <div id="payLive">${liveHTML(D)}</div>
    <button class="btn primary gbtn" data-act="paydone" id="payDone"${settlePayments(D,allocations()).ok?"":" disabled"}>Complete sale · ${inr(D)}</button>
  </div></div>`;
  if(focus){const f=$("#paySheet [data-payf]")||$("#payDone");if(f)f.focus({preventScroll:true})}
}
/* A field changed: keep the value, redraw the figures and the button only (the box keeps its cursor) */
export function payInput(t){
  const s=store.payState; if(!s) return;
  const f=t.dataset.payf, [k,m]=f.split(":");
  if(k==="recv") s.recv=t.value; else if(k==="ref") s.ref[m]=t.value; else if(k==="amt") s.amt[m]=t.value;
  s.err=""; updatePayLive();
}
function updatePayLive(){
  const D=due(), live=$("#payLive"), b=$("#payDone");
  if(live) live.innerHTML=liveHTML(D);
  if(b) b.disabled=!settlePayments(D,allocations()).ok;
}
export function payMode(k){
  const s=store.payState; if(!s) return;
  if(k==="split"){ if(s.mode!=="split"){ s.mode="split"; if(!PAY_METHODS.some(m=>String(s.amt[m]).trim()))s.amt[s.method]=String(due()); } }
  else { s.mode="single"; s.method=k; }
  s.err=""; renderPayment(true);
}
/* "Rest": this method takes whatever is still due */
export function payRest(m){
  const s=store.payState; if(!s) return;
  const others=PAY_METHODS.filter(x=>x!==m).reduce((a,x)=>a+Math.max(0,toPaise(s.amt[x])),0), left=toPaise(due())-others;
  s.amt[m]=left>0?String(toRupees(left)):""; renderPayment(false);
  const i=$(`#paySheet [data-payf="amt:${m}"]`); if(i) i.focus({preventScroll:true});
}
export function payQuick(v){ const s=store.payState; if(!s) return; s.recv=String(v); renderPayment(false); }
/* Complete sale: records the bill with its payments, or shows why not */
export async function completePayment(){
  const s=store.payState; if(!s) return;
  const r=await checkout(allocations());
  if(r&&r.error){ s.err=r.error; updatePayLive(); return; }
  if(r) closeModal();
}
