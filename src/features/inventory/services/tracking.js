// Serial numbers, batches and expiry dates on this device: a read model over the same stock records, bills and returns as
// stock itself (D().serials / D().batches, domain/inventory/tracking.js), with this shop's expiry settings
// (settings.expiryDays: days of warning before a batch expires; settings.sellExpired: expired stock may still be sold).
import { store } from '../../../shared/state/store.js';
import { D, vRec } from './ledger.js';
import { stockOf } from './stock.js';
import { cleanTracking } from '../../../domain/shop/capabilities.js';
import { DEFAULT_EXPIRY_DAYS, allocateBatches, expiryState, fefoOrder, lineSerialError, normBatch, normSerial, serialAvailable } from '../../../domain/inventory/tracking.js';
import { vLabel } from '../../../domain/catalog/variants.js';
import { qtyText, roundQty, sumQty } from '../../../domain/catalog/units.js';
import { dayKey } from '../../../shared/formatting/dates.js';

/* ---------- how a product is tracked ---------- */
export const trackingOfP=p=>cleanTracking(p&&p.tracking);
export const vTracking=vid=>{const r=vRec(vid);return r?trackingOfP(r.p):"none"};
export const isSerialV=vid=>vTracking(vid)==="serial";
export const isBatchV=vid=>vTracking(vid)==="batch";
/* a batch-tracked product whose batches have expiry dates */
export const expiryKept=p=>trackingOfP(p)==="batch"&&!!(p&&p.expiry);
const nameOf=vid=>{const r=vRec(vid);return r?[r.p.name,vLabel(r.v)].filter(Boolean).join(" · "):"this item"};

/* ---------- the shop's expiry settings ---------- */
export const expiryDays=()=>{const n=+store.settings.expiryDays;return store.settings.expiryDays!=null&&Number.isFinite(n)&&n>=0?Math.round(n):DEFAULT_EXPIRY_DAYS};
export const blockExpired=()=>store.settings.sellExpired!==true;
export const today=()=>dayKey(Date.now());
/* "expired" | "soon" | "fresh" | null (no expiry date) */
export const expiryOf=exp=>expiryState(exp,today(),expiryDays());

/* ---------- serials ---------- */
export const serialState=sn=>D().serials.get(normSerial(sn))||null;
/* A variant's serials (available: only those ready to sell), in order */
export function serialsOf(vid,{available}={}){
  const out=[]; D().serials.forEach(s=>{ if(s.vid===vid&&(!available||serialAvailable(s))) out.push(s); });
  return out.sort((a,b)=>a.sn<b.sn?-1:a.sn>b.sn?1:0);
}
export const allSerials=()=>[...D().serials.values()];
/* A code scanned at the till that is a serial ready to sell → its state, else null */
export const serialForSale=code=>{const s=serialState(code);return s&&serialAvailable(s)&&vRec(s.vid)&&vTracking(s.vid)==="serial"?s:null};

/* ---------- batches ---------- */
/* A variant's batches (all: also those used up), first to expire first */
export const batchesOf=(vid,{all}={})=>Object.values(D().batches.byVid[vid]||{}).filter(b=>all||b.qty>0).sort(fefoOrder);
export const batchOf=(vid,b)=>(D().batches.byVid[vid]||{})[normBatch(b)]||null;
export const batchQty=(vid,b)=>{const x=batchOf(vid,b);return x?x.qty:0};
export const allBatches=()=>Object.values(D().batches.byVid).flatMap(m=>Object.values(m));
/* What a bill line took from each batch, and what its returns put back */
export const lineAllocOf=(saleId,ln)=>D().batches.lineAlloc[saleId+"|"+ln]||null;
export const lineBackOf=(saleId,ln)=>D().batches.backByLine[saleId+"|"+ln]||[];
/* Stock of a variant in batches that have expired */
export const expiredQtyOf=vid=>{const d=today();return sumQty(batchesOf(vid).filter(b=>b.exp&&b.exp<d).map(b=>b.qty))};

/* What of a variant can be sold now: its serials ready to sell; for batches, the stock that hasn't expired (unless the
   shop sells expired stock); anything else, its stock */
export function sellableOf(vid){
  const t=vTracking(vid);
  if(t==="serial") return serialsOf(vid,{available:true}).length;
  const n=stockOf(vid);
  return t==="batch"&&blockExpired()?roundQty(n-expiredQtyOf(vid)):n;
}

/* ---------- a bill's lines ---------- */
/* The serials and batches of bill lines (cart lines { v, q, sn?, bp? (a batch chosen for the line) }):
   → { items: [{ sn? } | { bt? } | {}] (one per line) } or { error, line } */
export function trackSaleLines(lines){
  const taken={}, out=[], d=today(), block=blockExpired();
  for(const [k,c] of (lines||[]).entries()){
    const t=vTracking(c.v);
    if(t==="serial"){
      const e=lineSerialError(c,serialState,nameOf(c.v)); if(e) return {error:e,line:k};
      out.push({sn:c.sn.map(normSerial)});
    } else if(t==="batch"){
      const tk=taken[c.v]||(taken[c.v]={}), r=allocateBatches(batchesOf(c.v),c.q,{prefer:c.bp?normBatch(c.bp):null,today:d,blockExpired:block,taken:tk});
      if(r.short>0){
        const ok=roundQty(c.q-r.short), exp=block?expiredQtyOf(c.v):0, r0=vRec(c.v), u=r0&&r0.p.unit;
        return {error:`Only ${qtyText(ok,u)} of ${nameOf(c.v)} can be sold${exp>0?`: ${qtyText(exp,u)} in stock has expired`:""}.`,line:k};
      }
      r.alloc.forEach(a=>{tk[a.b]=roundQty((tk[a.b]||0)+a.q)});
      out.push({bt:r.alloc});
    } else out.push({});
  }
  return {items:out};
}
/* Restoring a cancelled bill: its serials must still be free (not sold again, written off …) → error text or null */
export function restoreSerialError(sale){
  for(const i of (sale&&sale.items)||[]) for(const x of i.sn||[]){
    const s=serialState(x);
    if(!s||!serialAvailable(s)) return `Serial ${normSerial(x)} of this bill ${s&&s.status==="SOLD"?"was sold again on another bill":"isn't in stock any more"}, so the bill can't be restored.`;
  }
  return null;
}
