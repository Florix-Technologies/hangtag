// Hold and recall: the bill on the screen is put aside (named after its customer, else the time) and finished later, on
// this till or any other of the shop. Holding never touches stock (held pieces stay on the shelf until they are billed);
// recalling puts the bill back on the screen and removes the held copy for every till.
import { checkHold, heldName } from '../../../domain/orders/orders.js';
import { store } from '../../../shared/state/store.js';
import { orderRepository } from '../repositories/order-repository.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { hhmm } from '../../../shared/formatting/dates.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied } from '../../shop/services/access.js';

const upload = () => { renderSync(); flushSbQueue(); };
const clearCart = () => { store.cart = []; store.disc = null; store.cartCust = null; store.cartOrder = null; saveCart(); };
/* Held bills, newest first */
export const listHeldCarts = () => orderRepository().heldList().slice().sort((a, b) => b.t - a.t);
/* name: optional (default: the customer's name, else "Bill 2:05 pm") → { held } or { error } (nothing changes) */
export function holdCart(name){
  const no = denied("create_sale", "hold bills"); if(no) return no;
  const t = Date.now(), nm = String(name == null || !String(name).trim() ? heldName(store.cartCust, "Bill " + hhmm(t)) : name).trim();
  const bad = checkHold(store.cart, nm); if(bad) return { error: bad };
  const h = { id: "h" + uid(), name: nm, t, dev: store.dev, ...(store.authUser ? { user: store.authUser.id } : {}),
    data: { cart: store.cart.map(c => ({ ...c })), disc: store.disc || null, cust: store.cartCust || null, ...(store.cartOrder ? { order: store.cartOrder } : {}) } };
  orderRepository().hold(h);
  clearCart(); upload();
  return { held: h };
}
/* Back on the screen (only onto an empty bill) → { held } or { error } */
export function recallHeld(id){
  const no = denied("create_sale", "recall held bills"); if(no) return no;
  const h = orderRepository().getHeld(id);
  if(!h) return { error: "That held bill isn't here any more (another till may have recalled it)." };
  if(store.cart.length) return { error: "Finish, hold or clear the bill on the screen first." };
  const d = h.data || {};
  store.cart = Array.isArray(d.cart) ? d.cart.map(c => ({ ...c })) : []; store.disc = d.disc || null; store.cartCust = d.cust || null; store.cartOrder = d.order || null;
  saveCart();
  orderRepository().removeHeld(id); upload();
  return { held: h };
}
/* Thrown away without billing → { ok } or { error } */
export function discardHeld(id){
  const no = denied("create_sale", "remove held bills"); if(no) return no;
  if(!orderRepository().removeHeld(id)) return { error: "That held bill isn't here any more." };
  upload();
  return { ok: true };
}
