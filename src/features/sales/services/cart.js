// Cart lines and quantities. A product sold by the kg, litre or metre has a quantity with decimals (typed, or read from
// the scale); everything else is counted in whole pieces. Quantities are added up exactly (domain/catalog/units.js).
import { legacyCS, optionSnapshot } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { vCost, vLabel, vPrice } from '../../../domain/catalog/variants.js';
import { isSerialV, sellableOf } from '../../inventory/services/tracking.js';
import { vRec } from '../../inventory/services/ledger.js';
import { toast } from '../../../shared/components/toast.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { okColor } from '../../../shared/utils/colors.js';
import { checkQty, isWeighed, roundQty, sumQty, unitOf } from '../../../domain/catalog/units.js';
import { pcsOf } from '../../../domain/sales/sale.js';
import { demandOf, isKit, kitPriceError, kitSnapshot, kitsAvailable } from '../../../domain/catalog/bundles.js';
import { priceOf } from './pricing.js';

export const cartQtyV=vid=>sumQty(store.cart.filter(c=>c.v===vid).map(c=>c.q));
export const cartQtyP=pid=>sumQty(store.cart.filter(c=>c.p===pid).map(c=>c.q));
/* What more of a variant can go on the bill: what can be sold now (serials ready to sell; batches not expired, unless the shop
   sells expired stock) less what the bill has */
/* Kits (domain/catalog/bundles.js) count as their items: a kit can go on the bill while every item has stock left after
   everything the bill already takes (items on their own and inside other kits) */
export const availOf=vid=>{
  const r=vRec(vid), d=demandOf(store.cart);
  if(r&&isKit(r.p)) return kitsAvailable(r.p.bundle,v=>roundQty(sellableOf(v)-(d[v]||0)));
  return roundQty(sellableOf(vid)-(d[vid]||0));
};
/* Serial numbers on a set of bill lines (the cart, or an exchange's new items) */
export const serialsOnLines=lines=>new Set((lines||[]).flatMap(c=>Array.isArray(c.sn)?c.sn:[]));
/* Items on the bill: pieces, and one per line sold by weight or length */
export const cartPcs=()=>pcsOf({items:store.cart});
/* "3 pieces", or "2 items" when a line is sold by weight or length */
export const itemsText=n=>store.cart.some(c=>unitOf(c.u).kind!=="count")?`${n} item${n===1?"":"s"}`:`${n} piece${n===1?"":"s"}`;
export const cartSub=()=>store.cart.reduce((a,c)=>a+c.q*c.price,0);
/* one line per variant, with name / colour / size / price / cost copied at the time of sale */

/* A kit's items as the bill keeps them (their prices now share the kit price out between them) */
const kitItem=v=>{const r=vRec(v);return r?{p:r.p.id,name:r.p.name,vl:vLabel(r.v),price:vPrice(r.p,r.v),cost:vCost(r.p,r.v),u:unitOf(r.p.unit).id,sku:r.v.sku||"",...legacyCS(r.p.opts,r.v.o),ov:optionSnapshot(r.p,r.v)}:null};
export function addToLines(lines,vid,q,ctx){
  const r=vRec(vid); if(!r) return;
  const ex=lines.find(c=>c.v===vid);
  const u=unitOf(r.p.unit).id;
  if(ex){ ex.q=roundQty(ex.q+q); return; }
  // its price: the bill's price list (the customer's own, the one chosen, the default), else the item's own price
  const P=priceOf(r.p,r.v,ctx), kit=isKit(r.p)?kitSnapshot(r.p.bundle,kitItem):null;
  lines.push({v:vid,p:r.p.id,name:r.p.name,...legacyCS(r.p.opts,r.v.o),vl:vLabel(r.v),ov:optionSnapshot(r.p,r.v),sku:r.v.sku||"",q:roundQty(q),price:P.price,cost:vCost(r.p,r.v),color:okColor(r.p.color),
    // the unit it is sold in (kept on the bill line: a bill never changes when the product does)
    ...(u!=="pcs"?{u}:{}),...(P.listId?{pl:P.listId}:{}),...(kit&&kit.kit?{kit:kit.kit}:{})});
}
/* The bill's prices again after its price list or customer changed: every line that came from the catalog gets its price
   from the resolver now (lines from a quotation or sales order keep the agreed price). → how many lines changed */
export function repriceCart(){
  let n=0;
  store.cart.forEach(c=>{
    if(c.ord) return;
    const r=vRec(c.v); if(!r) return;
    const P=priceOf(r.p,r.v);
    if(P.price!==c.price||(P.listId||null)!==(c.pl||null)){ c.price=P.price; if(P.listId) c.pl=P.listId; else delete c.pl; n++; }
  });
  if(n) saveCart();
  return n;
}
/* A kit's items for a bill line of it (null when the variant isn't a kit) */
export function kitLineOf(vid){ const r=vRec(vid); if(!r||!isKit(r.p)) return null; const k=kitSnapshot(r.p.bundle,kitItem); return k.kit||null; }
/* Why a kit can't go on the bill now (an item left the catalog, or the kit costs more than its items), or null */
export function kitBlock(vid){
  const r=vRec(vid); if(!r||!isKit(r.p)) return null;
  const k=kitSnapshot(r.p.bundle,kitItem); if(k.error) return k.error;
  return kitPriceError(priceOf(r.p,r.v).price,k.kit);
}
/* Serial numbers for a variant on bill lines: its line gets them (one piece each; a serial already there isn't added twice) */
export function addSerials(lines,vid,serials){
  const r=vRec(vid); if(!r||!(serials||[]).length) return;
  let ex=lines.find(c=>c.v===vid);
  if(!ex){ addToLines(lines,vid,serials.length); ex=lines.find(c=>c.v===vid); ex.sn=[]; ex.q=0; }
  const sn=Array.isArray(ex.sn)?ex.sn:(ex.sn=[]);
  serials.forEach(x=>{ if(!sn.includes(x)) sn.push(x); });
  ex.q=sn.length;
}
/* Takes serial sn off bill line i (the line goes when it was the last) */
export function removeSerial(lines,i,sn){
  const c=lines[i]; if(!c||!Array.isArray(c.sn)) return;
  c.sn=c.sn.filter(x=>x!==sn); c.q=c.sn.length;
  if(!c.q) lines.splice(i,1);
}
export function addOne(vid){
  const r=vRec(vid); if(!r) return;
  // tracked by serial number: the pieces are chosen by their serials
  if(isSerialV(vid)){ if(availOf(vid)<=0){ toast(`${r.p.name} ${vLabel(r.v)} is sold out.`); return; } serialHook(r.p.id,vid,"cart"); return; }
  // sold by weight or volume: ask for the weight (typed, or read from the scale) instead of adding one
  if(isWeighed(r.p.unit)){ if(availOf(vid)<=0){ toast(`${r.p.name} ${vLabel(r.v)} is sold out.`); return; } weighHook(vid); return; }
  const kb=kitBlock(vid); if(kb){ toast(kb); return; }
  if(availOf(vid)<=0){ toast(isKit(r.p)?`${r.p.name}: an item of the kit is out of stock.`:`${r.p.name} ${vLabel(r.v)} is sold out.`); return; }
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
/* …and so does the serial number picker (features/sales/components/serial-picker.js): (productId, variantId, target) */
let serialHook=()=>{};
export const onSerialPick=fn=>{serialHook=fn||(()=>{})};
export const pickSerials=(pid,vid,target)=>serialHook(pid,vid,target||"cart");
