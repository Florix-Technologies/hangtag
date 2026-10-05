// Payment screen: the bill's figures (subtotal, discount, taxable amount, GST, grand total), then how it's paid —
// cash (with the amount received and the change), UPI or card, or split over them.
// UPI: a verified QR for the exact amount through the payment provider (the bill completes by itself when the provider
// confirms the money), or — without a provider, offline, or when it can't be reached — checked by hand with the shop's
// own UPI QR and the transaction reference (recorded as "Unverified"). Card: the card machine's reference (and at most
// the last 4 digits), or a verified card payment link the customer opens on their phone.
// Credit: some now (cash, UPI, card, or several), the rest — or all of it — left on a saved customer's account (collected
// later from the customer's page); needs collect_credit.
// The sale completes only when the payments add up to the grand total (domain/sales/payments.js).
import { DUE, INTENT_LABELS, PAY_LABELS, PAY_METHODS, PROVIDER_VIA, VOUCHER, paymentProgress, settlePayments } from '../../../domain/sales/payments.js';
import { trackSaleLines } from '../../inventory/services/tracking.js';
import { toPaise, toRupees } from '../../../domain/sales/paise.js';
import { upiPayUri } from '../../../domain/sales/upi.js';
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { billTotals } from '../services/totals.js';
import { cartPcs } from '../services/cart.js';
import { billNo } from '../services/sales-log.js';
import { billDiscountError } from '../use-cases/discounts.js';
import { checkout } from '../use-cases/checkout.js';
import { autoOn, autoPlanForCustomer } from '../../delivery/use-cases/auto-delivery.js';
import { CHANNEL_LABELS } from '../../../domain/invoices/delivery.js';
import { abandonIntents, cancelIntent, checkIntent, isOpen, loadPayConfig, pendingPayState, persistPending, providerReady, startIntent } from '../use-cases/provider-payment.js';
import { discountRowsHTML, gstRowsHTML, roundRowHTML, sumRow } from './bill-summary.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { can, refuse } from '../../shop/services/access.js';
import { billIdForPayment } from '../use-cases/provider-payment.js';
import { releaseVoucher, useVoucher, usesVouchers } from '../../commerce/use-cases/vouchers.js';
import { progressHTML } from './checkout-steps.js';

const due=()=>billTotals(store.cart,store.disc).total;
/* A gift voucher taken for this bill (domain/sales/vouchers.js): it pays this much, the rest is paid as usual */
const vAmt=()=>{const s=store.payState;return s&&s.voucher&&s.voucher.redemption?+s.voucher.amount:0};
const rest=()=>toRupees(Math.max(0,toPaise(due())-toPaise(vAmt())));
const blankState=method=>({mode:"single",method:PAY_METHODS.includes(method)?method:"cash",recv:"",ref:{upi:"",card:""},last4:"",amt:{cash:"",upi:"",card:""},
  via:{upi:"manual",card:"terminal"},viaSet:{},pi:{},upiReceived:false,cardReceived:false,err:""});
/* store.payState = { mode: "single" | "split" | "credit" (the amounts in amt are paid now, the rest goes on account), method, recv (cash handed over), ref: { upi, card }, last4 (card), amt: { cash, upi, card },
     via: { upi: "manual"|"qr", card: "terminal"|"link" }, pi: { upi?, card? } (provider intents), saleId, err,
     flow: { customer, review } ("done" / "skipped": the checkout steps on the way here), guided (came through Review & pay) }
   opts.flow: from the guided checkout (sales/components/checkout-flow.js); without it (the bill's Cash / UPI / Card
   buttons, C / U / K) Customer and Review were skipped */
