// Inventory → Serials & batches: find any serial number (where it came from, which bill sold it and to whom, returns,
// write-offs), how many serials are in stock / sold / returned / written off, and every batch with its stock and expiry
// (expired and expiring soon first), each with its history. Worked out from the same records as stock
// (domain/inventory/tracking.js); nothing here is stored separately.
// store.trackView = { q (serial search), status ("" | a serial status), exp ("" | "soon" | "expired"), open (a batch key shown with its history) }
import { store } from '../../../shared/state/store.js';
import { vLabel } from '../../../domain/catalog/variants.js';
import { EXPIRY_LABELS, SERIAL_STATES, SERIAL_STATUS_KEYS, fefoOrder, normSerial } from '../../../domain/inventory/tracking.js';
import { qtyText } from '../../../domain/catalog/units.js';
import { vRec } from '../services/ledger.js';
import { allBatches, allSerials, expiryDays, expiryOf, serialState } from '../services/tracking.js';
import { kpi } from '../../../shared/components/kpi.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dtLong } from '../../../shared/formatting/dates.js';
import { csvText } from '../../../shared/utils/csv.js';

const MAX_ROWS=200;
const V=()=>store.trackView||(store.trackView={q:"",status:"",exp:"",open:""});
const nameOf=vid=>{const r=vRec(vid);return r?[r.p.name,vLabel(r.v)].filter(Boolean).join(" · "):"(removed product)"};
const purchaseRef=imp=>{const p=imp&&(store.purchases||{})[imp];return p?[p.supplier,p.invoiceNo&&"invoice "+p.invoiceNo].filter(Boolean).join(" · "):""};

