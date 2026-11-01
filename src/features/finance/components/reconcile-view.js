// Reconciliation on Reports: UPI payments checked by hand that aren't confirmed yet, and money the provider received that
// isn't on any bill — an "unmatched receipt" (a QR paid after it was cancelled, or a different amount), to refund or
// allocate. A UPI payment checked by hand went straight to the shop's own UPI ID: the shop confirms it reached its
// account ("Received", after checking the bank or UPI app: the owner, or a role that sees the books — the database
// checks it and keeps who and when), or, with the shop's own gateway connected, it can be matched with the provider's
// records. Nothing here marks a payment verified by itself: only the payment-gateway function does, from the provider's
// own records.
import { PAY_LABELS, isUnverified, unverifiedPayments } from '../../../domain/sales/payments.js';
import { sumP, toPaise, toRupees } from '../../../domain/sales/paise.js';
import { D, invalidate } from '../../inventory/services/ledger.js';
import { dayBounds } from '../services/books-data.js';
import { gateway, loadPayConfig, verifyManualUpi } from '../../sales/use-cases/provider-payment.js';
import { store } from '../../../shared/state/store.js';
import { persistLocal } from '../../../shared/state/persistence.js';
import { toast } from '../../../shared/components/toast.js';
import { esc } from '../../../shared/dom.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';
import { ERROR_CODES, userMessage } from '../../../shared/errors/app-error.js';
import { use } from '../../../shared/di/services.js';
import { can } from '../../shop/services/access.js';
import { renderAll } from '../../../shared/ui/render.js';
import { refuse } from '../../shop/services/access.js';

const kv=(l,v,cls)=>`<div${cls?` class="${cls}"`:""}><span>${l}</span><b>${v}</b></div>`;
const when=t=>`${dayLab(dayKey(t))} · ${hhmm(t)}`;
const online=()=>!!store.sbClient&&store.sbStatus==="connected";
const RES={refunded:"Paid back",allocated:"Allocated to a bill"};