export function openPayment(method,opts={}){
  if(!store.cart.length||refuse("create_sale","take payments")) return;
  const bad=billDiscountError(); if(bad){ toast(bad); return; }
  // serial numbers chosen for every serial-tracked line, and enough unexpired batch stock (checked again when it completes)
  const tk=trackSaleLines(store.cart); if(tk.error){ toast(tk.error); return; }
  // a provider payment was still open for this bill when the app closed: show it again rather than start over
  if(store.payPending&&!store.payState&&resumePayment()) return;
  store.checkoutFlow=null;
  store.payState=Object.assign(blankState(method),{flow:opts.flow||{customer:"skipped",review:"skipped"},guided:!!opts.flow});
  preferProvider();
  renderPayment(true);
  const s=store.payState, before=JSON.stringify([providerReady("upi"),providerReady("card"),s.via]);
  loadPayConfig().then(()=>{ if(store.payState!==s) return; preferProvider(); if(JSON.stringify([providerReady("upi"),providerReady("card"),s.via])!==before) renderPayment(false); autoStart(); });
}
/* After a restart: a bill that was waiting for a provider payment opens again where it was */
export function resumePayment(){
  if(store.payState) return false;
  const s=pendingPayState();
  if(!s){ if(store.payPending&&!store.cart.length) abandonIntents({pi:store.payPending.pi}); return false; }
  store.payState=Object.assign(blankState(s.method),s);
  renderPayment(false); startPolling();
  toast("A payment was still open for this bill. Its status is shown again.");
  return true;
}
/* The verified way is the default wherever the provider can take it (unless the person chose otherwise) */
function preferProvider(){
  const s=store.payState;
  if(!s.viaSet.upi) s.via.upi=providerReady("upi")?"qr":"manual";
  if(!s.viaSet.card&&!providerReady("card")&&s.via.card==="link") s.via.card="terminal";
}
/* One method for the whole bill by UPI QR: the QR appears straight away */
function autoStart(){
  const s=store.payState;
  if(s&&s.mode==="single"&&s.method==="upi"&&s.via.upi==="qr"&&!s.pi.upi&&providerReady("upi")) startPart("upi");
}
/* The amount a part is for */
const partAmount=m=>{const s=store.payState;return s.mode!=="single"?+s.amt[m]||0:rest()};
/* Credit: the bill has a saved customer (only they can owe the shop) */
const savedCustomer=()=>{const c=store.cartCust;return !!(c&&c.id&&store.customers&&store.customers[c.id])};
/* Credit: what is left on account = the total less what is paid now (never below 0) */
function accountPart(D){
  const s=store.payState, now=PAY_METHODS.reduce((a,m)=>{const v=toPaise(s.amt[m]);return a+(Number.isFinite(v)&&v>0?v:0)},0)+toPaise(vAmt());
  return toRupees(Math.max(0,toPaise(D)-now));
}
/* The parts of the payment as typed, for domain/sales/payments.js */
export function allocations(){
  const s=store.payState, D=due();
  const part=(m,amount)=>({method:m,amount,received:m==="cash"?s.recv:undefined,ref:s.ref[m],via:m==="cash"?undefined:s.via[m],last4:m==="card"?s.last4:undefined,intent:s.pi[m],
    confirmed:m==="upi"&&s.via.upi==="manual"?!!s.upiReceived:m==="card"&&s.via.card==="terminal"?!!s.cardReceived:undefined});
  const v=s.voucher&&s.voucher.redemption?[{method:VOUCHER,amount:s.voucher.amount,voucher:s.voucher}]:[];
  if(s.mode==="single") return [...v,part(s.method,rest())];
  if(s.mode==="credit") return [...v,...PAY_METHODS.map(m=>part(m,s.amt[m])),{method:DUE,amount:accountPart(D)}];
  return [...v,...PAY_METHODS.map(m=>part(m,s.amt[m]))];
}
const quickCash=D=>[...new Set([100,500,2000].map(n=>Math.ceil((D+1)/n)*n))].filter(v=>v>D).slice(0,3);
const qr=(text,size)=>{try{return use("qrCodeService").render(text,{unit:"px",size,margin:2})}catch{return ""}};
const inp=(f,label,val,extra)=>`<label class="f"><span class="lab">${label}</span><input data-payf="${f}" value="${esc(val)}" autocomplete="off" ${extra}></label>`;
const money='type="number" inputmode="decimal" min="0" step="any"';
const left=I=>{const ms=(I.expiresAt||0)-Date.now();if(!(ms>0))return "closing…";const t=Math.ceil(ms/1000);return `closes in ${Math.floor(t/60)}:${String(t%60).padStart(2,"0")}`};