function serialCardHTML(s){
  const hist=s.history.slice().reverse().map(h=>`<li><span class="mv-t">${esc(dtLong(h.t))}</span> <b>${esc(h.what)}</b>${h.ref?" · "+esc(h.ref):h.imp&&purchaseRef(h.imp)?" · "+esc(purchaseRef(h.imp)):""}${h.cust?" · "+esc(h.cust):""}</li>`).join("");
  return `<div class="card trk-sn" data-sncard="${esc(s.sn)}"><div class="card-h"><div><h3>Serial ${esc(s.sn)}</h3><p class="note">${esc(nameOf(s.vid))}</p></div><span class="snst ${s.status.toLowerCase()}">${esc(SERIAL_STATES[s.status])}</span></div>
    ${s.status==="SOLD"&&s.saleId?`<p>On bill ${esc((s.history.slice().reverse().find(h=>h.id===s.saleId)||{}).ref||"")}${s.cust?` · ${esc(s.cust.name)}${s.cust.phone?" ("+esc(s.cust.phone)+")":""}`:""} <button type="button" class="link xs" data-billview="${esc(s.saleId)}">Open bill</button></p>`:""}
    <ul class="trk-hist">${hist}</ul></div>`;
}
function serialsHTML(){
  const F=V(), all=allSerials(); if(!all.length) return "";
  const n=k=>all.filter(s=>s.status===k).length, q=normSerial(F.q), exact=q?serialState(q):null;
  const list=all.filter(s=>(!F.status||s.status===F.status)&&(!q||s.sn.includes(q))).sort((a,b)=>b.t-a.t);
  const rows=list.slice(0,MAX_ROWS).map(s=>`<tr><td><button type="button" class="link" data-snfind="${esc(s.sn)}">${esc(s.sn)}</button></td><td>${esc(nameOf(s.vid))}</td><td><span class="snst ${s.status.toLowerCase()}">${esc(SERIAL_STATES[s.status])}</span></td><td>${s.cust?esc(s.cust.name):""}</td><td>${s.t?esc(dayKey(s.t)):""}</td></tr>`).join("");
  return `<div class="card"><div class="card-h"><h3>Serial numbers</h3><button type="button" class="btn xs" data-trkcsv="serials">Download CSV</button></div>
    <div class="kpis four">${kpi("In stock",String(n("IN_STOCK")+n("RETURNED")),n("RETURNED")?`${n("RETURNED")} back from returns`:"ready to sell")}${kpi("Sold",String(n("SOLD")),"on bills")}${kpi("Returned",String(n("RETURNED")),"back on the shelf")}${kpi("Written off",String(n("DAMAGED")+n("CANCELLED")),"damaged, lost or purchase cancelled",n("DAMAGED")?"warn":"")}</div>
    <div class="filters"><form id="tvForm" class="search" autocomplete="off"><input id="tvQ" type="search" placeholder="Find a serial or IMEI number" value="${esc(F.q)}" aria-label="Serial number"></form>
      <select id="tvStatus" class="sel" aria-label="Status"><option value="">Every status</option>${SERIAL_STATUS_KEYS.map(k=>`<option value="${k}"${F.status===k?" selected":""}>${esc(SERIAL_STATES[k])}</option>`).join("")}</select></div>
    ${exact?serialCardHTML(exact):""}
    ${list.length?`<div class="tw"><table class="pu-lines ro"><thead><tr><th>Serial</th><th>Product</th><th>Status</th><th>Customer</th><th>Last change</th></tr></thead><tbody>${rows}</tbody></table></div>${list.length>MAX_ROWS?`<p class="note">Showing ${MAX_ROWS} of ${list.length}: search to narrow down.</p>`:""}`:`<p class="muted">No serial number matches.</p>`}</div>`;
}
function batchesHTML(){
  const F=V(), all=allBatches().filter(b=>vRec(b.vid)); if(!all.length) return "";
  const withX=all.map(b=>({b,x:expiryOf(b.exp)})), inStock=withX.filter(a=>a.b.qty>0);
  const expired=inStock.filter(a=>a.x==="expired").length, soon=inStock.filter(a=>a.x==="soon").length;
  const list=withX.filter(a=>F.exp==="expired"?a.b.qty>0&&a.x==="expired":F.exp==="soon"?a.b.qty>0&&a.x==="soon":F.exp==="empty"?a.b.qty<=0:a.b.qty>0)
    .sort((a,b)=>fefoOrder(a.b,b.b));
  const rows=list.slice(0,MAX_ROWS).map(({b,x})=>{const k=b.vid+"|"+b.b, r=vRec(b.vid), open=F.open===k;
    return `<tr class="${x||""}"><td><button type="button" class="link" data-btopen="${esc(k)}" aria-expanded="${open}">${esc(b.b)}</button></td><td>${esc(nameOf(b.vid))}</td><td>${b.exp?esc(b.exp):"—"}${x?` <em class="exp ${x}">${EXPIRY_LABELS[x]}</em>`:""}</td><td class="num">${esc(qtyText(b.qty,r.p.unit))}</td><td>${b.t?esc(dayKey(b.t)):""}${b.imp&&purchaseRef(b.imp)?" · "+esc(purchaseRef(b.imp)):""}</td></tr>`
      +(open?`<tr class="bt-hist"><td colspan="5"><ul class="trk-hist">${b.history.slice().reverse().map(h=>`<li><span class="mv-t">${esc(dtLong(h.t))}</span> <b>${esc(h.what)}</b> ${h.q>0?"+":""}${esc(qtyText(h.q,r.p.unit))}${h.ref?" · "+esc(h.ref):""}</li>`).join("")}</ul></td></tr>`:"");}).join("");
  return `<div class="card" style="margin-top:14px"><div class="card-h"><h3>Batches</h3><button type="button" class="btn xs" data-trkcsv="batches">Download CSV</button></div>
    <div class="kpis four">${kpi("Batches in stock",String(inStock.length),"")}${kpi("Expiring soon",String(soon),`within ${expiryDays()} days`,soon?"warn":"")}${kpi("Expired",String(expired),"still in stock",expired?"crit":"")}${kpi("Used up",String(withX.length-inStock.length),"no stock left")}</div>
    <div class="seg" role="group" aria-label="Show">${[["","In stock"],["soon","Expiring soon"],["expired","Expired"],["empty","Used up"]].map(([k,l])=>`<button data-tvexp="${k}" aria-pressed="${F.exp===k}">${l}</button>`).join("")}</div>
    ${list.length?`<div class="tw"><table class="pu-lines ro"><thead><tr><th>Batch</th><th>Product</th><th>Expiry</th><th class="num">In stock</th><th>Received</th></tr></thead><tbody>${rows}</tbody></table></div>${list.length>MAX_ROWS?`<p class="note">Showing ${MAX_ROWS} of ${list.length}.</p>`:""}`:`<p class="muted">No batch here.</p>`}</div>`;
}
export function renderTrackingView(host){
  const h=serialsHTML()+batchesHTML();
  host.innerHTML=h||`<div class="card"><p class="muted">No serial numbers or batches yet. Choose how a product is tracked in its form (Products → the product → Track stock by), then bring its stock in through Purchases or Stock in.</p></div>`;
}
const rerender=()=>{const h=$('[data-subalt="stock"]');if(h)renderTrackingView(h)};
/* CSV of every serial or every batch */
export async function exportTrackingCsv(kind){
  let rows;
  if(kind==="serials"){
    const all=allSerials(); if(!all.length){ toast("No serial numbers yet."); return; }
    rows=[["Serial","Product","Status","Customer","Bill","Stock record","Purchase","Last change"],...all.map(s=>[s.sn,nameOf(s.vid),SERIAL_STATES[s.status],s.cust?s.cust.name:"",s.saleId?((s.history.slice().reverse().find(h=>h.id===s.saleId)||{}).ref||s.saleId):"",s.inId||"",purchaseRef(s.imp)||s.imp||"",s.t?dayKey(s.t):""])];
  } else {
    const all=allBatches().filter(b=>vRec(b.vid)); if(!all.length){ toast("No batches yet."); return; }
    rows=[["Batch","Product","Expiry","Expiry state","In stock","Unit","Cost","Received","Purchase"],...all.sort(fefoOrder).map(b=>{const r=vRec(b.vid),x=expiryOf(b.exp);return [b.b,nameOf(b.vid),b.exp||"",x?EXPIRY_LABELS[x]:"",b.qty,r.p.unit||"pcs",b.cost==null?"":b.cost,b.t?dayKey(b.t):"",purchaseRef(b.imp)||b.imp||""]})];
  }
  await use("files").saveFile(`${kind}-${dayKey(Date.now())}.csv`,"﻿"+csvText(rows),"text/csv");
}
/* ---------- events (inventory-views.js routes them here) ---------- */
export function trackViewClick(t){
  const F=V();
  const f=t.closest("[data-snfind]"); if(f){ F.q=f.dataset.snfind; rerender(); window.scrollTo(0,0); return true; }
  const e=t.closest("[data-tvexp]"); if(e){ F.exp=e.dataset.tvexp; rerender(); return true; }
  const o=t.closest("[data-btopen]"); if(o){ F.open=F.open===o.dataset.btopen?"":o.dataset.btopen; rerender(); return true; }
  const c=t.closest("[data-trkcsv]"); if(c){ exportTrackingCsv(c.dataset.trkcsv); return true; }
  return false;
}
export function trackViewInput(t){
  if(t.id!=="tvQ") return false;
  V().q=t.value; const pos=t.selectionStart; rerender(); const i=$("#tvQ"); if(i){ i.focus(); i.setSelectionRange(pos,pos); }
  return true;
}
export function trackViewChange(t){
  if(t.id!=="tvStatus") return false;
  V().status=t.value; rerender(); return true;
}
export function trackViewSubmit(e){
  if(e.target.id!=="tvForm") return false;
  e.preventDefault(); rerender(); return true;
}
