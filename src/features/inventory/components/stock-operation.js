// Stock in and stock adjustment sheet.
import { matrixOf } from '../../products/services/matrix.js';
import { store } from '../../../shared/state/store.js';
import { vLabel, variantsOf } from '../../../domain/catalog/variants.js';
import { stockOf } from '../services/stock.js';
import { thumb } from '../../products/components/thumb.js';
import { prod } from '../../products/services/catalog.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';
import { recordStockOperation, recordTrackedStockOperation } from '../use-cases/record-stock-operation.js';
import { batchesOf, expiryKept, expiryOf, serialsOf, trackingOfP } from '../services/tracking.js';
import { EXPIRY_LABELS, parseSerials } from '../../../domain/inventory/tracking.js';
import { refuse } from '../../shop/services/access.js';
import { decimalsOf, qtyText, roundQty, sumQty, unitOf } from '../../../domain/catalog/units.js';

/* A typed count in the product's unit (2.5 kg), rounded like the saved record will be */
const typedQty=raw=>roundQty(+String(raw).replace(",",".")||0,decimalsOf((prod(store.stockOp.pid)||{}).unit));
const unitWord=()=>{const u=unitOf((prod(store.stockOp&&store.stockOp.pid)||{}).unit);return u.id==="pcs"?"pieces":u.sym};