/* How a UPI / card part is taken */
function viaHTML(m){
  const s=store.payState, can=providerReady(m)||isOpen(s.pi[m])||(s.pi[m]&&s.pi[m].status==="verified");
  const opts=m==="upi"?[["qr","Verified QR"],["manual","Check by hand"]]:[["terminal","Card machine"],["link","Card link"]];
  if(!can){
    const setUp=store.payConfig&&(m==="upi"?store.payConfig.upi:store.payConfig.cardLink);
    return m==="upi"?`<p class="note pi-off">${setUp?"Verification unavailable (offline): check the payment by hand.":"Verified UPI isn't set up for this shop: check the payment by hand."}</p>`:"";
  }
  return `<div class="seg payvia" role="group" aria-label="${PAY_LABELS[m]} by">${opts.map(([k,l])=>`<button type="button" data-payvia="${m}:${k}" aria-pressed="${s.via[m]===k}">${l}</button>`).join("")}</div>`;
}
/* A provider payment: QR / link, its state, and what can be done now */
function intentHTML(m){
  const s=store.payState, I=s.pi[m], what=m==="upi"?"QR":"link", amt=partAmount(m);
  if(!I) return `<button type="button" class="btn primary" data-payintent="start:${m}">${m==="upi"?"Show UPI QR":"Show card payment link"}${amt>0?" · "+inr(amt):""}</button>`;
  const acts=(...b)=>`<div class="pi-acts">${b.join("")}</div>`, again=`<button type="button" class="btn sm" data-payintent="start:${m}">New ${what}</button>`,
    byHand=`<button type="button" class="btn sm" data-payvia="${m}:${m==="upi"?"manual":"terminal"}">${m==="upi"?"Check by hand":"Use the card machine"}</button>`;
  if(I.status==="starting") return `<div class="pi-box" data-pistate="starting"><p class="pi-st">Creating the ${what} for ${inrx(I.amount)}…</p></div>`;
  if(I.status==="error") return `<div class="pi-box bad" data-pistate="error"><p class="pi-st">Verification unavailable</p><p class="note">${esc(I.error)}</p>${acts(`<button type="button" class="btn sm" data-payintent="start:${m}">Try again</button>`,byHand)}</div>`;
  if(I.status==="pending"){
    const pic=m==="upi"?(I.qrUrl?`<img src="${esc(I.qrUrl)}" alt="UPI QR code for ${esc(inrx(I.amount))}" width="240" height="240">`:qr(I.reference,220)):qr(I.linkUrl||"",220);
    return `<div class="pi-box" data-pistate="pending"><div class="pi-qr">${pic}</div>
      <p class="pi-st"><span class="pi-chip">Payment pending</span> ${inrx(I.amount)} · <span data-picount>${left(I)}</span></p>
      <p class="note">${m==="upi"?"The customer scans this with any UPI app. The bill completes by itself once the payment is confirmed.":`The customer scans this with their phone camera and pays by card on the page it opens.${I.linkUrl?` Link: <b>${esc(I.linkUrl)}</b>`:""}`}</p>
      ${I.checkError?`<p class="note">${esc(I.checkError)}</p>`:""}${acts(`<button type="button" class="btn sm" data-payintent="check:${m}">Check now</button>`,`<button type="button" class="btn sm" data-payintent="cancel:${m}">Cancel ${what}</button>`)}</div>`;
  }
  if(I.status==="verified") return `<div class="pi-box ok" data-pistate="verified"><p class="pi-st">✓ ${INTENT_LABELS.verified} · ${inrx(I.paidAmount==null?I.amount:I.paidAmount)}</p><p class="note">Verified by the payment provider · ref ${esc(I.paymentId||I.reference)}${I.providerFee==null?'':` · provider fee ${inrx(I.providerFee)}`}</p></div>`;
  if(I.status==="unmatched") return `<div class="pi-box bad" data-pistate="unmatched"><p class="pi-st">${inrx(I.paidAmount)} arrived, not ${inrx(I.amount)}</p><p class="note">It isn't used on this bill. It's kept under Books → Unmatched receipts to refund or allocate.</p>${acts(again,byHand)}</div>`;
  return `<div class="pi-box bad" data-pistate="${esc(I.status)}"><p class="pi-st">${esc(INTENT_LABELS[I.status]||I.status)}</p><p class="note">Nothing was received for this ${what}.</p>${acts(again,byHand)}</div>`;
}
/* UPI checked by hand: show the shop's QR, then require the cashier's explicit confirmation; UTR is useful but optional. */
function manualUpiHTML(amount,split){
  const s=store.payState, vpa=store.settings.upiId, uri=upiPayUri({vpa,name:store.profile&&store.profile.shop_name||"Shop",amount,note:"Bill "+billNo()});
  return (uri&&amount>0?`<div class="pi-qr small">${qr(uri,180)}</div><p class="note">Pay to <b>${esc(vpa)}</b> · ${inrx(amount)}</p>`:!vpa?`<p class="note">Add your shop's UPI ID in Settings → Payments &amp; Banks to show the payment QR here.</p>`:split?`<p class="note">Enter the UPI amount to show its QR.</p>`:"")+
    `<button type="button" class="btn block ${s.upiReceived?"ok":"primary"}" data-upireceived aria-pressed="${s.upiReceived}"${amount>0?"":" disabled"}>${s.upiReceived?"✓ UPI payment marked received":"Mark UPI payment received"}</button>`+
    inp("ref:upi",`UPI reference (UTR) <small>(optional)</small>`,s.ref.upi,'maxlength="40" autocomplete="off"')+
    `<p class="note">Check the customer's successful payment screen before marking it received. It is saved as <b>Unverified</b> for reconciliation${split?".":" until it is matched with the UPI records."}</p>`;
}
/* Card on the shop's own card machine: marked received once the machine approves it; its approval number and the card's last
   4 digits are optional. Never the card number, CVV or PIN. */
