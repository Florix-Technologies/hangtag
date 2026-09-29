// Cart lines and quantities. A product sold by the kg, litre or metre has a quantity with decimals (typed, or read from
// the scale); everything else is counted in whole pieces. Quantities are added up exactly (domain/catalog/units.js).
import { legacyCS, optionSnapshot } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { vCost, vLabel, vPrice } from '../../../domain/catalog/variants.js';
import { stockOf } from '../../inventory/services/stock.js';
import { vRec } from '../../inventory/services/ledger.js';
import { toast } from '../../../shared/components/toast.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { okColor } from '../../../shared/utils/colors.js';
import { checkQty, isWeighed, roundQty, sumQty, unitOf } from '../../../domain/catalog/units.js';
import { pcsOf } from '../../../domain/sales/sale.js';

export const cartQtyV=vid=>sumQty(store.cart.filter(c=>c.v===vid).map(c=>c.q));
export const cartQtyP=pid=>sumQty(store.cart.filter(c=>c.p===pid).map(c=>c.q));
export const availOf=vid=>roundQty(stockOf(vid)-cartQtyV(vid));
/* Items on the bill: pieces, and one per line sold by weight or length */
export const cartPcs=()=>pcsOf({items:store.cart});
/* "3 pieces", or "2 items" when a line is sold by weight or length */
export const itemsText=n=>store.cart.some(c=>unitOf(c.u).kind!=="count")?`${n} item${n===1?"":"s"}`:`${n} piece${n===1?"":"s"}`;
export const cartSub=()=>store.cart.reduce((a,c)=>a+c.q*c.price,0);
/* one line per variant, with name / colour / size / price / cost copied at the time of sale */

export function addToLines(lines,vid,q){
  const r=vRec(vid); if(!r) return;
  const ex=lines.find(c=>c.v===vid);
  const u=unitOf(r.p.unit).id;
  if(ex) ex.q=roundQty(ex.q+q);
  else lines.push({v:vid,p:r.p.id,name:r.p.name,...legacyCS(r.p.opts,r.v.o),vl:vLabel(r.v),ov:optionSnapshot(r.p,r.v),sku:r.v.sku||"",q:roundQty(q),price:vPrice(r.p,r.v),cost:vCost(r.p,r.v),color:okColor(r.p.color),
    // the unit it is sold in (kept on the bill line: a bill never changes when the product does)
    ...(u!=="pcs"?{u}:{})});
}
export function addOne(vid){
  const r=vRec(vid); if(!r) return;
  // sold by weight or volume: ask for the weight (typed, or read from the scale) instead of adding one
  if(isWeighed(r.p.unit)){ if(availOf(vid)<=0){ toast(`${r.p.name} ${vLabel(r.v)} is sold out.`); return; } weighHook(vid); return; }
  if(availOf(vid)<=0){ toast(`${r.p.name} ${vLabel(r.v)} is sold out.`); return; }
  addToLines(store.cart,vid,1); store.justAdded=r.p.id; saveCart(); renderAll();
  toast(`Added ${r.p.name}${vLabel(r.v)?" · "+vLabel(r.v):""}.`);
}
/* Most pieces bill line i can have: what is in stock for its variant (this line's pieces included) */
export const lineMax=i=>{const c=store.cart[i];return c?Math.max(0,roundQty(availOf(c.v)+c.q)):0};
/* A typed quantity for bill line i (in its unit: 2.5 kg, 3 pieces) → { ok, message }. Invalid input changes nothing; more
   than the stock is capped. */
export function setLineQty(i,raw){
  const c=store.cart[i]; if(!c) return {ok:false,message:""};
  const r=checkQty(raw,c.u,{max:lineMax(i)});
  if(r.q!=null&&r.q!==c.q){c.q=r.q;saveCart()}
  return r.error?{ok:false,message:r.error}:{ok:true,message:""};
}
/* Takes bill line i off the bill */
export function removeLine(i){
  if(!store.cart[i]) return;
  store.cart.splice(i,1); if(!store.cart.length) store.disc=0; saveCart();
}
/* The weight dialog (features/sales/components/weigh-dialog.js) registers itself here, so the cart doesn't import a component */
let weighHook=()=>{};
export const onWeigh=fn=>{weighHook=fn||(()=>{})};