export function openStockOp(kind,pid){
  if(refuse("manage_inventory","add or adjust stock"))return;
  const p=prod(pid); if(!p) return;
  store.stockOp={kind,pid,val:{},cost:"",setCost:true,reason:"Physical count correction",note:""};
  // tracked by serial number or batch: stock moves with its serials / batches (rows: what is typed for each)
  const trk=trackingOfP(p); if(trk!=="none"){ store.stockOp.trk=trk; store.stockOp.rows={}; renderStockOp(); const f=$("#modalHost [data-sotr],#modalHost [data-sobq],#modalHost [data-soba]"); if(f) f.focus(); return; }
  if(kind==="adjust") variantsOf(p).forEach(v=>{store.stockOp.val[v.id]=String(stockOf(v.id))});
  renderStockOp();
  const f=$("#modalHost input[data-sov]"); if(f) f.focus();
}
export function renderStockOp(){
  const p=prod(store.stockOp&&store.stockOp.pid); if(!p){closeModal();return}
  if(store.stockOp.trk){ renderTrackedStockOp(p); return; }
  const adj=store.stockOp.kind==="adjust";
  const {colors,sizes,find,names,sw}=matrixOf(p), hasC=colors[0]!=="";
  const cell=v=>{if(!v)return `<td class="na">—</td>`;const cur=stockOf(v.id),raw=store.stockOp.val[v.id];
    const d=adj?(raw===""||raw==null?0:roundQty(typedQty(raw)-cur)):0, dp=decimalsOf(p.unit);
    return `<td><input type="number" inputmode="${dp?"decimal":"numeric"}" min="0" step="${dp?"any":"1"}" data-sov="${esc(v.id)}" value="${esc(raw==null?"":raw)}" placeholder="${adj?cur:"0"}" aria-label="${esc(vLabel(v)||p.name)}"><small data-sonow="${esc(v.id)}">${adj?(d?`<b class="${d<0?"neg":"pos"}">${d>0?"+":""}${d}</b>`:"now "+cur):"now "+cur}</small></td>`};
  const T=stockOpTotals();
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet stockop" role="dialog" aria-modal="true" aria-label="${adj?"Adjust stock":"Stock in"}">
    <div class="sh-head">${thumb(p,"md")}<div class="sh-t"><h3>${adj?"Adjust stock":"Stock in"} · ${esc(p.name)}</h3><p>${adj?`Type the ${esc(unitWord())} you actually counted. Only changed variants are recorded.`:`Type how many ${esc(unitWord())} arrived for each variant.`}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="tw"><table class="soe"><thead><tr><th>${esc(names.row)}</th>${sizes.map(s=>`<th>${esc(s||(adj?"Counted":"Pieces"))}</th>`).join("")}</tr></thead><tbody>${colors.map(c=>`<tr><th>${hasC?`${sw(c).replace("<i ",'<i class="sw2" ')}${esc(c)}`:""}</th>${sizes.map(s=>cell(find(c,s))).join("")}</tr>`).join("")}</tbody></table></div>
    ${adj?`<div class="pgrid" style="margin-top:12px"><label class="f">Reason<select id="soReason">${["Physical count correction","Damaged","Lost or stolen","Sent back to supplier","Other"].map(r=>`<option${r===store.stockOp.reason?" selected":""}>${r}</option>`).join("")}</select></label><label class="f">Note<input id="soNote" value="${esc(store.stockOp.note)}" maxlength="120" placeholder="Optional"></label></div>`
      :`<div class="pgrid" style="margin-top:12px"><label class="f">Supplier <small>(optional)</small><input id="soSupplier" maxlength="60" autocomplete="off"></label><label class="f">Supplier bill / reference <small>(optional)</small><input id="soRef" maxlength="40" autocomplete="off"></label><label class="f">Date received<input id="soReceived" type="date" value="${esc(dayKey(Date.now()))}" max="${esc(dayKey(Date.now()))}"></label></div><div class="pgrid" style="margin-top:8px"><label class="f">Cost per piece ₹<input id="soCost" type="number" inputmode="numeric" min="0" value="${esc(store.stockOp.cost)}" placeholder="Optional"></label><label class="f">Note<input id="soNote" value="${esc(store.stockOp.note)}" maxlength="120" placeholder="Optional, e.g. supplier or invoice"></label>
        <label class="chk full"><input type="checkbox" id="soSetCost"${store.stockOp.setCost?" checked":""}> Use this as the cost price for these variants</label></div>`}
    <p id="soErr" class="autherr" hidden></p>
    <div class="sh-foot"><span class="pk-sum" id="soSum">${T.txt}</span><div class="sh-acts"><button class="btn sm" data-modal-close>Cancel</button><button class="btn sm primary" data-act="sosave" id="soSave"${T.n?"":" disabled"}>${adj?"Save adjustment":"Add stock"}</button></div></div>
  </div></div>`;
}
export function stockOpTotals(){
  const adj=store.stockOp.kind==="adjust";let n=0;const ds=[];
  Object.entries(store.stockOp.val).forEach(([vid,raw])=>{if(raw===""||raw==null)return;const v=typedQty(raw),d=adj?roundQty(v-stockOf(vid)):v;if(d){n++;ds.push(d)}});
  const pcs=sumQty(ds), w=unitWord();
  return {n,pcs,txt:n?(adj?`${n} variant${n>1?"s":""} change · ${pcs>0?"+":""}${pcs} ${w}`:`${n} variant${n>1?"s":""} · +${pcs} ${w}`):"No changes yet"};
}
export function updateStockOp(){
  const adj=store.stockOp.kind==="adjust";
  $$("#modalHost [data-sonow]").forEach(el=>{const vid=el.dataset.sonow,raw=store.stockOp.val[vid],cur=stockOf(vid);if(!adj){el.textContent="now "+cur;return}const d=raw===""||raw==null?0:roundQty(typedQty(raw)-cur);el.innerHTML=d?`<b class="${d<0?"neg":"pos"}">${d>0?"+":""}${d}</b>`:"now "+cur});
  const T=stockOpTotals(); const s=$("#soSum"); if(s) s.textContent=T.txt; const b=$("#soSave"); if(b) b.disabled=!T.n;
}
export function saveStockOp(){
  const p=prod(store.stockOp.pid); if(!p) return;
  if(store.stockOp.trk){ saveTrackedStockOp(p); return; }
  const adj=store.stockOp.kind==="adjust", err=$("#soErr"), bad=m=>{err.textContent=m;err.hidden=false};
  const r=recordStockOperation({kind:store.stockOp.kind,productId:p.id,values:store.stockOp.val,
    costRaw:adj?"":String(($("#soCost")||{}).value||""),setCost:!!($("#soSetCost")||{}).checked,
    reason:adj?(($("#soReason")||{}).value||"Physical count correction"):"",note:String(($("#soNote")||{}).value||"").trim(),
    supplier:String(($("#soSupplier")||{}).value||""),ref:String(($("#soRef")||{}).value||""),received:String(($("#soReceived")||{}).value||"")});
  if(r.error) return bad(r.error);
  renderSync(); flushSbQueue();
  const pcs=r.pieces;
  store.stockOp=null; closeModal(); renderAll();
  const w=unitOf(p.unit).id==="pcs"?null:unitOf(p.unit).sym;
  toast(adj?`Stock adjusted (${pcs>0?"+":""}${pcs} ${w||"pieces"}) and recorded.`:w?`Added ${pcs} ${w} to stock.`:`Added ${pcs} piece${pcs===1?"":"s"} to stock.`);
}

/* ---------- a product tracked by serial number or batch ---------- */
const vName=(p,v)=>vLabel(v)||(variantsOf(p).length>1?"One size":p.name);
function trackedRows(p){
  const O=store.stockOp, adj=O.kind==="adjust", R=O.rows, w=unitOf(p.unit);
  if(O.trk==="serial") return variantsOf(p).map(v=>{
    const r=R[v.id]||{}, text=adj?r.add||"":typeof r==="string"?r:"", inStock=serialsOf(v.id,{available:true});
    const outs=adj?`<div class="so-sns" role="group" aria-label="Serials of ${esc(vName(p,v))} in stock">${inStock.length?inStock.map(s=>`<label class="chk"><input type="checkbox" data-soout="${esc(v.id)}|${esc(s.sn)}"${(r.out||[]).includes(s.sn)?" checked":""}> ${esc(s.sn)}</label>`).join(""):`<span class="note">None in stock.</span>`}</div><p class="note">Tick the pieces to write off (damaged, lost). Found a piece? Type its serial below.</p>`:"";
    return `<div class="so-trk"><h4>${esc(vName(p,v))} <small>${stockOf(v.id)} in stock</small></h4>${outs}<label class="f"><span class="lab">${adj?"Serials found":"Serial numbers arriving"}</span><textarea data-sotr="${esc(v.id)}" rows="2" placeholder="One per line, or a range like SN001..SN010" aria-label="${adj?"Serials found":"Serial numbers arriving"} for ${esc(vName(p,v))}">${esc(text)}</textarea></label></div>`;
  }).join("");
  if(!adj) return `<div class="tw"><table class="soe"><thead><tr><th>Variant</th><th>${w.id==="pcs"?"Pieces":esc(w.sym)}</th><th>Batch no.</th><th>Expiry${expiryKept(p)?"":" <small>(optional)</small>"}</th></tr></thead><tbody>${variantsOf(p).map(v=>{const r=R[v.id]||{},dp=decimalsOf(p.unit);
    return `<tr><th>${esc(vName(p,v))}</th><td><input type="number" inputmode="${dp?"decimal":"numeric"}" min="0" step="${dp?"any":"1"}" data-sobq="${esc(v.id)}" value="${esc(r.q||"")}" placeholder="0" aria-label="Quantity of ${esc(vName(p,v))}"></td><td><input data-sobn="${esc(v.id)}" value="${esc(r.b||"")}" maxlength="40" autocomplete="off" aria-label="Batch number of ${esc(vName(p,v))}"></td><td><input type="date" data-sobe="${esc(v.id)}" value="${esc(r.exp||"")}" aria-label="Expiry date of ${esc(vName(p,v))}"></td></tr>`}).join("")}</tbody></table></div>`;
  const rows=variantsOf(p).flatMap(v=>batchesOf(v.id,{all:true}).filter(b=>b.qty!==0).map(b=>({v,b})));
  if(!rows.length) return `<p class="muted">No batch of ${esc(p.name)} has stock.</p>`;
  return `<div class="tw"><table class="soe"><thead><tr><th>Variant · batch</th><th>Expiry</th><th>Now</th><th>Counted</th></tr></thead><tbody>${rows.map(({v,b})=>{const k=v.id+"|"+b.b,x=expiryOf(b.exp),dp=decimalsOf(p.unit);
    return `<tr><th>${esc(vName(p,v))} · ${esc(b.b)}</th><td>${b.exp?`${esc(b.exp)}${x&&x!=="fresh"?` <em class="exp ${x}">${EXPIRY_LABELS[x]}</em>`:""}`:"—"}</td><td>${esc(qtyText(b.qty,p.unit))}</td><td><input type="number" inputmode="${dp?"decimal":"numeric"}" min="0" step="${dp?"any":"1"}" data-soba="${esc(k)}" value="${esc(R[k]==null?"":R[k])}" placeholder="${b.qty}" aria-label="Counted ${esc(vName(p,v))} batch ${esc(b.b)}"></td></tr>`}).join("")}</tbody></table></div>`;
}
function trackedSummary(){
  const O=store.stockOp, R=O.rows; let n=0;
  if(O.trk==="serial") Object.values(R).forEach(r=>{const t=typeof r==="string"?r:(r&&r.add)||"",ps=parseSerials(t);n+=(ps.serials||[]).length+((r&&r.out)||[]).length});
  else Object.values(R).forEach(r=>{if(O.kind==="adjust"){if(r!==""&&r!=null)n++}else if(r&&r.q)n++});
  return n?(O.trk==="serial"?`${n} serial number${n===1?"":"s"}`:`${n} batch${n===1?"":"es"}`):"Nothing entered yet";
}
function renderTrackedStockOp(p){
  const O=store.stockOp, adj=O.kind==="adjust", serial=O.trk==="serial";
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet stockop" role="dialog" aria-modal="true" aria-label="${adj?"Adjust stock":"Stock in"}">
    <div class="sh-head">${thumb(p,"md")}<div class="sh-t"><h3>${adj?"Adjust stock":"Stock in"} · ${esc(p.name)}</h3><p>${serial?(adj?"Write off pieces by their serial numbers, or add pieces found.":"Enter the serial number of every piece that arrived."):(adj?"Type what is on the shelf for each batch. Only changed batches are recorded.":`Enter the batch${expiryKept(p)?" and its expiry date":""} of what arrived.`)}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    ${trackedRows(p)}
    ${adj?`<div class="pgrid" style="margin-top:12px"><label class="f">Reason<select id="soReason">${["Physical count correction","Damaged","Expired","Lost or stolen","Sent back to supplier","Other"].map(r=>`<option${r===O.reason?" selected":""}>${r}</option>`).join("")}</select></label><label class="f">Note<input id="soNote" value="${esc(O.note)}" maxlength="120" placeholder="Optional"></label></div>`
      :`<div class="pgrid" style="margin-top:12px"><label class="f">Supplier <small>(optional)</small><input id="soSupplier" maxlength="60" autocomplete="off"></label><label class="f">Supplier bill / reference <small>(optional)</small><input id="soRef" maxlength="40" autocomplete="off"></label><label class="f">Date received<input id="soReceived" type="date" value="${esc(dayKey(Date.now()))}" max="${esc(dayKey(Date.now()))}"></label></div><div class="pgrid" style="margin-top:8px"><label class="f">Cost per piece ₹<input id="soCost" type="number" inputmode="numeric" min="0" value="${esc(O.cost)}" placeholder="Optional"></label><label class="f">Note<input id="soNote" value="${esc(O.note)}" maxlength="120" placeholder="Optional"></label>
        <label class="chk full"><input type="checkbox" id="soSetCost"${O.setCost?" checked":""}> Use this as the cost price for these variants</label></div>`}
    <p id="soErr" class="autherr" hidden></p>
    <div class="sh-foot"><span class="pk-sum" id="soSum">${trackedSummary()}</span><div class="sh-acts"><button class="btn sm" data-modal-close>Cancel</button><button class="btn sm primary" data-act="sosave" id="soSave">${adj?"Save adjustment":"Add stock"}</button></div></div>
  </div></div>`;
}
function saveTrackedStockOp(p){
  const O=store.stockOp, adj=O.kind==="adjust", err=$("#soErr");
  const r=recordTrackedStockOperation({kind:O.kind,productId:p.id,rows:O.rows,costRaw:adj?"":String(($("#soCost")||{}).value||""),setCost:!!($("#soSetCost")||{}).checked,
    reason:adj?(($("#soReason")||{}).value||"Physical count correction"):"",note:String(($("#soNote")||{}).value||"").trim(),
    supplier:String(($("#soSupplier")||{}).value||""),ref:String(($("#soRef")||{}).value||""),received:String(($("#soReceived")||{}).value||"")});
  if(r.error){ if(err){ err.textContent=r.error; err.hidden=false; } return; }
  renderSync(); flushSbQueue();
  store.stockOp=null; closeModal(); renderAll();
  toast(adj?`Stock adjusted (${r.pieces>0?"+":""}${qtyText(r.pieces,p.unit)}) and recorded.`:`Added ${qtyText(r.pieces,p.unit)} to stock.`);
}
/* typing in the tracked sheet (inventory-views.js routes it here) */
export function stockOpInput(t){
  const O=store.stockOp; if(!O||!O.trk) return false;
  const R=O.rows, adj=O.kind==="adjust";
  if(t.dataset.sotr!=null){ const v=t.dataset.sotr; if(adj) R[v]={...(R[v]||{}),add:t.value}; else R[v]=t.value; }
  else if(t.dataset.sobq!=null) R[t.dataset.sobq]={...(R[t.dataset.sobq]||{}),q:t.value};
  else if(t.dataset.sobn!=null) R[t.dataset.sobn]={...(R[t.dataset.sobn]||{}),b:t.value};
  else if(t.dataset.sobe!=null) R[t.dataset.sobe]={...(R[t.dataset.sobe]||{}),exp:t.value};
  else if(t.dataset.soba!=null) R[t.dataset.soba]=t.value;
  else return false;
  const s=$("#soSum"); if(s) s.textContent=trackedSummary();
  return true;
}
export function stockOpChange(t){
  const O=store.stockOp; if(!O||!O.trk||t.dataset.soout==null) return false;
  const k=t.dataset.soout.indexOf("|"), v=t.dataset.soout.slice(0,k), sn=t.dataset.soout.slice(k+1), r=O.rows[v]||(O.rows[v]={});
  r.out=(r.out||[]).filter(x=>x!==sn); if(t.checked) r.out.push(sn);
  const s=$("#soSum"); if(s) s.textContent=trackedSummary();
  return true;
}
