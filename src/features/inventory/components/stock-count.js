// Inventory → Stock count: pick products (search, category), type what is on the shelf next to what the records say, see
// the difference, review it with a reason, confirm → one ADJUST stock record per difference (note "Stock count: <reason>").
// store.stockCount = { q, cat, typed: { vid: text }, review: null | { lines, changed } (as reviewed), reason, note, err }
import { store } from '../../../shared/state/store.js';
import { vLabel, variantsOf } from '../../../domain/catalog/variants.js';
import { COUNT_REASONS, countDiffs } from '../../../domain/inventory/stock-count.js';
import { IMPORT_UNITS } from '../../../domain/catalog/product-import.js';
import { stockOf } from '../services/stock.js';
import { confirmStockCount } from '../use-cases/count-stock.js';
import { categories, liveProducts, prod } from '../../products/services/catalog.js';
import { productText, variantText } from '../../sales/services/search.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { can } from '../../shop/services/access.js';
import { toast } from '../../../shared/components/toast.js';
import { $, esc } from '../../../shared/dom.js';
import { norm } from '../../../shared/utils/text.js';

const MAX_ROWS=300;
const S=()=>store.stockCount||(store.stockCount={q:"",cat:"",typed:{},review:null,reason:COUNT_REASONS[0],note:"",err:""});
const decOf=p=>{const u=IMPORT_UNITS.find(x=>x[0]===(p&&p.unit));return u?u[2]:0};
/* Every counted row of the catalog as it is now: [{ vid, pid, system, dec }] */
function countRows(){
  const out=[];
  liveProducts().forEach(p=>variantsOf(p).forEach(v=>out.push({vid:v.id,pid:p.id,system:stockOf(v.id),dec:decOf(p)})));
  return out;
}
function shown(){
  const s=S(), toks=norm(s.q).split(/\s+/).filter(Boolean), out=[];
  liveProducts().forEach(p=>{ if(s.cat&&p.cat!==s.cat) return; variantsOf(p).forEach(v=>{ if(!toks.length||toks.every(t=>productText(p).includes(t)||variantText(p,v).includes(t))) out.push({p,v}); }); });
  return out;
}
const diffText=d=>d>0?`+${d}`:String(d);
function diffOf(vid){ const raw=S().typed[vid]; if(raw==null||String(raw).trim()==="") return null; const n=Number(String(raw).replace(/,/g,"")); return Number.isFinite(n)?Math.round((n-stockOf(vid))*1000)/1000:null; }
export function renderStockCountView(host){
  const s=S();
  if(!can("manage_inventory")){ host.innerHTML=`<p class="muted">Your role can't count stock.</p>`; return; }
  if(s.review){ host.innerHTML=reviewHTML(); return; }
  const list=shown(), cs=categories(), typedN=Object.values(s.typed).filter(x=>String(x).trim()!=="").length;
  const rows=list.slice(0,MAX_ROWS).map(({p,v})=>{const d=diffOf(v.id);return `<tr><td><b>${esc(p.name)}</b>${vLabel(v)?`<small>${esc(vLabel(v))}</small>`:""}${v.sku?`<small>${esc(v.sku)}</small>`:""}</td><td class="num">${stockOf(v.id)}</td>
    <td><input data-scv="${esc(v.id)}" inputmode="decimal" value="${esc(s.typed[v.id]||"")}" placeholder="—" aria-label="Counted ${esc(p.name)} ${esc(vLabel(v))}"></td><td class="num" data-scd="${esc(v.id)}">${d==null?"":d?`<b class="${d<0?"neg":"pos"}">${diffText(d)}</b>`:"✓"}</td></tr>`}).join("");
  host.innerHTML=`<div class="card"><div class="card-h"><div><h3>Stock count</h3><p class="note">Type what is on the shelf. Leave a row empty to skip it. Nothing changes until you review and confirm.</p></div></div>
    <div class="filters"><div class="search"><input id="scQ" type="search" placeholder="Search name, SKU or barcode" value="${esc(s.q)}" autocomplete="off"></div>${cs.length?`<select id="scCat" class="sel" aria-label="Category"><option value="">All categories</option>${cs.map(c=>`<option${c===s.cat?" selected":""}>${esc(c)}</option>`).join("")}</select>`:""}</div>
    ${list.length?`<div class="tw"><table class="pu-lines sc"><thead><tr><th>Item</th><th class="num">System</th><th>Counted</th><th class="num">Difference</th></tr></thead><tbody>${rows}</tbody></table></div>${list.length>MAX_ROWS?`<p class="note">Showing ${MAX_ROWS} of ${list.length}: search or pick a category to count the rest.</p>`:""}`:`<p class="muted">No products match.</p>`}
    ${s.err?`<p class="autherr">${esc(s.err)}</p>`:""}
    <div class="sh-foot"><span class="pk-sum" id="scSum">${typedN} counted</span><div class="sh-acts">${typedN?`<button class="btn sm" data-cnt="clear">Clear counts</button>`:""}<button class="btn sm primary" data-cnt="review"${typedN?"":" disabled"} id="scReview">Review</button></div></div></div>`;
}
function reviewHTML(){
  const s=S(), R=s.review;
  const name=vid=>{const l=R.lines.find(x=>x.vid===vid), p=l&&prod(l.pid), v=p&&variantsOf(p,true).find(x=>x.id===vid);return p?[p.name,v?vLabel(v):""].filter(Boolean).join(" · "):vid};
  const rows=R.changed.map(l=>`<tr><td>${esc(name(l.vid))}</td><td class="num">${l.system}</td><td class="num">${l.physical}</td><td class="num"><b class="${l.diff<0?"neg":"pos"}">${diffText(l.diff)}</b></td></tr>`).join("");
  return `<div class="card"><div class="card-h"><div><h3>Review the count</h3><p class="note">${R.lines.length} counted · ${R.changed.length} differ${R.changed.length?` · ${R.up?"+"+R.up:""}${R.up&&R.down?" / ":""}${R.down?"−"+R.down:""} pieces`:""}</p></div></div>
    ${R.changed.length?`<div class="tw"><table class="pu-lines ro"><thead><tr><th>Item</th><th class="num">System</th><th class="num">Counted</th><th class="num">Change</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pgrid" style="margin-top:12px"><label class="f">Reason<select id="scReason">${COUNT_REASONS.map(r=>`<option${r===s.reason?" selected":""}>${esc(r)}</option>`).join("")}</select></label><label class="f">Note <small>(optional)</small><input id="scNote" value="${esc(s.note)}" maxlength="120"></label></div>`
    :`<p class="okline">Every count matches the records: nothing to change.</p>`}
    ${s.err?`<p class="autherr">${esc(s.err)}</p>`:""}
    <div class="sh-foot"><span></span><div class="sh-acts"><button class="btn sm" data-cnt="back">Back to counting</button>${R.changed.length?`<button class="btn sm primary" data-cnt="confirm">Confirm count</button>`:""}</div></div></div>`;
}
function rerender(){ const h=$("#invSubBody"); if(h) renderStockCountView(h); }
function review(){
  const s=S(), d=countDiffs(countRows(),s.typed);
  if(d.error){ s.err=d.error; rerender(); const i=d.vid&&$(`[data-scv="${CSS.escape(d.vid)}"]`); if(i) i.focus(); return; }
  if(!d.counted){ s.err="Type the counted quantity of at least one item."; rerender(); return; }
  s.err=""; s.review=d; rerender(); window.scrollTo(0,0);
}
function confirm(){
  const s=S(), R=s.review; if(!R) return;
  const r=confirmStockCount({rows:R.lines.map(l=>({vid:l.vid,pid:l.pid,system:l.system,dec:decOf(prod(l.pid))})),typed:s.typed,reason:s.reason,note:s.note});
  if(r.error){ s.err=r.error; if(r.moved) s.review=null; rerender(); return; }
  store.stockCount=null; renderSync(); flushSbQueue(); rerender();
  toast(`Stock count saved: ${r.changed} item${r.changed===1?"":"s"} adjusted.`);
}
/* ---------- events (from app/events/dom-events.js through inventory-views.js) ---------- */
export function countClick(t){
  const b=t.closest("[data-cnt]"); if(!b) return false;
  const s=S(), a=b.dataset.cnt;
  if(a==="review") review();
  else if(a==="back"){ s.review=null; s.err=""; rerender(); }
  else if(a==="confirm") confirm();
  else if(a==="clear"){ s.typed={}; s.err=""; rerender(); }
  else return false;
  return true;
}
export function countInput(t){
  const s=S();
  if(t.dataset.scv!=null){
    s.typed[t.dataset.scv]=t.value;
    const c=$(`[data-scd="${CSS.escape(t.dataset.scv)}"]`), d=diffOf(t.dataset.scv); if(c) c.innerHTML=d==null?"":d?`<b class="${d<0?"neg":"pos"}">${diffText(d)}</b>`:"✓";
    const n=Object.values(s.typed).filter(x=>String(x).trim()!=="").length, sum=$("#scSum"), btn=$("#scReview"); if(sum) sum.textContent=n+" counted"; if(btn) btn.disabled=!n;
    return true;
  }
  if(t.id==="scQ"){ s.q=t.value; const pos=t.selectionStart; rerender(); const i=$("#scQ"); if(i){ i.focus(); i.setSelectionRange(pos,pos); } return true; }
  if(t.id==="scNote"){ s.note=t.value; return true; }
  return false;
}
export function countChange(t){
  const s=S();
  if(t.id==="scCat"){ s.cat=t.value; rerender(); return true; }
  if(t.id==="scReason"){ s.reason=t.value; return true; }
  return false;
}

