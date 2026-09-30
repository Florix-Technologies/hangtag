// Stock in and stock adjustment: which moves a form entry makes, and when it is refused.
import { decimalsOf, roundQty } from '../catalog/units.js';

/* A stock-in's note: who it came from, their reference, when it arrived (when not today) and the note typed */
export function stockInNote({supplier,ref,received,note,today}){
  const clean=s=>String(s||"").trim().replace(/\s+/g," ");
  return [clean(supplier)&&"From "+clean(supplier).slice(0,60),clean(ref)&&"Ref "+clean(ref).slice(0,40),received&&received!==today?"Received "+received:"",clean(note)].filter(Boolean).join(" · ").slice(0,200);
}
/* op: { kind:"in"|"adjust", productId, values:{ variantId: typed quantity }, costRaw, reason, note, now, deviceId, unit? (the
   product's: kg and litres keep 3 decimals, metres 2, everything else whole numbers) }
   currentStock(variantId) gives stock on hand (an adjustment types the counted number; stock in types pieces received).
   newId() makes a move id. Returns { error } or { moves, cost } (cost: the per-piece cost entered for stock in, or null). */
export function buildStockMoves(op,currentStock,newId){
  const adj=op.kind==="adjust";
  const costRaw=adj?"":String(op.costRaw||"").trim(), cost=costRaw===""?null:Math.round(+costRaw);
  if(cost!=null&&(isNaN(cost)||cost<0)) return {error:"Enter a valid cost per piece, or leave it empty."};
  const moves=[];
  for(const [vid,raw] of Object.entries(op.values)){
    if(raw===""||raw==null) continue;
    const n=+String(raw).trim().replace(",","."), v=roundQty(n,decimalsOf(op.unit));
    if(!Number.isFinite(n)||v<0) return {error:"Quantities can't be negative."};
    const q=adj?roundQty(v-currentStock(vid)):v; if(!q) continue;
    moves.push({id:newId(),v:vid,p:op.productId,type:adj?"ADJUST":"RESTOCK",q,cost:adj?null:cost,note:adj?[op.reason,op.note].filter(Boolean).join(" · "):op.note,t:op.now,dev:op.deviceId});
  }
  if(!moves.length) return {error:adj?"Nothing changed.":"Enter at least one quantity."};
  return {moves,cost};
}