function terminalHTML(split){
  const s=store.payState, amount=partAmount("card");
  return `<button type="button" class="btn block ${s.cardReceived?"ok":"primary"}" data-cardreceived aria-pressed="${s.cardReceived}"${amount>0?"":" disabled"}>${s.cardReceived?"✓ Card payment marked received":"Mark card payment received"}</button>`+
    `<div class="pgrid2">${inp("ref:card","Approval / transaction no. <small>(optional)</small>",s.ref.card,'maxlength="40" autocomplete="off"')}${inp("last4","Last 4 digits <small>(optional)</small>",s.last4,'inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="off"')}</div>`+
    (split?"":`<p class="note">Mark it received once the card machine says approved. Never type the card number, CVV or PIN.</p>`);
}
function partHTML(m,split){
  const s=store.payState;
  if(m==="upi") return viaHTML("upi")+(s.via.upi==="qr"&&(providerReady("upi")||s.pi.upi)?`<div data-pipart="upi">${intentHTML("upi")}</div>`:manualUpiHTML(partAmount("upi"),split));
  return viaHTML("card")+(s.via.card==="link"?`<div data-pipart="card">${intentHTML("card")}</div>`:terminalHTML(split));
}
/* Credit: the customer it goes on, and what is paid now (every amount may stay empty: nothing now) */
function creditHTML(D){
  const s=store.payState, c=store.cartCust;
  const who=savedCustomer()?`<p class="note paycred">On <b>${esc(c.name)}</b>'s account: <b data-payacct>${inrx(accountPart(D))}</b>. Enter what they pay now, if anything.</p>`
    :`<p class="note paycred bad">Only a saved customer can pay later. <button type="button" class="btn xs" data-paycust>Choose the customer</button></p>`;
  return who+`<div class="splitrows">${PAY_METHODS.map(m=>{const lock=PROVIDER_VIA.includes(s.via[m])&&s.pi[m]&&(isOpen(s.pi[m])||s.pi[m].status==="verified");
    return `<div class="splitrow"><span class="spl">${PAY_LABELS[m]} now</span><input data-payf="amt:${m}" value="${esc(s.amt[m])}" ${money} placeholder="0" aria-label="${PAY_LABELS[m]} paid now"${lock?" readonly":""}></div>`
      +(m==="cash"?inp("recv","Cash received <small>(optional, for change)</small>",s.recv,money+' placeholder="Same as cash"'):`<div class="splitpart">${partHTML(m,true)}</div>`)}).join("")}</div>`;
}
/* A gift voucher: its code (typed or scanned) takes up to what is due off the voucher; the rest is paid below */
function voucherHTML(){
  if(!usesVouchers()) return "";
  const s=store.payState, v=s.voucher;
  if(v&&v.redemption) return `<div class="disc-row paygv"><span><b>Gift voucher ···${esc(String(v.code).slice(-4))}</b><small>pays ${inrx(v.amount)} · ${inrx(v.balance)} left on it</small></span><button type="button" class="btn xs" data-payvoucherrm>Remove</button></div>`;
  return `<div class="payvoucher"><input id="payVoucher" placeholder="Gift voucher code" autocomplete="off" aria-label="Gift voucher code" value="${esc(v&&v.code||"")}"><button type="button" class="btn sm" data-payvoucher${v&&v.busy?" disabled":""}>${v&&v.busy?"Checking…":"Use voucher"}</button></div>${v&&v.err?`<p class="note bad">${esc(v.err)}</p>`:""}`;
}
function fieldsHTML(D){
  return voucherHTML()+fieldsBodyHTML(D);
}
function fieldsBodyHTML(D){
  const s=store.payState, R=rest();
  if(s.mode==="credit") return creditHTML(D);
  if(s.mode==="split") return `<div class="splitrows">${PAY_METHODS.map(m=>{const lock=PROVIDER_VIA.includes(s.via[m])&&s.pi[m]&&(isOpen(s.pi[m])||s.pi[m].status==="verified");
    return `<div class="splitrow"><span class="spl">${PAY_LABELS[m]}</span><input data-payf="amt:${m}" value="${esc(s.amt[m])}" ${money} placeholder="0" aria-label="${PAY_LABELS[m]} amount"${lock?" readonly":""}><button type="button" class="btn xs" data-payrest="${m}"${lock?" disabled":""}>Rest</button></div>`
      +(m==="cash"?inp("recv","Cash received <small>(optional, for change)</small>",s.recv,money+' placeholder="Same as cash"'):`<div class="splitpart">${partHTML(m,true)}</div>`)}).join("")}</div>`;
  if(s.method==="cash") return inp("recv","Amount received",s.recv,`${money} placeholder="${esc(inr(R))} (exact)"`)+
    `<div class="quick">${quickCash(R).map(v=>`<button type="button" class="chip" data-payquick="${v}">${inr(v)}</button>`).join("")}</div>`;
  return partHTML(s.method,false);
}
/* "Send receipt" for this sale (on by default when a channel is turned on and the customer can get it) */
function sendHTML(){
  const s=store.payState, c=store.cartCust;
  if(!autoOn()||!c||!c.name) return "";
  const plan=autoPlanForCustomer(c);
  if(!plan.length) return `<p class="note">The receipt can't go out by itself: ${esc(c.name)} has no mobile number or email for the channels turned on.</p>`;
  return `<label class="chk paysend"><input type="checkbox" data-paysend${s.send!==false?" checked":""}> Send the receipt to ${esc(c.name)} by ${plan.map(p=>CHANNEL_LABELS[p.channel]+(p.fallback?" (SMS if it fails)":"")).join(" and ")}</label>`;
}
function liveHTML(D){
  const s=store.payState, a=allocations(), P=paymentProgress(D,a), S=settlePayments(D,a,{customer:savedCustomer()});
  const change=S.ok?S.change:P.change, waiting=S.field==="intent"&&Object.values(s.pi).some(isOpen);
  const mid=s.mode==="credit"?`<div><span>On account</span><b data-payacct>${inrx(P.onAccount||0)}</b></div>`:`<div><span>Balance</span><b data-paybal class="${P.balance?"due":""}">${inrx(P.balance)}</b></div>`;
  return `<div class="paylive"><div><span>${s.mode==="credit"?"Paid now":"Paid"}</span><b data-paypaid>${inrx(P.paid)}</b></div>${mid}<div><span>Change</span><b data-paychange>${inrx(change)}</b></div></div>`+
    `<p class="err${waiting?" wait":""}" id="payErr" role="alert"${S.ok&&!s.err?" hidden":""}>${esc(S.ok?s.err:S.error)}</p>`;
}
export function renderPayment(focus){
  const s=store.payState; if(!s||!store.cart.length){closeModal();return}
  const T=billTotals(store.cart,store.disc), D=T.total, pcs=cartPcs(), c=store.cartCust;
  const modes=[...PAY_METHODS.map(m=>[m,PAY_LABELS[m]]),["split","Split"],...(can("collect_credit")?[["credit","Credit"]]:[])], cur=s.mode==="single"?s.method:s.mode;
  const scroll=$("#paySheet")?$("#paySheet").scrollTop:0;
  // a redraw keeps the box being typed in (and its cursor)
  const act=document.activeElement, keep=act&&act.closest&&act.closest("#paySheet")?(act.dataset&&act.dataset.payf?`[data-payf="${act.dataset.payf}"]`:act.id?"#"+act.id:null):null;
  const sel=keep&&act.selectionStart!=null?[act.selectionStart,act.selectionEnd]:null;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet paysheet" id="paySheet" role="dialog" aria-modal="true" aria-labelledby="payT">
    ${progressHTML("payment",s.flow||{customer:"skipped",review:"skipped"})}
    <div class="sh-head"><div class="sh-t"><h3 id="payT">Payment</h3><p>Bill ${esc(billNo())} · ${pcs} piece${pcs===1?"":"s"} · ${c&&c.name?esc(c.name):"Walk-in"}</p></div>${s.guided?`<button type="button" class="btn sm" data-checkoutback>Back</button>`:""}<button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="paysum">${sumRow("Subtotal",inr(T.sub))}${T.disc?discountRowsHTML(T,store.disc):sumRow("Discount",inr(0),"muted")}${gstRowsHTML(T)}${roundRowHTML(T)}
      <div class="row tot"><span>Grand total</span><span class="grand" data-paydue>${inr(D)}</span></div></div>
    <div class="seg paymodes" role="group" aria-label="Payment method">${modes.map(([k,l])=>`<button type="button" data-paymode="${k}" aria-pressed="${cur===k}">${l}</button>`).join("")}</div>
    <div class="payfields">${fieldsHTML(D)}</div>
    <div id="payLive">${liveHTML(D)}</div>
    ${sendHTML()}
    <button class="btn primary gbtn" data-act="paydone" id="payDone"${settlePayments(D,allocations(),{customer:savedCustomer()}).ok?"":" disabled"}>Complete sale · ${inr(D)}</button>
  </div></div>`;
  const sh=$("#paySheet"); if(sh&&scroll) sh.scrollTop=scroll;
  if(focus){const f=$("#paySheet [data-payf]")||$("#payDone");if(f)f.focus({preventScroll:true})}
  else if(keep){const f=$("#paySheet "+keep);if(f){f.focus({preventScroll:true});if(sel&&f.setSelectionRange)try{f.setSelectionRange(sel[0],sel[1])}catch{/* not a text box */}}}
}
/* A field changed: keep the value, redraw the figures and the button only (the box keeps its cursor) */
export function payInput(t){
  const s=store.payState; if(!s) return;
  const f=t.dataset.payf, [k,m]=f.split(":");
  if(k==="recv") s.recv=t.value; else if(k==="ref") s.ref[m]=t.value; else if(k==="last4") s.last4=t.value.replace(/\D/g,"").slice(0,4); else if(k==="amt"){ s.amt[m]=t.value; if(m==="upi") s.upiReceived=false; if(m==="card") s.cardReceived=false; }
  if(k==="last4"&&t.value!==s.last4) t.value=s.last4;
  s.err=""; updatePayLive();
}
function updatePayLive(){
  const D=due(), live=$("#payLive"), b=$("#payDone");
  if(live) live.innerHTML=liveHTML(D);
  if(b) b.disabled=!settlePayments(D,allocations(),{customer:savedCustomer()}).ok;
  const acct=$("#paySheet .paycred [data-payacct]"); if(acct) acct.textContent=inrx(accountPart(D));
}
export function payMode(k){
  const s=store.payState; if(!s) return;
  if((s.mode==="single"?s.method:s.mode)!==k) s.upiReceived=false;
  if(k==="split"){ if(s.mode!=="split"){ s.mode="split"; if(!PAY_METHODS.some(m=>String(s.amt[m]).trim()))s.amt[s.method]=String(rest()); } }
  // credit: nothing paid now unless amounts are typed (amounts carried over from split that pay it all are cleared)
  else if(k==="credit"){ if(s.mode!=="credit"){ if(accountPart(due())<=0) PAY_METHODS.forEach(m=>{ if(!isOpen(s.pi[m])&&!(s.pi[m]&&s.pi[m].status==="verified")) s.amt[m]=""; }); s.mode="credit"; } }
  else {
    // leaving a part that has an open provider payment for another method closes it
    Object.keys(s.pi).forEach(m=>{ if(m!==k&&isOpen(s.pi[m])) cancelPart(m,true); });
    s.mode="single"; s.method=k;
  }
  s.err=""; renderPayment(true); autoStart();
}
/* Verified or by hand, for a UPI / card part */
export function payVia(spec){
  const s=store.payState; if(!s) return;
  const [m,v]=spec.split(":"); if(!s.via[m]) return;
  if(s.via[m]!==v&&isOpen(s.pi[m])) cancelPart(m,true);
  if(m==="upi"&&s.via[m]!==v) s.upiReceived=false;
  s.via[m]=v; s.viaSet[m]=true; s.err="";
  renderPayment(false); autoStart();
}
/* "Rest": this method takes whatever is still due */
export function payRest(m){
  const s=store.payState; if(!s) return;
  const others=PAY_METHODS.filter(x=>x!==m).reduce((a,x)=>a+Math.max(0,toPaise(s.amt[x])),0)+toPaise(vAmt()), left=toPaise(due())-others;
  s.amt[m]=left>0?String(toRupees(left)):""; if(m==="upi") s.upiReceived=false; if(m==="card") s.cardReceived=false; renderPayment(false);
  const i=$(`#paySheet [data-payf="amt:${m}"]`); if(i) i.focus({preventScroll:true});
}
export function paySend(on){ const s=store.payState; if(s) s.send=!!on; }
export function payQuick(v){ const s=store.payState; if(!s) return; s.recv=String(v); renderPayment(false); }
export function payManualUpiReceived(){ const s=store.payState; if(!s||s.via.upi!=="manual"||!(partAmount("upi")>0)) return; s.upiReceived=true; s.err=""; renderPayment(false); }
/* The card machine approved the card part: it counts as received (its reference stays optional) */
export function payCardReceived(){ const s=store.payState; if(!s||s.via.card!=="terminal"||!(partAmount("card")>0)) return; s.cardReceived=true; s.err=""; renderPayment(false); }

