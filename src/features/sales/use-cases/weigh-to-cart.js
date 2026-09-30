// WeighToCart: a product sold by weight or volume goes on the bill with its weight — typed, or read from the scale — as
// the quantity (2.5 kg), within the stock. Weighing a bill line again replaces its quantity.
import { store } from '../../../shared/state/store.js';
import { checkQty, qtyText, roundQty } from '../../../domain/catalog/units.js';
import { vRec } from '../../inventory/services/ledger.js';
import { addToLines, availOf } from '../services/cart.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { denied } from '../../shop/services/access.js';

/* vid: the variant · raw: the weight in the product's unit, as typed or read · line: a bill line weighed again (its index),
   or null for a new weighing → { ok, q, text } or { error } (nothing changes) */
export function addWeighed(vid,raw,line){
  const no=denied("create_sale","sell"); if(no) return no;
  const r=vRec(vid); if(!r) return {error:"That product isn't in the catalog any more."};
  const c=line!=null?store.cart[line]:null, again=!!(c&&c.v===vid);
  const k=checkQty(raw,r.p.unit,{max:roundQty(availOf(vid)+(again?c.q:0))});
  if(k.error) return {error:k.error};
  if(again) c.q=k.q; else addToLines(store.cart,vid,k.q);
  store.justAdded=r.p.id; saveCart();
  return {ok:true,q:k.q,text:qtyText(k.q,r.p.unit)};
}
