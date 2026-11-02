// A customer's account on their profile: total purchases, total paid, what they owe, the history of bills left on account,
// refunds to the account and payments collected, and "Collect payment" (the CollectPayment use case).
// store.collectForm = { cid, amount, method, ref, note, err, field } while the collect sheet is open.
import { collectionLabel } from '../../../domain/customers/credit.js';
import { PAY_LABELS, PAY_METHODS } from '../../../domain/sales/payments.js';
import { store } from '../../../shared/state/store.js';
import { accountOf } from '../services/customer-account.js';
import { customerRepository } from '../repositories/customer-repository.js';
import { creditRepository } from '../repositories/credit-repository.js';
import { cancelCollection, collectPayment } from '../use-cases/collect-payment.js';
import { isMember } from '../../shop/services/access.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

const KIND = { bill: "Bill", refund: "Refund to account", collection: "Payment" };
function entryHTML(e){
  const what = e.kind === "collection" ? `${KIND.collection} · ${esc(collectionLabel(e))}` : e.kind === "refund" ? `${KIND.refund}${e.no ? " · " + esc(e.no) : ""}${e.billNo ? " (bill " + esc(e.billNo) + ")" : ""}` : `${KIND.bill} ${esc(e.no || "")}`;
  const amt = e.kind === "bill" ? (e.charge ? `+${inrx(e.charge)} on account` : `${inrx(e.amount)} paid`) : `−${inrx(e.amount)}`;
  const off = e.status === "cancelled";
  return `<div class="acent${off ? " off" : ""}" data-acent="${esc(e.id)}"><span class="ae-w"><b>${what}</b><small>${esc(dayLab(dayKey(e.t)))} · ${esc(hhmm(e.t))}${off ? " · cancelled" : ""}${e.kind === "bill" && e.charge && e.paid ? " · " + inrx(e.paid) + " paid" : ""}</small></span>
    <span class="ae-a tnum">${amt}<small>owes ${inrx(e.balance)}</small></span>${e.kind === "collection" && !off && !isMember() ? `<button class="link xs" data-colcancel="${esc(e.id)}">Cancel</button>` : ""}${e.saleId && e.kind === "bill" ? `<button class="link xs" data-billview="${esc(e.saleId)}">Bill</button>` : ""}</div>`;
}
/* The account block of a customer's profile: what was taken on account, refunded to it and collected (the totals and
   Collect payment are in the profile's summary: components/customer-insight-view.js) */
export function accountHTML(cid){
  const hist = accountOf(cid).entries.filter(e => e.kind !== "bill" || e.charge > 0);   // bills paid in full are in the purchase history
  return hist.length ? `<h4 class="custh">Account</h4><div class="acents">${hist.map(entryHTML).join("")}</div>` : "";
}

/* ---------- collect a payment ---------- */
export function openCollectForm(cid){
  const c = customerRepository().get(cid); if(!c) return;
  const A = accountOf(cid);
  store.collectForm = { cid, amount: A.outstanding > 0 ? String(A.outstanding) : "", method: "cash", ref: "", note: "", err: "", field: "" };
  renderCollectForm(true);
}
export function renderCollectForm(focus){
  const F = store.collectForm; if(!F) return;
  const c = customerRepository().get(F.cid), A = accountOf(F.cid);
  $("#modalHost").innerHTML = `<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-labelledby="colT">
    <div class="sh-head"><div class="sh-t"><h3 id="colT">Collect payment</h3><p>${esc(c ? c.name : "")} owes <b>${inrx(A.outstanding)}</b></p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <form id="collectForm" novalidate>
      <label class="f"><span class="lab">Amount received</span><input id="colAmount" name="amount" value="${esc(F.amount)}" type="number" inputmode="decimal" min="0" step="any" autocomplete="off"${F.field === "amount" ? ' aria-invalid="true"' : ""}></label>
      <div class="seg" role="group" aria-label="Paid by">${PAY_METHODS.map(m => `<button type="button" data-colmethod="${m}" aria-pressed="${F.method === m}">${PAY_LABELS[m]}</button>`).join("")}</div>
      ${F.method !== "cash" ? `<label class="f"><span class="lab">${F.method === "upi" ? "UPI reference (UTR)" : "Card machine reference"}</span><input id="colRef" name="ref" value="${esc(F.ref)}" maxlength="40" autocomplete="off"${F.field === "ref" ? ' aria-invalid="true"' : ""}></label>` : ""}
      <label class="f"><span class="lab">Note <small>(optional)</small></span><input id="colNote" name="note" value="${esc(F.note)}" maxlength="200" autocomplete="off"></label>
      <p class="err" id="colErr" role="alert"${F.err ? "" : " hidden"}>${esc(F.err)}</p>
      <p class="note">${F.method === "cash" ? "Goes into the cash book, like cash on a bill." : F.method === "upi" ? "Goes into the bank book as UPI, marked Unverified until it's matched." : "Goes into the bank book as card."}</p>
      <div class="setactions"><button type="button" class="btn sm" data-custhist="${esc(F.cid)}">Back</button><button type="submit" class="btn sm primary">Record ${inr(+F.amount || 0)}</button></div>
    </form></div></div>`;
  if(focus){ const i = $("#colAmount"); if(i) i.focus({ preventScroll: true }); }
}
/* Typing in the collect sheet → true when handled */
export function collectInput(t){
  const F = store.collectForm; if(!F || !t.closest || !t.closest("#collectForm")) return false;
  if(t.id === "colAmount"){ F.amount = t.value; const b = $("#collectForm [type=submit]"); if(b) b.textContent = "Record " + inr(+t.value || 0); }
  else if(t.id === "colRef") F.ref = t.value; else if(t.id === "colNote") F.note = t.value; else return false;
  return true;
}
export function collectMethod(m){ const F = store.collectForm; if(!F) return; F.method = m; F.err = ""; renderCollectForm(false); }
/* Record it → { ok, cid } (the profile opens again) or null (the sheet shows why not) */
export function submitCollect(){
  const F = store.collectForm; if(!F) return null;
  const r = collectPayment(F.cid, { amount: F.amount, method: F.method, ref: F.ref, note: F.note });
  if(r.error){ F.err = r.error; F.field = r.field || ""; renderCollectForm(false); const f = F.field && $(`#collectForm [name=${F.field}]`); if(f) f.focus(); return null; }
  store.collectForm = null;
  toast(`${inrx(r.collection.amount)} received from ${(customerRepository().get(F.cid) || {}).name || "the customer"}. ${r.outstanding > 0 ? "Still owes " + inrx(r.outstanding) + "." : "Nothing owed now."}`);
  return { ok: true, cid: F.cid };
}
/* The owner takes a wrong payment back → the customer id (to show the profile again) or null */
export function cancelCollectionAction(id){
  const c = creditRepository().get(id);
  if(!c || !confirm(`Cancel this payment of ${inrx(c.amount)}? It comes out of the cash or bank book, and the customer owes it again.`)) return null;
  const r = cancelCollection(id); if(r.error){ toast(r.error); return null; }
  toast("Payment cancelled."); return c.cust;
}
