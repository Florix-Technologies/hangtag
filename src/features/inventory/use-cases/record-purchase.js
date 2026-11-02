// RecordPurchase: a supplier's invoice entered line by line (supplier → invoice no → date → lines → paid) becomes a
// purchase and its stock-in records (RESTOCK with the cost per piece, pointing at the purchase), saved on this device and
// uploaded in one step. Cash paid goes out of the drawer (cash book "Cash out"). Optionally the lines' cost per piece
// becomes the variants' cost price, like Stock in does. CancelPurchase takes its stock back out and the cash back in.
// A team member needs create_purchase (cancelling: and manage_inventory; cost prices: manage_products), refused before
// anything changes.
import { store } from '../../../shared/state/store.js';
import { buildPurchase, cancelPurchaseMoves, purchaseCashMove, purchaseCashReversal } from '../../../domain/inventory/purchase.js';
import { vCost, vLabel } from '../../../domain/catalog/variants.js';
import { decimalsOf } from '../../../domain/catalog/units.js';
import { vRec } from '../services/ledger.js';
import { purchaseRepository } from '../repositories/purchase-repository.js';
import { purchasesList, supplierById } from '../services/purchase-state.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { uid } from '../../../shared/utils/ids.js';
import { can, denied, notAllowedText } from '../../shop/services/access.js';
import { batchOf, expiryKept, serialState, trackingOfP } from '../services/tracking.js';
import { parseSerials, serialAvailable } from '../../../domain/inventory/tracking.js';
import { qtyText, roundQty } from '../../../domain/catalog/units.js';

/* input: { supplierId, invoiceNo, invoiceDate, lines: [{ p, v, q, cost, gst, dec?, serials? (or snText: typed), batch? ({ no, exp }) }], paid, method, note }
   opts: { allowDuplicate (the same invoice number from this supplier again), updateCost }
   → { error, field?, line?, duplicate? } or { purchase, totals } */
export function savePurchase(input,opts={}){
  const no=denied("create_purchase","record purchases"); if(no) return no;
  const x=input||{}, sup=x.supplierId?supplierById(x.supplierId):null;
  if(x.supplierId&&!sup) return {error:"That supplier wasn't found.",field:"supplier"};
  if(sup&&sup.active===false) return {error:`${sup.name} is switched off. Switch it on in Suppliers, or choose another supplier.`,field:"supplier"};
  if(opts.updateCost&&!can("manage_products")) return {error:notAllowedText("change cost prices")+" Untick “Update cost prices”."};
  // every line names a product of the catalog (its name and variant as they are now: the purchase keeps them)
  const lines=[];
  for(const [i,l] of (x.lines||[]).entries()){
    const r=l&&vRec(l.v);
    if(!r) return {error:`Line ${i+1}: that product isn't in the catalog any more.`,field:"lines",line:i};
    // tracked by serial number: the serials typed or scanned (one per piece: they make the quantity)
    let serials=l.serials;
    if(trackingOfP(r.p)==="serial"&&l.snText!=null){ const ps=parseSerials(l.snText); if(ps.error) return {error:`Line ${i+1} (${r.p.name}): ${ps.error}`,field:"lines",line:i}; serials=ps.serials;
      if(!serials.length) return {error:`Line ${i+1} (${r.p.name}): enter the serial number of each piece (one per line, or a range like SN001..SN010).`,field:"lines",line:i}; }
    lines.push({...l,...(serials?{serials,q:l.snText!=null?String(serials.length):l.q}:{}),p:r.p.id,n:r.p.name,vl:vLabel(r.v),sku:r.v.sku||"",dec:decimalsOf(r.p.unit)});   // kg, litres: up to 3 decimals
  }
  const trackingOf=l=>{const r=vRec(l.v);return r?{tracking:trackingOfP(r.p),expiry:expiryKept(r.p)}:null};
  const t=Date.now();
  const b=buildPurchase({...x,id:"pur"+uid(),lines,supplierName:sup?sup.name:"",supplierGstin:sup?sup.gstin:"",t,dev:store.dev},
    {today:dayKey(t),purchases:purchasesList(),allowDuplicate:!!opts.allowDuplicate,trackingOf,serialState,batchOf});
  if(b.error) return b;
  const changed=[], changedV={};   // the products, and their variants, whose cost price this purchase changed
  if(opts.updateCost) b.purchase.lines.forEach(l=>{const r=vRec(l.v),c=Math.round(l.cost);if(r&&vCost(r.p,r.v)!==c){r.v.cost=c;if(!changed.includes(r.p.id))changed.push(r.p.id);(changedV[r.p.id]=changedV[r.p.id]||[]).push(r.v.id)}});
  purchaseRepository().savePurchase({purchase:b.purchase,moves:b.moves,cashMove:purchaseCashMove(b.purchase),changedProductIds:changed,changedVariantIds:changedV});
  return {purchase:b.purchase,totals:b.totals};
}
/* → { error } or { purchase } (cancelled, its stock and cash back) */
export function cancelPurchase(id,reason){
  const no=denied("create_purchase","cancel purchases")||denied("manage_inventory","cancel purchases (it takes their stock back out)"); if(no) return no;
  const p=(store.purchases||{})[id];
  const t=Date.now(), r=cancelPurchaseMoves(p,Object.values(store.moves),{reason,t,dev:store.dev});
  if(r.error) return r;
  // its serials must all still be in stock, and its batches still hold what it brought in (a sold piece comes back first)
  for(const m of r.moves){
    for(const x of m.sn||[]){ const s=serialState(x); if(!serialAvailable(s)) return {error:`Serial ${x} of this purchase ${s&&s.status==="SOLD"?"has been sold":"isn't in stock any more"}: the purchase can't be cancelled. Take it back with a return first.`}; }
    if(m.b){ const b=batchOf(m.v,m.b), left=b?b.qty:0, r0=vRec(m.v); if(roundQty(left+m.q)<0) return {error:`Batch ${m.b} has only ${qtyText(left,r0&&r0.p.unit)} left of the ${qtyText(-m.q,r0&&r0.p.unit)} this purchase brought in: the purchase can't be cancelled. Adjust the stock or take sold pieces back first.`}; }
  }
  const purchase=purchaseRepository().cancelPurchase({id,reason:r.reason,moves:r.moves,cashMove:purchaseCashReversal(p,r.reason,t,store.dev),t,dev:store.dev});
  return {purchase};
}
