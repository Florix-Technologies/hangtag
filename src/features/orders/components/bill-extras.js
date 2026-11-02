// What the Orders area adds to the bill on the Sell screen: Hold (and the held bills waiting), the order the bill comes
// from, and "Save as quotation". Only buttons; the work is in the use cases.
import { KIND_LABELS } from '../../../domain/orders/orders.js';
import { store } from '../../../shared/state/store.js';
import { orderViews } from '../module.js';
import { holdCart, listHeldCarts } from '../use-cases/held-carts.js';
import { detachCartOrder } from '../use-cases/orders.js';
import { can } from '../../shop/services/access.js';
import { chooseSubview } from '../../shop/services/modules.js';
import { toast } from '../../../shared/components/toast.js';
import { esc } from '../../../shared/dom.js';
import { renderAll, setTab } from '../../../shared/ui/render.js';

/* In the bill's head: "Hold" while there is a bill, else "Held (n)" when bills are waiting */
export function billHoldHTML(empty){
  if(!can("create_sale")) return "";
  if(!empty && store.cartTable) return "";
  if(!empty) return `<button class="link" data-hold>Hold</button>`;
  const n = listHeldCarts().length;
  return n ? `<button class="link" data-heldopen>Held (${n})</button>` : "";
}
/* Under the customer: the quotation / sales order the bill delivers (and a way to bill it as an ordinary bill) */
export function billOrderHTML(){
  const o = store.cartOrder; if(!o || !store.cart.some(c => c.ord === o.id)) return "";
  return `<div class="ordline"><span>From ${esc((KIND_LABELS[o.kind] || "order").toLowerCase())} <b>${esc(o.no || "")}</b></span><button class="link xs" data-orddetach>Bill separately</button></div>`;
}
/* Under the pay buttons: turn the bill on the screen into a quotation (where the shop makes quotations) */
export function billQuoteHTML(empty){
  if(empty || store.cartOrder || store.cartTable || !can("create_order") || !orderViews().some(v => v.id === "quote")) return "";
  return `<button class="link xs bp-quote" data-ordfromcart="quote">Save as quotation</button>`;
}
export function holdAction(){
  const r = holdCart();
  if(r.error){ toast(r.error); return; }
  renderAll(); toast(`Bill held as “${r.held.name}”. Recall it from Sell → Held bills.`);
}
export function openHeldList(){ chooseSubview("orders", "held"); setTab("orders"); }
export function detachAction(){ detachCartOrder(); renderAll(); toast("The bill no longer comes from the order."); }