/* The bills of the period with UPI checked only by hand */
export function unverifiedBills(R){
  const {from,to}=dayBounds(R.from,R.to);
  return D().sales.filter(s=>s.t>=from&&s.t<=to&&isUnverified(s));
}
export function reconcileCardHTML(R){
  const bills=unverifiedBills(R), amt=toRupees(sumP(bills.flatMap(s=>unverifiedPayments(s).map(p=>toPaise(p.amount)))));
  const um=store.unmatched, open=(um||[]).filter(I=>!I.resolution||I.resolution==="open"), umAmt=toRupees(sumP(open.map(I=>toPaise(I.paidAmount))));
  const canCheck=online()&&store.payConfig&&store.payConfig.upi;
  const mayConfirm=can("view_reports")&&online();
  const list=bills.slice(0,20).map(s=>{const p=unverifiedPayments(s)[0];return `<div class="bkrow upi-row" data-upirow="${esc(s.id)}"><button type="button" class="bk-w link-row" data-billview="${esc(s.id)}"><b>${esc(s.no||"Bill")}</b><small>${esc(when(s.t))} · UPI ref ${esc(p.ref||"—")} · <span class="btag warn">Unverified</span></small></button><span class="bk-a in">${inrx(p.amount)}</span>${can("view_reports")?`<button type="button" class="btn xs" data-upiconfirm="${esc(s.id)}"${mayConfirm?"":" disabled"}>Received</button>`:""}</div>`}).join("");
  const umList=um==null?"":open.length?open.map(I=>`<div class="bkrow um" data-unmatched="${esc(I.id)}"><span class="bk-w"><b>${inrx(I.paidAmount)} by ${esc(PAY_LABELS[I.method]||I.method)}</b><small>${esc(when(I.t))} · ${I.paidAmount!==I.amount?`asked ${inrx(I.amount)}`:"after the QR / link was closed"} · ref ${esc(I.paymentId||I.reference)}</small></span>
      <span class="um-acts"><button class="btn xs" data-unm="refund:${esc(I.id)}">Refund</button><button class="btn xs" data-unm="refunded:${esc(I.id)}">Paid back</button><button class="btn xs" data-unm="allocated:${esc(I.id)}">Allocated</button></span></div>`).join("")
    :`<p class="note">No unmatched receipts.</p>`;
  const done=(um||[]).filter(I=>I.resolution&&I.resolution!=="open").slice(0,10).map(I=>`<div class="retline">${inrx(I.paidAmount)} · ${esc(when(I.t))} · ${esc(RES[I.resolution]||I.resolution)}</div>`).join("");
  return `<div class="bookkpis">${kv("UPI not verified",`${bills.length} · ${inrx(amt)}`,bills.length?"warn":"")}${kv("Unmatched receipts",um==null?"—":`${open.length} · ${inrx(umAmt)}`,open.length?"warn":"")}</div>
    ${bills.length?`<p class="note">UPI checked by hand on the customer's phone, paid straight to your UPI ID. Check each one in your bank or UPI app, then mark it <b>Received</b>${canCheck?" — or let Hangtag match it with your payment gateway's records":""}. Until then it counts as not verified.${can("view_reports")?"":" The owner, or someone who sees the books, confirms them."}</p><div class="bklist">${list}</div>`:`<p class="note">Every UPI payment in this period is verified or confirmed.</p>`}
    <div class="setactions">${bills.length&&canCheck?`<button class="btn xs" data-act="verifyupi">Check with the provider</button>`:""}<button class="btn xs" data-act="unmatched"${online()?"":" disabled"}>${um==null?"Show unmatched receipts":"Refresh unmatched receipts"}</button></div>
    ${um==null?"":`<h4 class="subh">Unmatched receipts</h4>${umList}${done?`<details><summary>Resolved</summary>${done}</details>`:""}`}`;
}
/* The shop confirms a hand-checked UPI payment reached its account, after checking its bank or UPI app. The database
   allows it only to the owner or a role that sees the books, keeps who and when, and never lets a phone undo it. */
export async function confirmUpiReceived(saleId){
  if(refuse("view_reports","confirm UPI payments")) return;
  const s=D().saleById[saleId], p=s&&unverifiedPayments(s)[0];
  if(!p) return;
  if(!online()){ toast("Connect to the internet to confirm a payment."); return; }
  if(!confirm(`Did ${inrx(p.amount)} by UPI${p.ref?` (ref ${p.ref})`:""} for ${s.no||"this bill"} reach your bank or UPI app?`)) return;
  try{
    const r=await use("cloud").confirmUpiPayment(p.id);
    if(r&&r.status==="not_found"){ toast("This bill isn't in the cloud yet. Try again once it has uploaded."); return; }
    if(r&&["confirmed","verified","recorded"].includes(r.status)){
      p.verification=r.status; if(r.confirmedAt) p.confirmedAt=r.confirmedAt;
      persistLocal(); invalidate(); renderAll();
      toast(r.already?"It was already confirmed.":`${inrx(p.amount)} by UPI confirmed.`);
      return;
    }
    toast("This bill is cancelled: its payment isn't confirmed.");
  }catch(e){
    toast(e&&e.code===ERROR_CODES.PERMISSION?"Only the owner, or a role that sees the books, can confirm a payment."
      :e&&e.code===ERROR_CODES.OUTDATED_DATABASE?"Confirming payments needs the latest database update (shop payments)."
      :userMessage(e,"Couldn't confirm it. Try again."));
  }
}
/* Asks the provider about every hand-checked UPI payment (their bills must be uploaded) */
export async function checkUnverified(quiet){
  await loadPayConfig();
  const n=await verifyManualUpi(D().sales);
  if(n){ persistLocal(); invalidate(); renderAll(); }
  if(!quiet) toast(n?`${n} UPI payment${n>1?"s":""} verified by the provider.`:"No new matches with the provider yet. Bills still uploading are checked later.");
  return n;
}
export async function loadUnmatched(){
  try{ store.unmatched=await gateway().unmatched(); }
  catch(e){ toast(userMessage(e,"Couldn't load unmatched receipts.")); }
  renderAll();
}
/* spec: "refund:<id>" (refunds it through the provider) · "refunded:<id>" (paid back another way) · "allocated:<id>" */
export async function resolveUnmatched(spec){
  // settling money moves it (a refund, paid back, added to a bill): the same permission as a refund (the function checks it)
  if(refuse("perform_return","settle unmatched payments")) return;
  const [resolution,id]=spec.split(":"), I=(store.unmatched||[]).find(x=>x.id===id);
  if(!I) return;
  const ask={refund:`Refund ${inrx(I.paidAmount)} to the customer through the payment provider?`,refunded:`Mark ${inrx(I.paidAmount)} as paid back to the customer (in cash or another way)?`,allocated:`Mark ${inrx(I.paidAmount)} as added to a bill?`}[resolution];
  if(!ask||!confirm(ask)) return;
  try{
    const N=await gateway().resolve({id,resolution});
    store.unmatched=store.unmatched.map(x=>x.id===id?N:x);
    toast(resolution==="refund"?"Refund started at the payment provider.":"Receipt marked as resolved.");
  }catch(e){ toast(userMessage(e,"That couldn't be done. Try again.")); }
  renderAll();
}
