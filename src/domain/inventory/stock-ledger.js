// The stock ledger: every change to a sellable item's stock, oldest first. Stock on hand is the sum of its entries;
// it is never stored as a number that could drift. Entries come from three records:
//   stock moves   OPENING (opening stock), RESTOCK (stock in, supplier bills), ADJUST (counted stock)
//   bills         SALE (−) for each line of a bill · EXCHANGE_OUT (−) for the new bill of an exchange
//   returns       RETURN (+) for a piece back on the shelf · EXCHANGE_IN (+) for a piece coming back in an exchange
//                 NOT_FOR_RESALE (0): a returned piece that can't be sold again, recorded without adding stock
// Cancelled bills leave no entries: their pieces are back on the shelf. Pure.
import { restocks } from '../returns/return-value.js';
import { roundQty } from '../catalog/units.js';

export const MOVE_LABELS={OPENING:"Opening stock",RESTOCK:"Stock in",ADJUST:"Adjustment",SALE:"Sold",EXCHANGE_OUT:"Exchange out",
  RETURN:"Returned",EXCHANGE_IN:"Exchange in",NOT_FOR_RESALE:"Returned, not for resale"};
export const MOVE_TYPES=Object.keys(MOVE_LABELS);

/* moves: { id: move } · sales: bills (cancelled ones have void set) · returns: returns and exchanges
   resolve(line): the variant id of a bill or return line (null when it can't be found)
   → [{ id, t, vid, pid, type, q (change to stock), pieces (pieces on the record), ref, note, cost, saleId, returnId, sn?, bt? }]
   (sn: the serial numbers on the record; bt: its batches [{ b, q }]) */
export function ledgerEntries({moves,sales,returns,resolve}){
  const out=[], rv=i=>resolve?resolve(i):(i.v||null), sale={};
  const tk=x=>Object.assign({},Array.isArray(x.sn)&&x.sn.length?{sn:x.sn}:{},Array.isArray(x.bt)&&x.bt.length?{bt:x.bt}:x.b?{bt:[{b:x.b,q:x.q}]}:{});
  Object.values(moves||{}).forEach(m=>{ if(!m||!m.v) return; const q=roundQty(m.q);
    out.push({id:"m:"+m.id,t:+m.t||0,vid:m.v,pid:m.p||null,type:m.type||"ADJUST",q,pieces:q,ref:"",note:m.note||"",cost:m.cost==null?null:m.cost,saleId:null,returnId:null,...tk(m)}); });
  (sales||[]).forEach(s=>{ sale[s.id]=s; if(s.void) return;
    s.items.forEach((i,k)=>{ const vid=rv(i); if(!vid) return;
      out.push({id:"s:"+s.id+":"+(i.ln!=null?i.ln:k),t:s.t,vid,pid:i.p||null,type:s.kind==="exchange"?"EXCHANGE_OUT":"SALE",q:-i.q,pieces:i.q,ref:s.no||"",note:"",cost:i.cost==null?null:i.cost,saleId:s.id,returnId:null,...tk(i)}); }); });
  (returns||[]).forEach(r=>{ const s=sale[r.sale]; if(s&&s.void) return;
    (r.items||[]).forEach((i,k)=>{ const vid=rv(i); if(!vid) return; const back=restocks(i);
      out.push({id:"r:"+r.id+":"+k,t:r.t,vid,pid:i.p||null,type:!back?"NOT_FOR_RESALE":r.kind==="exchange"?"EXCHANGE_IN":"RETURN",q:back?i.q:0,pieces:i.q,
        ref:r.no||(s&&s.no)||"",note:r.note||"",cost:i.cost==null?null:i.cost,saleId:r.sale,returnId:r.id,...tk(i)}); }); });
  return out.sort((a,b)=>a.t-b.t||(a.id<b.id?-1:a.id>b.id?1:0));
}
/* Stock on hand per variant: { vid: pieces } */
export function onHand(entries){
  const n={}; (entries||[]).forEach(e=>{n[e.vid]=roundQty((n[e.vid]||0)+e.q)}); return n;
}
/* Entries with the variant's stock after each one (for the history of one variant or all) */
export function withBalance(entries){
  const bal={}; return (entries||[]).map(e=>{bal[e.vid]=roundQty((bal[e.vid]||0)+e.q);return {...e,balance:bal[e.vid]}});
}
/* Movement in a period (ms, inclusive): { byType: { TYPE: { pieces, entries } }, inPieces, outPieces, net } */
export function movementTotals(entries,{from=-Infinity,to=Infinity}={}){
  const by={}; let inP=0,outP=0;
  (entries||[]).forEach(e=>{ if(e.t<from||e.t>to) return; const o=by[e.type]||(by[e.type]={pieces:0,entries:0});
    o.pieces=roundQty(o.pieces+(e.type==="ADJUST"?e.q:Math.abs(e.pieces))); o.entries++;   // adjustments keep their sign (a recount can go either way)
    if(e.q>0) inP=roundQty(inP+e.q); else outP=roundQty(outP-e.q); });
  return {byType:by,inPieces:inP,outPieces:outP,net:roundQty(inP-outP)};
}
/* Filter entries by product, variant and type (any left empty matches everything) */
export const filterEntries=(entries,{pid,vid,type}={})=>(entries||[]).filter(e=>(!pid||e.pid===pid)&&(!vid||e.vid===vid)&&(!type||e.type===type));
