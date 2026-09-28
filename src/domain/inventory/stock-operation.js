// Stock in and stock adjustment: which moves a form entry makes, and when it is refused.

/* A stock-in's note: who it came from, their reference, when it arrived (when not today) and the note typed */
export function stockInNote({supplier,ref,received,note,today}){
  const clean=s=>String(s||"").trim().replace(/\s+/g," ");
  return [clean(supplier)&&"From "+clean(supplier).slice(0,60),clean(ref)&&"Ref "+clean(ref).slice(0,40),received&&received!==today?"Received "+received:"",clean(note)].filter(Boolean).join(" · ").slice(0,200);
}
/* op: { kind:"in"|"adjust", productId, values:{ variantId: typed quantity }, costRaw, reason, note, now, deviceId }
   currentStock(variantId) gives stock on hand (an adjustment types the counted number; stock in types pieces received).
   newId() makes a move id. Returns { error } or { moves, cost } (cost: the per-piece cost entered for stock in, or null). */
export function buildStockMoves(op,currentStock,newId){
  const adj=op.kind==="adjust";
  const costRaw=adj?"":String(op.costRaw||"").trim(), cost=costRaw===""?null:Math.round(+costRaw);
  if(cost!=null&&(isNaN(cost)||cost<0)) return {error:"Enter a valid cost per piece, or leave it empty."};
  const moves=[];
  for(const [vid,raw] of Object.entries(op.values)){
    if(raw===""||raw==null) continue;
    const v=Math.round(+raw);
    if(isNaN(v)||v<0) return {error:"Quantities can't be negative."};
    const q=adj?v-currentStock(vid):v; if(!q) continue;
    moves.push({id:newId(),v:vid,p:op.productId,type:adj?"ADJUST":"RESTOCK",q,cost:adj?null:cost,note:adj?[op.reason,op.note].filter(Boolean).join(" · "):op.note,t:op.now,dev:op.deviceId});
  }
  if(!moves.length) return {error:adj?"Nothing changed.":"Enter at least one quantity."};
  return {moves,cost};
}
