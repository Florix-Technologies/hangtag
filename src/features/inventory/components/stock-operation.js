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
import { recordStockOperation } from '../use-cases/record-stock-operation.js';

export function openStockOp(kind,pid){
  const p=prod(pid); if(!p) return;
  store.stockOp={kind,pid,val:{},cost:"",setCost:true,reason:"Physical count correction",note:""};
  if(kind==="adjust") variantsOf(p).forEach(v=>{store.stockOp.val[v.id]=String(stockOf(v.id))});
  renderStockOp();
  const f=$("#modalHost input[data-sov]"); if(f) f.focus();
}
export function renderStockOp(){
  const p=prod(store.stockOp&&store.stockOp.pid); if(!p){closeModal();return}
  const adj=store.stockOp.kind==="adjust";
  const {colors,sizes,find,names,sw}=matrixOf(p), hasC=colors[0]!=="";
  const cell=v=>{if(!v)return `<td class="na">—</td>`;const cur=stockOf(v.id),raw=store.stockOp.val[v.id];
    const d=adj?(raw===""||raw==null?0:Math.round(+raw||0)-cur):0;
    return `<td><input type="number" inputmode="numeric" ${adj?'min="0"':'min="0"'} data-sov="${esc(v.id)}" value="${esc(raw==null?"":raw)}" placeholder="${adj?cur:"0"}" aria-label="${esc(vLabel(v)||p.name)}"><small data-sonow="${esc(v.id)}">${adj?(d?`<b class="${d<0?"neg":"pos"}">${d>0?"+":""}${d}</b>`:"now "+cur):"now "+cur}</small></td>`};
  const T=stockOpTotals();
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet stockop" role="dialog" aria-modal="true" aria-label="${adj?"Adjust stock":"Stock in"}">
    <div class="sh-head">${thumb(p,"md")}<div class="sh-t"><h3>${adj?"Adjust stock":"Stock in"} · ${esc(p.name)}</h3><p>${adj?"Type the pieces you actually counted. Only changed variants are recorded.":"Type how many pieces arrived for each variant."}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="tw"><table class="soe"><thead><tr><th>${esc(names.row)}</th>${sizes.map(s=>`<th>${esc(s||(adj?"Counted":"Pieces"))}</th>`).join("")}</tr></thead><tbody>${colors.map(c=>`<tr><th>${hasC?`${sw(c).replace("<i ",'<i class="sw2" ')}${esc(c)}`:""}</th>${sizes.map(s=>cell(find(c,s))).join("")}</tr>`).join("")}</tbody></table></div>
    ${adj?`<div class="pgrid" style="margin-top:12px"><label class="f">Reason<select id="soReason">${["Physical count correction","Damaged","Lost or stolen","Sent back to supplier","Other"].map(r=>`<option${r===store.stockOp.reason?" selected":""}>${r}</option>`).join("")}</select></label><label class="f">Note<input id="soNote" value="${esc(store.stockOp.note)}" maxlength="120" placeholder="Optional"></label></div>`
      :`<div class="pgrid" style="margin-top:12px"><label class="f">Supplier <small>(optional)</small><input id="soSupplier" maxlength="60" autocomplete="off"></label><label class="f">Supplier bill / reference <small>(optional)</small><input id="soRef" maxlength="40" autocomplete="off"></label><label class="f">Date received<input id="soReceived" type="date" value="${esc(dayKey(Date.now()))}" max="${esc(dayKey(Date.now()))}"></label></div><div class="pgrid" style="margin-top:8px"><label class="f">Cost per piece ₹<input id="soCost" type="number" inputmode="numeric" min="0" value="${esc(store.stockOp.cost)}" placeholder="Optional"></label><label class="f">Note<input id="soNote" value="${esc(store.stockOp.note)}" maxlength="120" placeholder="Optional, e.g. supplier or invoice"></label>
        <label class="chk full"><input type="checkbox" id="soSetCost"${store.stockOp.setCost?" checked":""}> Use this as the cost price for these variants</label></div>`}
    <p id="soErr" class="autherr" hidden></p>
    <div class="sh-foot"><span class="pk-sum" id="soSum">${T.txt}</span><div class="sh-acts"><button class="btn sm" data-modal-close>Cancel</button><button class="btn sm primary" data-act="sosave" id="soSave"${T.n?"":" disabled"}>${adj?"Save adjustment":"Add stock"}</button></div></div>
  </div></div>`;
}
export function stockOpTotals(){
  const adj=store.stockOp.kind==="adjust";let n=0,pcs=0;
  Object.entries(store.stockOp.val).forEach(([vid,raw])=>{if(raw===""||raw==null)return;const v=Math.round(+raw||0),d=adj?v-stockOf(vid):v;if(d){n++;pcs+=d}});
  return {n,pcs,txt:n?(adj?`${n} variant${n>1?"s":""} change · ${pcs>0?"+":""}${pcs} pieces`:`${n} variant${n>1?"s":""} · +${pcs} pieces`):"No changes yet"};
}
export function updateStockOp(){
  const adj=store.stockOp.kind==="adjust";
  $$("#modalHost [data-sonow]").forEach(el=>{const vid=el.dataset.sonow,raw=store.stockOp.val[vid],cur=stockOf(vid);if(!adj){el.textContent="now "+cur;return}const d=raw===""||raw==null?0:Math.round(+raw||0)-cur;el.innerHTML=d?`<b class="${d<0?"neg":"pos"}">${d>0?"+":""}${d}</b>`:"now "+cur});
  const T=stockOpTotals(); const s=$("#soSum"); if(s) s.textContent=T.txt; const b=$("#soSave"); if(b) b.disabled=!T.n;
}
export function saveStockOp(){
  const p=prod(store.stockOp.pid); if(!p) return;
  const adj=store.stockOp.kind==="adjust", err=$("#soErr"), bad=m=>{err.textContent=m;err.hidden=false};
  const r=recordStockOperation({kind:store.stockOp.kind,productId:p.id,values:store.stockOp.val,
    costRaw:adj?"":String(($("#soCost")||{}).value||""),setCost:!!($("#soSetCost")||{}).checked,
    reason:adj?(($("#soReason")||{}).value||"Physical count correction"):"",note:String(($("#soNote")||{}).value||"").trim(),
    supplier:String(($("#soSupplier")||{}).value||""),ref:String(($("#soRef")||{}).value||""),received:String(($("#soReceived")||{}).value||"")});
  if(r.error) return bad(r.error);
  renderSync(); flushSbQueue();
  const pcs=r.pieces;
  store.stockOp=null; closeModal(); renderAll();
  toast(adj?`Stock adjusted (${pcs>0?"+":""}${pcs} pieces) and recorded.`:`Added ${pcs} piece${pcs===1?"":"s"} to stock.`);
}
