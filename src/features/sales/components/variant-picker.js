// Variant picker: many colours/sizes with quantities at once.
import { store } from '../../../shared/state/store.js';
import { priceRange, vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { colKey, rowKey, rowVals } from '../../../domain/catalog/options.js';
import { matrixOf } from '../../products/services/matrix.js';
import { levelOf } from '../../inventory/services/stock-levels.js';
import { thumb } from '../../products/components/thumb.js';
import { prod } from '../../products/services/catalog.js';
import { vRec } from '../../inventory/services/ledger.js';
import { renderReturnSheet } from '../../returns/components/return-sheet.js';
import { exAvail } from '../../returns/services/return-rules.js';
import { closeSheets } from './bill-panel.js';
import { addToLines, availOf } from '../services/cart.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';

/* ---------- variant picker: every variant with its own quantity, added in one go ----------
   Rows are the combinations of every option but the last (e.g. colours), columns the last option's values (e.g. sizes). */

export function openPicker(pid, target){
  const p=prod(pid); if(!p||p.archived) return;
  const vs=variantsOf(p);
  const rows=rowVals(p), firstColor=rows.find(r=>vs.some(v=>rowKey(p,v)===r&&availOf(v.id)>0))||rows[0]||"";
  store.pick={pid, color:firstColor, qty:{}, last:null, target:target||"cart"};
  store.billOpen=false; renderPicker();
  const f=$("#sheetHost .vc-tap:not([disabled])"); if(f) f.focus({preventScroll:true});
}
export const pickMax = vid => store.pick && store.pick.target==="exchange" ? exAvail(vid) : availOf(vid);
export const pickRows=matrixOf;
export function cellHTML(p,v,ki){
  if(!v) return `<div class="vc na" aria-hidden="true"><span>—</span></div>`;
  const a=pickMax(v.id), q=store.pick.qty[v.id]||0, lv=levelOf(a+q), rest=a-q;
  return `<div class="vc ${lv}${q?" on":""}" data-vc="${esc(v.id)}">
    <button type="button" class="vc-tap" data-cellplus="${esc(v.id)}"${a<=0&&!q?" disabled":""} aria-label="Add one ${esc(vLabel(v)||p.name)}, ${a<=0?"sold out":rest+" left"}"><b>${esc(colKey(p,v)||"One size")}</b><small>${a<=0&&!q?"Sold out":rest+" left"}</small>${ki!=null&&ki<9?`<span class="kh">${ki+1}</span>`:""}${vPrice(p,v)!==+p.price?`<em class="vp">${inr(vPrice(p,v))}</em>`:""}</button>
    <div class="vc-q"><button type="button" data-cellminus="${esc(v.id)}" aria-label="One less"${q?"":" disabled"}>−</button><input type="number" inputmode="numeric" min="0" max="${Math.max(0,a)}" data-cellqty="${esc(v.id)}" value="${q||""}" placeholder="0" aria-label="Quantity ${esc(vLabel(v)||p.name)}"${a<=0&&!q?" disabled":""}></div>
  </div>`;
}
export function pickSummary(p){ let n=0,amt=0; Object.entries(store.pick.qty).forEach(([vid,q])=>{const r=vRec(vid);if(r&&q>0){n+=q;amt+=q*vPrice(r.p,r.v)}}); return {n,amt}; }
export function renderPicker(){
  const p=prod(store.pick&&store.pick.pid); if(!p){closeSheets();return}
  document.body.style.overflow="hidden";
  const {colors,sizes,find,names,sw}=pickRows(p), hasC=colors[0]!=="", wide=window.innerWidth>=700;
  const colorQty=c=>sizes.reduce((a,s)=>{const v=find(c,s);return a+(v?(store.pick.qty[v.id]||0):0)},0);
  const colorLeft=c=>sizes.reduce((a,s)=>{const v=find(c,s);return a+(v?Math.max(0,pickMax(v.id)):0)},0);
  let body="";
  if(hasC&&(wide||colors.length===1)){
    // full matrix: colours down, sizes across
    body=`<div class="vmx" role="group" aria-label="${esc([names.row,names.col].filter(Boolean).join(" and ")||"Variants")}">${colors.map(c=>`<div class="vmx-row${c===store.pick.color?" act":""}" data-row="${esc(c)}"><button type="button" class="vmx-c" data-color="${esc(c)}">${sw(c)}<span>${esc(c)}</span>${colorQty(c)?`<em>${colorQty(c)}</em>`:""}</button><div class="vcells" style="--n:${sizes.length}">${sizes.map((s,k)=>cellHTML(p,find(c,s),c===store.pick.color?k:null)).join("")}</div></div>`).join("")}</div>`;
  }else{
    const active=hasC?store.pick.color:"";
    body=(hasC?`<div class="vchips" role="group" aria-label="${esc(names.row||"Variants")}">${colors.map(c=>`<button type="button" class="vchip${c===active?" on":""}" data-color="${esc(c)}" aria-pressed="${c===active}">${sw(c)}${esc(c)}${colorQty(c)?`<em>${colorQty(c)}</em>`:colorLeft(c)<=0?`<small>out</small>`:""}</button>`).join("")}</div>`:"")+
      `<div class="vcells grid-${Math.min(sizes.length,5)}" style="--n:${Math.min(sizes.length,5)}">${sizes.map((s,k)=>cellHTML(p,find(active,s),k)).join("")}</div>`;
  }
  const S=pickSummary(p), ex=store.pick.target==="exchange";
  $("#sheetHost").innerHTML=`<div class="scrim" data-scrim><div class="sheet picker" role="dialog" aria-modal="true" aria-label="Choose ${esc(p.name)}">
    <div class="sh-head">${thumb(p,"md")}<div class="sh-t"><h3>${esc(p.name)}</h3><p>${esc(priceRange(p))} · tap to add, or type a quantity</p></div><button class="iconbtn" data-act="closesheet" aria-label="Close">${ICON.x}</button></div>
    ${body}
    <div class="sh-foot"><span class="pk-sum" id="pickSum">${S.n?`<b>${S.n} piece${S.n>1?"s":""}</b> · ${inr(S.amt)}`:"Nothing selected yet"}</span>
      <div class="sh-acts"><button class="btn sm" data-act="closesheet">Cancel</button><button class="btn sm primary" data-act="addpicked" id="addPickBtn"${S.n?"":" disabled"}>${ex?"Use for exchange":"Add to bill"}</button></div></div>
  </div></div>`;
}
export function updatePicker(){
  const p=prod(store.pick&&store.pick.pid); if(!p) return;
  $$("#sheetHost [data-vc]").forEach(cell=>{
    const vid=cell.dataset.vc, a=pickMax(vid), q=store.pick.qty[vid]||0, rest=a-q, inp=cell.querySelector("input");
    cell.classList.toggle("on",q>0);
    const sm=cell.querySelector(".vc-tap small"); if(sm) sm.textContent=a<=0&&!q?"Sold out":rest+" left";
    const minus=cell.querySelector("[data-cellminus]"); if(minus) minus.disabled=!q;
    if(inp&&document.activeElement!==inp) inp.value=q||"";
  });
  const {sizes,find}=pickRows(p);
  $$("#sheetHost [data-color]").forEach(b=>{const c=b.dataset.color;const n=sizes.reduce((a,s)=>{const v=find(c,s);return a+(v?(store.pick.qty[v.id]||0):0)},0);let em=b.querySelector("em");if(n){if(!em){em=document.createElement("em");b.appendChild(em)}em.textContent=n}else if(em)em.remove()});
  const S=pickSummary(p);
  const sum=$("#pickSum"); if(sum) sum.innerHTML=S.n?`<b>${S.n} piece${S.n>1?"s":""}</b> · ${inr(S.amt)}`:"Nothing selected yet";
  const b=$("#addPickBtn"); if(b) b.disabled=!S.n;
}
export function setPickQty(vid,q){
  if(!store.pick) return;
  const max=Math.max(0,pickMax(vid));
  let n=Math.max(0,Math.round(+q||0));
  if(n>max){ n=max; toast(max?`Only ${max} left in stock.`:"That one is sold out."); }
  if(n) store.pick.qty[vid]=n; else delete store.pick.qty[vid];
  store.pick.last=vid;
  const r=vRec(vid), row=r&&rowKey(r.p,r.v); if(row) store.pick.color=row;
  updatePicker();
}
export function addPicked(){
  if(!store.pick) return;
  const entries=Object.entries(store.pick.qty).filter(([,q])=>q>0);
  if(!entries.length) return;
  if(store.pick.target==="exchange"){ entries.forEach(([vid,q])=>addToLines(store.retState.newItems,vid,q)); store.pick=null; renderReturnSheet(); return; }
  let n=0; entries.forEach(([vid,q])=>{ addToLines(store.cart,vid,q); n+=q; });
  store.justAdded=store.pick.pid; saveCart(); closeSheets(); renderAll();
  toast(`Added ${n} piece${n>1?"s":""} to the bill.`);
}
