// Guided checkout for the normal path: Customer (optional) → Review → the existing payment screen. Quick Cash/UPI/Card
// buttons remain for experienced cashiers; both paths use the same payment and checkout domain rules.
import { store } from '../../../shared/state/store.js';
import { billTotals } from '../services/totals.js';
import { cartPcs, itemsText } from '../services/cart.js';
import { sheetHTML, statusChip } from '../../../shared/ui/kit.js';
import { $, esc } from '../../../shared/dom.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { openPayment } from './payment-sheet.js';
import { setBillCustomer } from '../../customers/use-cases/save-customer.js';

const progress=step=>`<ol class="checkout-progress" aria-label="Checkout steps"><li class="done">Items</li><li class="${step==='customer'?'on':'done'}">Customer</li><li class="${step==='review'?'on':''}">Review</li><li>Payment</li></ol>`;
const customerHTML=()=>store.cartCust&&store.cartCust.name?`<div class="checkout-customer"><span>${statusChip('Customer','info')}</span><div><b>${esc(store.cartCust.name)}</b><small>${esc(store.cartCust.phone||'Saved customer')}</small></div><button type="button" class="btn sm" data-act="pickcust">Change</button></div>`
  :`<div class="checkout-customer walkin"><span>${statusChip('Optional','muted')}</span><div><b>Walk-in customer</b><small>No customer details will be saved on this bill.</small></div><button type="button" class="btn sm" data-act="pickcust">Add customer</button></div>`;
const reviewLines=()=>store.cart.map(c=>`<div class="checkout-line"><span><b>${esc(c.name)}</b>${c.vl||c.s?`<small>${esc(c.vl||c.s)}</small>`:''}</span><span>${esc(String(c.q))} × ${inr(c.price)}</span></div>`).join('');

export function openCheckout(preferred='cash'){
  if(!store.cart.length)return;
  store.checkoutFlow={step:'customer',preferred:['cash','upi','card'].includes(preferred)?preferred:'cash'};
  renderCheckout();
}
export function renderCheckout(){
  const F=store.checkoutFlow;if(!F||!store.cart.length)return;
  const T=billTotals(store.cart,store.disc),pcs=cartPcs(),customer=customerHTML();
  if(F.step==='review'){
    $('#modalHost').innerHTML=sheetHTML({id:'checkoutReview',cls:'checkout-sheet',title:'Review sale',sub:`${esc(itemsText(pcs))} · ${store.cartCust&&store.cartCust.name?esc(store.cartCust.name):'Walk-in'}`,body:`${progress('review')}${customer}<div class="checkout-lines">${reviewLines()}</div><div class="checkout-total"><span>Total</span><b>${inrx(T.total)}</b></div><p class="note">Check the items, customer and total. Payment is recorded only on the next screen.</p>`,foot:`<button type="button" class="btn" data-checkoutstep="customer">Back</button><button type="button" class="btn primary" data-checkoutpay>Continue to payment</button>`});
    return;
  }
  $('#modalHost').innerHTML=sheetHTML({id:'checkoutCustomer',cls:'checkout-sheet',title:'Customer',sub:'Optional for an ordinary sale',body:`${progress('customer')}${customer}<div class="checkout-choice"><p>Use <b>Walk-in</b> when customer details are not needed. A saved customer is required only for credit and customer-specific billing.</p>${store.cartCust?`<button type="button" class="btn text danger" data-checkoutwalkin>Use Walk-in instead</button>`:''}</div>`,foot:`<button type="button" class="btn" data-modal-close>Cancel</button><button type="button" class="btn primary" data-checkoutstep="review">Review sale</button>`});
}
export function checkoutStep(step){if(!store.checkoutFlow)return;if(step==='customer'||step==='review'){store.checkoutFlow.step=step;renderCheckout();}}
export function checkoutPayment(){const F=store.checkoutFlow;if(!F)return;const method=F.preferred;store.checkoutFlow=null;openPayment(method);}
export function resumeCheckoutAfterCustomer(){if(!store.checkoutFlow)return false;store.checkoutFlow.step='review';renderCheckout();return true;}
export function checkoutWalkIn(){setBillCustomer(null);if(store.checkoutFlow){store.checkoutFlow.step='review';renderCheckout();}}
