// Serial numbers, batches and expiry dates. Nothing here is a second stock: serials and batches ride on the records that
// already make stock (domain/inventory/stock-ledger.js), and their state is worked out from them, oldest first:
//   stock records   sn: [serials] (a record adding stock brings them in; one taking stock out writes them off or, for a
//                   cancelled purchase, cancels them) · b: batch number · exp: its expiry date ("yyyy-mm-dd")
//   bill lines      sn: [serials sold] · bt: [{ b, q }] (how much came from each batch)
//   return lines    sn: [serials back] · bt: [{ b, q }] (back into the batches they came from)
// Cancelled bills leave no trace (their serials and batch quantities are back), exactly as for stock. The database keeps
// the same rules (supabase/schema.sql section 3n) and refuses a serial sold twice. Pure.
import { restocks } from '../returns/return-value.js';
import { roundQty, subQty } from '../catalog/units.js';

/* ---------- serial numbers ---------- */
export const SERIAL_STATES={IN_STOCK:"In stock",SOLD:"Sold",RETURNED:"Returned",DAMAGED:"Damaged / written off",CANCELLED:"Cancelled"};
export const SERIAL_STATUS_KEYS=Object.keys(SERIAL_STATES);
/* A serial that can be sold: in stock, or back on the shelf after a return */
export const serialAvailable=s=>!!s&&(s.status==="IN_STOCK"||s.status==="RETURNED");
export const MAX_SERIALS=1000;
const SERIAL_RE=/^[A-Z0-9][A-Z0-9./_:#-]{0,59}$/;
/* Serial numbers are compared without case and surrounding spaces ("sn-01 " is SN-01) */
export const normSerial=s=>String(s==null?"":s).trim().toUpperCase();
export const validSerial=s=>SERIAL_RE.test(s);
const badSerial=s=>`"${String(s).slice(0,30)}" isn't a serial number: use letters, digits and . / _ : # - (up to 60, no spaces).`;
/* Serials typed, pasted or scanned: one per line, or between spaces, commas or semicolons; "SN001..SN010" is a range.
   → { serials } (in the order given) or { error } (a serial typed twice, a bad one, too many) */
export function parseSerials(text){
  const parts=String(text==null?"":text).split(/[\s,;]+/).map(normSerial).filter(Boolean), out=[], seen=new Set();
  const push=s=>{ if(!validSerial(s)) return badSerial(s); if(seen.has(s)) return `${s} is there twice.`; seen.add(s); out.push(s); return out.length>MAX_SERIALS?`At most ${MAX_SERIALS} serial numbers at a time.`:null; };
  for(const p of parts){
    const r=p.split("..");
    if(r.length===2){
      const a=/^(.*?)(\d+)$/.exec(r[0]), b=/^(.*?)(\d+)$/.exec(r[1]);
      if(!a||!b||(b[1]&&b[1]!==a[1])) return {error:`"${p.slice(0,40)}" isn't a range: write it like SN001..SN010.`};
      const from=+a[2], to=+b[2];
      if(to<from) return {error:`"${p.slice(0,40)}" counts down: write the smaller number first.`};
      if(to-from>=MAX_SERIALS) return {error:`At most ${MAX_SERIALS} serial numbers at a time.`};
      for(let n=from;n<=to;n++){ const e=push(a[1]+String(n).padStart(a[2].length,"0")); if(e) return {error:e}; }
    } else { const e=push(p); if(e) return {error:e}; }
  }
  return {serials:out};
}

/* ---------- batches and expiry ---------- */
const BATCH_RE=/^[A-Z0-9][A-Z0-9 ./_:#-]{0,39}$/;
export const normBatch=s=>String(s==null?"":s).trim().replace(/\s+/g," ").toUpperCase();
export const validBatch=b=>BATCH_RE.test(b);
/* A typed batch number → { b } or { error } */
export function checkBatchNo(raw){
  const b=normBatch(raw);
  if(!b) return {error:"Enter the batch number."};
  if(!validBatch(b)) return {error:"A batch number has up to 40 letters, digits, spaces and . / _ : # -"};
  return {b};
}
export const validDay=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||"")&&!isNaN(Date.parse(d+"T00:00:00Z"))&&new Date(d+"T00:00:00Z").toISOString().slice(0,10)===d;
/* "yyyy-mm-dd" n days later */
export const plusDays=(day,n)=>new Date(Date.parse(day+"T00:00:00Z")+n*86400000).toISOString().slice(0,10);
export const DEFAULT_EXPIRY_DAYS=30;
export const EXPIRY_LABELS={expired:"Expired",soon:"Expiring soon",fresh:"Fresh"};
/* A batch's expiry on a day: "expired" (the day after its expiry date), "soon" (within `days` days), "fresh", or null
   (no expiry date). days: the shop's warning period (settings.expiryDays). */
export function expiryState(exp,today,days){
  if(!exp) return null;
  if(exp<today) return "expired";
  return exp<=plusDays(today,Math.max(0,Math.round(+days>=0?+days:DEFAULT_EXPIRY_DAYS)))?"soon":"fresh";
}
/* The order batches are sold in: the one that expires first (no expiry date last), then the one received first */
export const fefoOrder=(a,b)=>(a.exp||"9999-99-99").localeCompare(b.exp||"9999-99-99")||(a.t||0)-(b.t||0)||(a.b<b.b?-1:a.b>b.b?1:0);
/* Which batches a quantity comes from. list: [{ b, qty, exp, t }] (a variant's batches) · opts: { prefer (a batch chosen
   first), today, blockExpired (skip expired batches), taken ({ b: already taken by other lines of the same bill }) }
   → { alloc: [{ b, q }], short (what no batch has) } */
export function allocateBatches(list,qty,opts={}){
  const o=opts||{}, taken=o.taken||{}, left=b=>roundQty((+b.qty||0)-(+taken[b.b]||0));
  const usable=(list||[]).filter(b=>left(b)>0&&!(o.blockExpired&&b.exp&&o.today&&b.exp<o.today)).sort(fefoOrder);
  if(o.prefer){ const i=usable.findIndex(b=>b.b===o.prefer); if(i>0) usable.unshift(usable.splice(i,1)[0]); }
  const alloc=[]; let need=roundQty(qty);
  for(const b of usable){ if(need<=0) break; const q=Math.min(need,left(b)); if(q>0){ alloc.push({b:b.b,q:roundQty(q)}); need=roundQty(need-q); } }
  return {alloc,short:Math.max(0,need)};
}
/* The batches a return of q from a bill line goes back into: what the line took from each batch, less what earlier returns
   of the line put back, in the line's order → [{ b, q }] */
export function returnBatchAlloc(lineAlloc,priorBack,q){
  const back={}; (priorBack||[]).forEach(x=>{back[x.b]=roundQty((back[x.b]||0)+(+x.q||0))});
  const out=[]; let need=roundQty(q);
  for(const a of lineAlloc||[]){ if(need<=0) break; const room=Math.max(0,subQty(a.q,back[a.b]||0)); const take=Math.min(room,need); if(take>0){ out.push({b:a.b,q:roundQty(take)}); need=roundQty(need-take); back[a.b]=roundQty((back[a.b]||0)+take); } }
  return out;
}

/* ---------- state from the records (the same records, and order, as the stock ledger) ---------- */
const lineNo=(i,k)=>i.ln!=null?i.ln:k;
/* a stock record taking serials out is a cancelled stock-in (a cancelled purchase: "pcx:" ids) or a write-off */
const outStatus=m=>String(m.id||"").startsWith("pcx:")?"CANCELLED":"DAMAGED";
function events({moves,sales,returns}){
  const ev=[];
  Object.values(moves||{}).forEach(m=>{ if(m&&m.v) ev.push({t:+m.t||0,k:m.q>0?0:3,id:"m:"+m.id,m}); });
  (sales||[]).forEach(s=>s.items.forEach((i,k)=>ev.push({t:+s.t||0,k:1,id:"s:"+s.id+":"+k,s,i,ln:lineNo(i,k)})));
  (returns||[]).forEach(r=>(r.items||[]).forEach((i,k)=>ev.push({t:+r.t||0,k:2,id:"r:"+r.id+":"+k,r,i})));
  return ev.sort((a,b)=>a.t-b.t||a.k-b.k||(a.id<b.id?-1:a.id>b.id?1:0));
}
/* Every serial number's state and history.
   → Map serial → { sn, vid, pid, status, inId (the stock record that brought it in), imp (its purchase), saleId, ln, cust,
     returnId, t (last change), history: [{ t, what, ref, id }] } */
export function serialStates({moves,sales,returns,resolve}){
  const map=new Map(), rv=i=>resolve?resolve(i):(i.v||null), saleById={};
  (sales||[]).forEach(s=>{saleById[s.id]=s});
  const rec=(sn,vid,pid)=>{let o=map.get(sn);if(!o){o={sn,vid,pid:pid||null,status:"IN_STOCK",inId:null,imp:null,saleId:null,ln:null,cust:null,returnId:null,t:0,history:[]};map.set(sn,o)}return o};
  events({moves,sales,returns}).forEach(e=>{
    if(e.m){
      const m=e.m; if(!Array.isArray(m.sn)||!m.sn.length) return;
      m.sn.forEach(x=>{ const sn=normSerial(x), o=rec(sn,m.v,m.p);
        if(m.q>0){ Object.assign(o,{vid:m.v,pid:m.p||o.pid,status:"IN_STOCK",inId:m.id,imp:m.imp||null,saleId:null,ln:null,cust:null,returnId:null,t:e.t});
          o.history.push({t:e.t,what:m.imp?"Purchased":m.type==="OPENING"?"Opening stock":m.type==="ADJUST"?"Found (adjustment)":"Stock in",ref:m.note||"",id:m.id,imp:m.imp||null}); }
        else { o.status=outStatus(m); o.t=e.t; o.history.push({t:e.t,what:o.status==="CANCELLED"?"Purchase cancelled":"Written off",ref:m.note||"",id:m.id}); }
      });
    } else if(e.s){
      const s=e.s, i=e.i; if(!Array.isArray(i.sn)||!i.sn.length) return;
      i.sn.forEach(x=>{ const sn=normSerial(x), o=rec(sn,rv(i),i.p);
        if(s.void){ o.history.push({t:e.t,what:"Sold, bill cancelled",ref:s.no||"",id:s.id}); return; }
        Object.assign(o,{status:"SOLD",saleId:s.id,ln:e.ln,cust:s.cust&&s.cust.name?{id:s.cust.id||null,name:s.cust.name,phone:s.cust.phone||""}:null,returnId:null,t:e.t});
        o.history.push({t:e.t,what:"Sold",ref:s.no||"",id:s.id,cust:s.cust&&s.cust.name||""});
      });
    } else {
      const r=e.r, i=e.i, s=saleById[r.sale]; if(!Array.isArray(i.sn)||!i.sn.length||(s&&s.void)) return;
      i.sn.forEach(x=>{ const sn=normSerial(x), o=rec(sn,rv(i),i.p);
        o.status=restocks(i)?"RETURNED":"DAMAGED"; o.returnId=r.id; o.t=e.t;
        o.history.push({t:e.t,what:restocks(i)?"Returned":"Returned, not for resale",ref:r.no||"",id:r.id});
      });
    }
  });
  return map;
}
/* Every batch of every variant, and what each bill line took from them.
   batchTracked(vid): the variant's product is tracked by batch (a bill line of one without an allocation — saved by an
   older app version — takes from the batches first to expire, at the time of the bill).
   → { byVid: { vid: { b: { b, vid, pid, exp, qty, cost, imp, t (first received), history: [{ t, what, q, ref, id }] } } },
       lineAlloc: { "saleId|ln": [{ b, q }] } } */
export function batchStates({moves,sales,returns,resolve,batchTracked}){
  const byVid={}, lineAlloc={}, backByLine={}, rv=i=>resolve?resolve(i):(i.v||null), saleById={};
  (sales||[]).forEach(s=>{saleById[s.id]=s});
  const rec=(vid,b,pid)=>{const m=byVid[vid]||(byVid[vid]={});return m[b]||(m[b]={b,vid,pid:pid||null,exp:null,qty:0,cost:null,imp:null,t:null,history:[]})};
  const take=(vid,alloc,t,what,ref,id,sign)=>alloc.forEach(a=>{const o=rec(vid,a.b);o.qty=roundQty(o.qty+sign*a.q);o.history.push({t,what,q:roundQty(sign*a.q),ref,id})});
  events({moves,sales,returns}).forEach(e=>{
    if(e.m){
      const m=e.m; if(!m.b) return;
      const o=rec(m.v,normBatch(m.b),m.p), q=roundQty(m.q);
      o.qty=roundQty(o.qty+q);
      if(q>0&&o.t==null){ o.t=e.t; o.cost=m.cost==null?null:m.cost; o.imp=m.imp||null; }
      if(m.exp&&!o.exp) o.exp=m.exp;
      o.history.push({t:e.t,what:m.imp&&q>0?"Purchased":m.imp?"Purchase cancelled":m.type==="OPENING"?"Opening stock":m.type==="ADJUST"?"Adjustment":"Stock in",q,ref:m.note||"",id:m.id});
    } else if(e.s){
      const s=e.s, i=e.i, vid=rv(i); if(!vid||s.void) return;
      let alloc=Array.isArray(i.bt)&&i.bt.length?i.bt.map(a=>({b:normBatch(a.b),q:roundQty(a.q)})):null;
      if(!alloc){ if(!batchTracked||!batchTracked(vid)||!byVid[vid]) return;
        alloc=allocateBatches(Object.values(byVid[vid]),i.q).alloc; }
      lineAlloc[s.id+"|"+e.ln]=alloc;
      take(vid,alloc,e.t,"Sold",s.no||"",s.id,-1);
    } else {
      const r=e.r, i=e.i, vid=rv(i), s=saleById[r.sale]; if(!vid||(s&&s.void)) return;
      const key=r.sale+"|"+i.ln;
      let alloc=Array.isArray(i.bt)&&i.bt.length?i.bt.map(a=>({b:normBatch(a.b),q:roundQty(a.q)})):null;
      if(!alloc){ if(!lineAlloc[key]) return; alloc=returnBatchAlloc(lineAlloc[key],backByLine[key],i.q); }
      (backByLine[key]=backByLine[key]||[]).push(...alloc);
      if(restocks(i)) take(vid,alloc,e.t,"Returned",r.no||"",r.id,1);
      else alloc.forEach(a=>rec(vid,a.b).history.push({t:e.t,what:"Returned, not for resale",q:0,ref:r.no||"",id:r.id}));
    }
  });
  return {byVid,lineAlloc,backByLine};
}

/* ---------- checks ---------- */
/* A bill line's serials: exactly one per piece, each once, of this variant and ready to sell (not on another bill).
   stateOf(sn): the serial's state (or null) · → error text or null */
export function lineSerialError(line,stateOf,label){
  const sn=Array.isArray(line.sn)?line.sn.map(normSerial):[], what=label||line.name||line.n||"this item";
  if(!sn.length) return `Choose the serial number${line.q>1?"s":""} of ${what}.`;
  if(sn.length!==line.q) return `${what}: ${line.q} piece${line.q===1?"":"s"} but ${sn.length} serial number${sn.length===1?"":"s"}.`;
  if(new Set(sn).size!==sn.length) return `${what}: a serial number is on the bill twice.`;
  for(const x of sn){ const s=stateOf(x);
    if(!s||s.vid!==line.v) return `Serial ${x} isn't in stock for ${what}.`;
    if(!serialAvailable(s)) return `Serial ${x} is ${s.status==="SOLD"?"already sold":SERIAL_STATES[s.status].toLowerCase()}.`; }
  return null;
}
/* A stock-in of serials: none of them may be in stock or on a bill already → error text or null */
export function incomingSerialError(serials,stateOf){
  for(const x of serials||[]){ const s=stateOf(normSerial(x)); if(!s) continue;
    if(serialAvailable(s)) return `Serial ${normSerial(x)} is already in stock.`;
    if(s.status==="SOLD") return `Serial ${normSerial(x)} is on a bill (sold). Take it back with a return instead.`; }
  return null;
}
/* A batch's expiry typed with a stock-in → { exp } or { error }. required: the product keeps expiry dates.
   known: the batch's expiry already recorded (it must be the same). */
export function checkExpiry(raw,{required,today,known}={}){
  const exp=String(raw==null?"":raw).trim();
  if(!exp){ if(required&&!known) return {error:"Enter the expiry date."}; return {exp:known||null}; }
  if(!validDay(exp)) return {error:"Enter the expiry date as a date."};
  if(known&&known!==exp) return {error:`This batch already has the expiry date ${known}.`};
  if(today&&exp<today) return {error:`That expiry date (${exp}) has passed: expired stock can't be taken in.`};
  return {exp};
}