/* ---------- provider payments: start, watch, cancel ---------- */
let pollT=null, tick=0;
function stopPolling(){ if(pollT){ clearInterval(pollT); pollT=null; } }
function startPolling(){
  stopPolling(); tick=0;
  pollT=setInterval(async()=>{
    const s=store.payState;
    if(!s||!$("#paySheet")||!Object.values(s.pi).some(I=>I&&I.id&&isOpen(I))){ stopPolling(); return; }
    $("#paySheet").querySelectorAll("[data-picount]").forEach(el=>{const m=el.closest("[data-pipart]");const I=m&&s.pi[m.dataset.pipart];if(I)el.textContent=left(I)});
    if(++tick%3) return;
    for(const m of Object.keys(s.pi)){
      const before=s.pi[m]&&s.pi[m].status;
      if(!isOpen(s.pi[m])) continue;
      const I=await checkIntent(m);
      if(store.payState!==s) return;
      if(I&&I.status!==before) onIntentChange(m);
    }
  },1000);
}
function onIntentChange(m){
  const s=store.payState, I=s&&s.pi[m]; if(!I) return;
  renderPayment(false);
  if(I.status==="verified"){
    toast(`${PAY_LABELS[m]} payment received and verified.`);
    // the provider's payment pays the whole bill: it completes now, with no tap needed
    if(s.mode==="single"||toPaise(I.amount)===toPaise(due())) completePayment();
  }else if(I.status==="expired") toast(`The ${m==="upi"?"QR":"link"} expired before the payment arrived.`);
}
export async function startPart(m){
  const s=store.payState; if(!s) return;
  const amt=partAmount(m);
  if(!(amt>0)){ s.err=`Enter the ${PAY_LABELS[m]} amount first.`; updatePayLive(); return; }
  s.via[m]=m==="upi"?"qr":"link";
  const p=startIntent(m,amt); renderPayment(false);
  const r=await p;
  if(store.payState!==s) return;
  renderPayment(false);
  if(r&&r.status==="verified") onIntentChange(m);
  else if(r&&r.id) startPolling();
}
async function cancelPart(m,quiet){
  const s=store.payState; if(!s) return;
  const r=await cancelIntent(m);
  if(store.payState!==s) return;
  if(r&&r.status==="verified"){ toast(`The ${PAY_LABELS[m]} payment had already arrived, so it's kept on this bill.`); onIntentChange(m); return; }
  if(!quiet) toast(r&&r.error?r.error:`${m==="upi"?"QR":"Link"} cancelled.`);
  renderPayment(false);
}
export async function payIntent(spec){
  const s=store.payState; if(!s) return;
  const [act,m]=spec.split(":");
  if(act==="start") return startPart(m);
  if(act==="cancel") return cancelPart(m,false);
  if(act==="check"){ const before=s.pi[m]&&s.pi[m].status; await checkIntent(m); if(store.payState!==s) return; if(s.pi[m]&&s.pi[m].status!==before) onIntentChange(m); else renderPayment(false); }
}
/* "Use voucher": the code is checked and the amount taken off the voucher for this bill (online) */
export async function payVoucher(){
  const s=store.payState; if(!s) return;
  const i=$("#payVoucher"), code=i?i.value:"";
  s.voucher={code,busy:true}; renderPayment(false);
  const r=await useVoucher(code,due(),billIdForPayment());
  if(store.payState!==s) return;
  s.voucher=r.error?{code,err:r.error}:r.voucher; s.err="";
  renderPayment(false);
  if(!r.error) toast(`Gift voucher pays ${inrx(r.voucher.amount)}.${toPaise(rest())>0?" Pay the rest below.":""}`);
}
export async function payVoucherRemove(){
  const s=store.payState; if(!s||!s.voucher) return;
  const r=await releaseVoucher(s.saleId); if(store.payState!==s) return;
  if(r&&r.error){ s.err=r.error; updatePayLive(); return; }
  s.voucher=null; renderPayment(false);
}
/* The sheet was closed without completing: open QRs / links are closed at the provider */
export function payClosed(){
  const s=store.payState; stopPolling();
  if(!s) return;
  // a voucher taken for a bill that wasn't completed gets its amount back
  if(s.voucher&&s.voucher.redemption&&s.saleId) releaseVoucher(s.saleId);
  const kept=Object.entries(s.pi||{}).filter(([,I])=>I&&I.id&&I.status==="verified");
  abandonIntents(s,{keepVerified:true});
  // money the provider already confirmed is never dropped: it stays with this bill until the sale is completed
  if(kept.length) toast(`${kept.map(([m,I])=>`${PAY_LABELS[m]} ${inrx(I.paidAmount==null?I.amount:I.paidAmount)}`).join(" + ")} already received for this bill is kept. Open Pay again to complete the sale.`);
}
/* Complete sale: records the bill with its payments, or shows why not */
export async function completePayment(){
  const s=store.payState; if(!s) return;
  if(Object.entries(s.pi).some(([m,I])=>isOpen(I)&&allocations().some(a=>a.method===m&&+a.amount>0&&PROVIDER_VIA.includes(a.via)))){ s.err="Wait for the payment to be confirmed, or cancel it first."; updatePayLive(); return; }
  const alloc=allocations().filter(a=>+a.amount>0), onBill=m=>alloc.some(a=>a.method===m&&PROVIDER_VIA.includes(a.via));
  const unused=Object.fromEntries(Object.entries(s.pi).filter(([m,I])=>isOpen(I)&&!onBill(m)));
  // money the provider confirmed that this bill doesn't use: said out loud, and listed later as an unmatched receipt
  const leftOver=Object.entries(s.pi).filter(([m,I])=>I&&I.status==="verified"&&!onBill(m));
  if(leftOver.length&&!confirm(`${leftOver.map(([m,I])=>`${PAY_LABELS[m]} ${inrx(I.paidAmount==null?I.amount:I.paidAmount)}`).join(" + ")} was received through the provider but isn't used on this bill. It will be listed under unmatched receipts to refund. Complete the sale anyway?`)) return;
  const r=await checkout(allocations(),{id:s.saleId,send:s.send!==false});
  if(r&&r.error){ s.err=r.error; updatePayLive(); return; }
  if(r){ stopPolling(); persistPending(); closeModal(); if(Object.keys(unused).length) abandonIntents({pi:unused}); }
}
