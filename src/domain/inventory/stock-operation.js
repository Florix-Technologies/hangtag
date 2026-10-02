// Stock in and stock adjustment: which moves a form entry makes, and when it is refused.
import { decimalsOf, roundQty } from '../catalog/units.js';
import { checkBatchNo, checkExpiry, incomingSerialError, normBatch, normSerial, parseSerials, serialAvailable } from './tracking.js';

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

/* Stock in and adjustment of a product tracked by serial number or batch: stock moves only with its serials / batches.
   op: { kind:"in"|"adjust", productId, tracking:"serial"|"batch", expiry (its batches keep expiry dates), unit, cost (per piece,
     stock in; null: none), reason, note, now, deviceId, today }
   rows — serial, in: { vid: serials typed } · serial, adjust: { vid: { out: [serials written off], add: serials typed (found) } }
        — batch, in: { vid: { q, b, exp } } · batch, adjust: { "vid|batch": counted }
   ctx: { serialState(sn), batchOf(vid, b) } · newId(): a move id
   → { error } or { moves } (a written-off serial is DAMAGED; a found one comes back IN_STOCK) */
export function buildTrackedMoves(op,rows,ctx,newId){
  const adj=op.kind==="adjust", moves=[], base={p:op.productId,t:op.now,dev:op.deviceId};
  const note=adj?[op.reason,op.note].filter(Boolean).join(" · ").slice(0,200):String(op.note||"").slice(0,200), cost=adj?null:op.cost==null?null:Math.round(op.cost);
  const seen=new Set();
  if(op.tracking==="serial"){
    for(const [vid,row] of Object.entries(rows||{})){
      const addText=adj?(row&&row.add)||"":row, out=adj?((row&&row.out)||[]).map(normSerial):[];
      const p=parseSerials(addText); if(p.error) return {error:p.error};
      for(const x of [...p.serials,...out]){ if(seen.has(x)) return {error:`Serial ${x} is there twice.`}; seen.add(x); }
      const e=incomingSerialError(p.serials,ctx.serialState); if(e) return {error:e};
      for(const x of out){ const s=ctx.serialState(x); if(!s||s.vid!==vid||!serialAvailable(s)) return {error:`Serial ${x} isn't in stock.`}; }
      if(p.serials.length) moves.push({...base,id:newId(),v:vid,type:adj?"ADJUST":"RESTOCK",q:p.serials.length,cost,note:adj?("Found · "+note).slice(0,200):note,sn:p.serials});
      if(out.length) moves.push({...base,id:newId(),v:vid,type:"ADJUST",q:-out.length,cost:null,note,sn:out});
    }
  } else if(op.tracking==="batch"){
    const dp=decimalsOf(op.unit);
    for(const [key,row] of Object.entries(rows||{})){
      if(adj){
        const i=key.indexOf("|"), vid=key.slice(0,i), b=key.slice(i+1), raw=row;
        if(raw===""||raw==null) continue;
        const n=+String(raw).trim().replace(",","."), v=roundQty(n,dp);
        if(!Number.isFinite(n)||v<0) return {error:"Quantities can't be negative."};
        const cur=ctx.batchOf(vid,b), q=roundQty(v-(cur?cur.qty:0)); if(!q) continue;
        moves.push({...base,id:newId(),v:vid,type:"ADJUST",q,cost:null,note,b:normBatch(b)});
      } else {
        const vid=key, r=row||{}; if(r.q===""||r.q==null) continue;
        const n=+String(r.q).trim().replace(",","."), q=roundQty(n,dp);
        if(!Number.isFinite(n)||q<0) return {error:"Quantities can't be negative."};
        if(!q) continue;
        const c=checkBatchNo(r.b); if(c.error) return {error:c.error};
        const known=ctx.batchOf(vid,c.b), x=checkExpiry(r.exp,{required:!!op.expiry,today:op.today,known:known&&known.exp||null}); if(x.error) return {error:x.error};
        moves.push({...base,id:newId(),v:vid,type:"RESTOCK",q,cost,note,b:c.b,...(x.exp?{exp:x.exp}:{})});
      }
    }
  }
  if(!moves.length) return {error:adj?"Nothing changed.":"Enter at least one quantity."};
  return {moves};
}
