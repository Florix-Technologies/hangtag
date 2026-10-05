// Guided checkout: Items → Customer → Review → Payment → Done. Every step says what happened to it: done, or skipped — a
// sale paid straight from the bill's Cash / UPI / Card buttons skips Customer and Review, and the steps then say
// "Skipped", never done. The payment screen and its rules stay in payment-sheet.js (the same checkout and payment rules
// either way). A customer is needed only where the sale needs one: a bill of an order keeps the order's customer, and
// credit (paying later) asks for a saved customer on the payment screen.
import { store } from '../../../shared/state/store.js';
import { billTotals } from '../services/totals.js';
import { cartPcs, itemsText } from '../services/cart.js';
import { sheetHTML, statusChip } from '../../../shared/ui/kit.js';
import { $, esc } from '../../../shared/dom.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { openPayment, payClosed } from './payment-sheet.js';
import { progressHTML } from './checkout-steps.js';
import { setBillCustomer } from '../../customers/use-cases/save-customer.js';

/* Why this bill must keep its customer ("" when it needn't have one) */
export function customerRequired(){
  if(store.cartOrder && store.cartOrder.id && store.cartCust) return "This bill is for an order: it keeps the order's customer.";
  return "";
}
const customerCard = () => {
  const c = store.cartCust, need = customerRequired();
  if(c && c.name) return `<div class="checkout-customer"><span>${statusChip("Customer", "info")}</span><div><b>${esc(c.name)}</b><small>${esc(c.phone || "Saved customer")}</small></div>${need ? "" : `<button type="button" class="btn sm" data-act="pickcust">Change</button>`}</div>`
    + (need ? `<p class="note" data-custneed>${esc(need)}</p>` : `<button type="button" class="btn text" data-checkoutwalkin>Use Walk-in instead</button>`);
  return `<div class="checkout-choices" role="group" aria-label="Who is this sale for?">
    <button type="button" class="checkout-choice" data-checkoutwalkin><b>Walk-in customer</b><small>No details kept on the bill</small></button>
    <button type="button" class="checkout-choice" data-act="pickcust"><b>Add customer</b><small>Find or add a saved customer</small></button></div>`;
};
const reviewLines = () => store.cart.map(c => `<div class="checkout-line"><span><b>${esc(c.name)}</b>${c.vl || c.s ? `<small>${esc(c.vl || c.s)}</small>` : ""}</span><span>${esc(String(c.q))} × ${inr(c.price)}</span></div>`).join("");

/* Start (from the bill's "Review & pay"): the payment method chosen there is the one the payment screen opens with */
export function openCheckout(preferred = "cash"){
  if(!store.cart.length) return;
  store.checkoutFlow = { step: "customer", preferred: ["cash", "upi", "card"].includes(preferred) ? preferred : "cash", customer: "", review: "" };
  renderCheckout();
}
export function renderCheckout(){
  const F = store.checkoutFlow; if(!F || !store.cart.length) return;
  const T = billTotals(store.cart, store.disc, store.cartCust), pcs = cartPcs(), who = store.cartCust && store.cartCust.name ? esc(store.cartCust.name) : "Walk-in";
  if(F.step === "review"){
    $("#modalHost").innerHTML = sheetHTML({ id: "checkoutReview", cls: "checkout-sheet", title: "Review sale", sub: `${esc(itemsText(pcs))} · ${who}`,
      body: `${progressHTML("review", F)}<div class="checkout-who"><span>Customer</span><b>${who}</b>${F.customer === "skipped" ? '<small>Skipped</small>' : ""}<button type="button" class="link xs" data-checkoutstep="customer">Change</button></div>
        <div class="checkout-lines">${reviewLines()}</div><div class="checkout-total"><span>Total</span><b data-checkouttotal>${inrx(T.total)}</b></div><p class="note">Payment is taken on the next screen.</p>`,
      foot: `<button type="button" class="btn" data-checkoutstep="customer">Back</button><button type="button" class="btn primary" data-checkoutpay>Continue to payment</button>` });
    return;
  }
  const need = customerRequired(), hasCust = !!(store.cartCust && store.cartCust.name);
  $("#modalHost").innerHTML = sheetHTML({ id: "checkoutCustomer", cls: "checkout-sheet", title: "Customer", sub: need ? "This sale needs its customer" : "Optional for an ordinary sale",
    body: `${progressHTML("customer", F)}${customerCard()}<p class="note">A saved customer is needed only to pay later (credit) or for a business's GST invoice with its GSTIN.</p>`,
    foot: `<button type="button" class="btn" data-modal-close>Cancel</button>${hasCust ? `<button type="button" class="btn primary" data-checkoutstep="review">Continue</button>`
      : `<button type="button" class="btn" data-checkoutstep="skip">Skip</button>`}` });
}
/* customer → review ("skip": on without a customer, the step marked skipped); review → customer */
export function checkoutStep(step){
  const F = store.checkoutFlow; if(!F) return;
  if(step === "skip"){ if(customerRequired()) return; F.customer = "skipped"; F.step = "review"; }
  else if(step === "review"){ F.customer = F.customer || "done"; F.step = "review"; }
  else if(step === "customer") F.step = "customer";
  else return;
  renderCheckout();
}
/* Review → the payment screen, with what was done and skipped on the way */
export function checkoutPayment(){
  const F = store.checkoutFlow; if(!F) return;
  const flow = { customer: F.customer || "skipped", review: "done" }, method = F.preferred;
  store.checkoutFlow = null;
  openPayment(method, { flow });
}
/* The payment screen's Back: to Review, the bill as it was (nothing was paid) */
export function checkoutBack(){
  const s = store.payState; if(!s || !s.guided) return;
  const method = s.mode === "single" ? s.method : "cash", flow = s.flow || {};
  payClosed(); store.payState = null;
  store.checkoutFlow = { step: "review", preferred: method, customer: flow.customer || "skipped", review: "" };
  renderCheckout();
}
/* A customer was chosen (picker or a new customer) while checking out: on to Review */
export function resumeCheckoutAfterCustomer(){ if(!store.checkoutFlow) return false; store.checkoutFlow.customer = "done"; store.checkoutFlow.step = "review"; renderCheckout(); return true; }
/* Walk-in chosen: no customer on the bill (unless the bill must keep its own), on to Review */
export function checkoutWalkIn(){
  if(customerRequired()) return;
  setBillCustomer(null);
  if(store.checkoutFlow){ store.checkoutFlow.customer = "done"; store.checkoutFlow.step = "review"; renderCheckout(); }
}
