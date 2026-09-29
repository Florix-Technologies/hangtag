// The weight dialog: adding a product sold by the kg or litre asks for its weight. Type it, or "Read scale" when a scale is
// connected (Settings → Hardware); typing always works. The amount is shown before it goes on the bill.
import { store } from '../../../shared/state/store.js';
import { vLabel, vPrice } from '../../../domain/catalog/variants.js';
import { fmtQty, perUnit, qtyText, roundQty, unitOf } from '../../../domain/catalog/units.js';
import { linePaise, toRupees } from '../../../domain/sales/paise.js';
import { vRec } from '../../inventory/services/ledger.js';
import { availOf, onWeigh } from '../services/cart.js';
import { addWeighed } from '../use-cases/weigh-to-cart.js';
import { readScaleFor, scaleStatus } from '../../hardware/services/scale.js';
import { renderBillSheet } from './bill-panel.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { renderAll } from '../../../shared/ui/render.js';

/* store.weigh = { vid, line (a bill line weighed again, or null), value (as typed), err, busy, note } while it is open */
export function openWeigh(vid,line){
  const r=vRec(vid); if(!r) return;
  const c=line!=null?store.cart[line]:null, again=!!(c&&c.v===vid);
  store.weigh={vid,line:again?line:null,value:again?fmtQty(c.q):"",err:"",busy:false,note:""};
  renderWeigh();
  const i=$("#wgVal"); if(i){ i.focus(); if(i.select) i.select(); }
  // a connected scale is read straight away (the person can still type over it)
  if(scaleStatus().connected) readWeight();
}
const unitOfW=W=>{const r=vRec(W.vid);return unitOf(r&&r.p.unit)};
function previewHTML(){
  const W=store.weigh, r=W&&vRec(W.vid); if(!r) return "";
  const u=unitOfW(W), q=roundQty(+String(W.value).replace(",",".")||0,u.dp), price=vPrice(r.p,r.v);
  return q>0?`${esc(qtyText(q,u.id))} × ${esc(perUnit(inr(price),u.id))} = <b>${inrx(toRupees(linePaise(q,price)))}</b>`:"Type the weight, or read it from the scale.";
}
export function renderWeigh(){
  const W=store.weigh, r=W&&vRec(W.vid); if(!r){closeModal();return}
  const u=unitOfW(W), c=W.line!=null?store.cart[W.line]:null, left=roundQty(availOf(W.vid)+(c?c.q:0)), lab=vLabel(r.v), on=scaleStatus().connected;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet discsheet wgsheet" id="wgSheet" role="dialog" aria-modal="true" aria-label="Weigh ${esc(r.p.name)}">
    <div class="sh-head"><div class="sh-t"><h3>${esc(r.p.name)}${lab?" · "+esc(lab):""}</h3><p>${esc(perUnit(inr(vPrice(r.p,r.v)),u.id))} · ${esc(qtyText(left,u.id))} in stock</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <label class="f"><span class="lab">${u.kind==="volume"?"Quantity":"Weight"} in ${esc(u.sym)}</span><span class="wgrow"><input id="wgVal" type="number" inputmode="decimal" min="0" step="any" placeholder="${u.dp?"0."+"0".repeat(u.dp):"0"}" value="${esc(W.value)}" autocomplete="off"><span class="qu">${esc(u.sym)}</span></span></label>
    <p class="ldprev" id="wgAmt">${previewHTML()}</p>
    <p class="note" id="wgNote"${W.note?"":" hidden"}>${esc(W.note)}</p>
    <p class="err" id="wgErr" role="alert"${W.err?"":" hidden"}>${esc(W.err)}</p>
    <div class="setactions"><button class="btn primary" data-act="wgadd">${W.line!=null?"Update weight":"Add to bill"}</button><button class="btn" data-act="wgread"${W.busy?" disabled":""}>${W.busy?"Reading…":"Read scale"}</button>${on?"":`<span class="note">No scale connected: type the weight.</span>`}</div>
  </div></div>`;
}
/* typing: keep the value, redraw the amount only */
export function weighInput(v){
  const W=store.weigh; if(!W) return;
  W.value=v; W.err="";
  const p=$("#wgAmt"), e=$("#wgErr"); if(p) p.innerHTML=previewHTML(); if(e){e.textContent="";e.hidden=true}
}
/* "Read scale": the scale's settled weight, in the product's unit, into the box */
export async function readWeight(){
  const W=store.weigh; if(!W||W.busy) return;
  W.busy=true; W.err=""; W.note=""; renderWeigh();
  const r=await readScaleFor(unitOfW(W).id);
  if(store.weigh!==W) return;
  W.busy=false;
  if(r.error) W.err=r.error; else { W.value=fmtQty(r.q); W.note="Read from the scale: "+r.text; }
  renderWeigh(); const i=$("#wgVal"); if(i) i.focus();
}
/* Add to the bill (or update the line) → closes, or shows why not */
export function applyWeight(){
  const W=store.weigh; if(!W) return;
  const r=addWeighed(W.vid,W.value,W.line);
  if(r.error){ W.err=r.error; renderWeigh(); const i=$("#wgVal"); if(i) i.focus(); return; }
  store.weigh=null; closeModal(); renderAll(); if(store.billOpen) renderBillSheet();
  const v=vRec(W.vid); toast(`${W.line!=null?"Now":"Added"} ${r.text} of ${v?v.p.name:"it"}.`);
}
/* Wires the dialog: the cart asks for a weight through onWeigh (a product sold by weight tapped, scanned or searched) */
export function installWeighDialog(){
  onWeigh(vid=>openWeigh(vid,null));
  document.addEventListener("click",e=>{
    const t=e.target;
    const rw=t.closest&&t.closest("[data-reweigh]"); if(rw){ const i=+rw.dataset.reweigh, c=store.cart[i]; if(c) openWeigh(c.v,i); return; }
    if(!store.weigh) return;
    if(t.matches("[data-modal-scrim]")||(t.closest&&t.closest("[data-modal-close]"))){ store.weigh=null; return; }
    const a=t.closest&&t.closest("#wgSheet [data-act]"); if(!a) return;
    if(a.dataset.act==="wgadd") applyWeight(); else if(a.dataset.act==="wgread") readWeight();
  });
  document.addEventListener("input",e=>{ if(e.target.id==="wgVal") weighInput(e.target.value); });
  document.addEventListener("keydown",e=>{
    if(!store.weigh) return;
    if(e.key==="Enter"&&e.target.id==="wgVal"){ e.preventDefault(); applyWeight(); }
    else if(e.key==="Escape") store.weigh=null;
  });
}
