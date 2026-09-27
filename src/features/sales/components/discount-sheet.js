// Discount on one bill line: % or ₹ off, with the new line amount shown before it's applied.
import { checkDiscount, discountPaise, normalizeDiscount } from '../../../domain/sales/discounts.js';
import { toPaise } from '../../../domain/sales/paise.js';
import { lineLabel } from '../../../domain/catalog/variants.js';
import { store } from '../../../shared/state/store.js';
import { setLineDiscount } from '../use-cases/discounts.js';
import { renderBillSheet } from './bill-panel.js';
import { closeModal } from '../../../shared/components/modal.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { renderAll } from '../../../shared/ui/render.js';

/* store.lineDisc = { i, type, value, err } while the sheet is open */
export function openLineDiscount(i){
  const c=store.cart[i]; if(!c) return;
  const d=normalizeDiscount(c.disc);
  store.lineDisc={i,type:d?d.type:"percent",value:d?String(d.value):"",err:""};
  renderLineDiscount();
  const inp=$("#ldVal"); if(inp) inp.focus();
}
export function renderLineDiscount(){
  const s=store.lineDisc, c=s&&store.cart[s.i]; if(!c){closeModal();return}
  const gross=c.q*c.price, lab=lineLabel(c), had=!!normalizeDiscount(c.disc);
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet discsheet" id="ldSheet" role="dialog" aria-modal="true" aria-label="Discount on ${esc(c.name)}">
    <div class="sh-head"><div class="sh-t"><h3>Discount on this line</h3><p>${esc(c.name)}${lab?" · "+esc(lab):""} · ${c.q} × ${inr(c.price)} = ${inr(gross)}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="seg ldseg" role="group" aria-label="Discount in percent or rupees"><button type="button" data-ldtype="percent" aria-pressed="${s.type==="percent"}">% off</button><button type="button" data-ldtype="fixed" aria-pressed="${s.type==="fixed"}">₹ off</button></div>
    <label class="f"><span class="lab">${s.type==="percent"?"Percent off":"Rupees off this line"}</span><input id="ldVal" type="number" inputmode="decimal" min="0" ${s.type==="percent"?'max="100" ':""}step="any" placeholder="0" value="${esc(s.value)}" autocomplete="off"></label>
    <p class="ldprev" id="ldPrev">${previewText()}</p>
    <p class="err" id="ldErr" role="alert"${s.err?"":" hidden"}>${esc(s.err)}</p>
    <div class="setactions"><button class="btn primary" data-act="ldapply">Apply</button>${had?`<button class="btn" data-act="ldremove">Remove discount</button>`:""}</div>
  </div></div>`;
}
function previewText(){
  const s=store.lineDisc, c=store.cart[s.i], base=toPaise(c.q*c.price), bad=checkDiscount(s,base);
  if(bad) return "";
  const off=discountPaise(s,base);
  return off?`${inrx(off/100)} off · line becomes <b>${inrx((base-off)/100)}</b>`:"No discount on this line.";
}
/* typing in the box: keep the value, redraw the preview and the message only */
export function lineDiscountInput(v){
  const s=store.lineDisc; if(!s) return;
  s.value=v; const c=store.cart[s.i], bad=c&&checkDiscount(s,toPaise(c.q*c.price));
  s.err=bad?bad.error:"";
  const p=$("#ldPrev"), e=$("#ldErr"); if(p) p.innerHTML=previewText(); if(e){e.textContent=s.err;e.hidden=!s.err}
}
export function lineDiscountType(type){ const s=store.lineDisc; if(!s) return; s.type=type==="fixed"?"fixed":"percent"; lineDiscountInput(s.value); renderLineDiscount(); const i=$("#ldVal"); if(i) i.focus(); }
/* Apply (or remove, with remove=true) */
export function applyLineDiscount(remove){
  const s=store.lineDisc; if(!s) return;
  const r=setLineDiscount(s.i,remove?null:{type:s.type,value:s.value});
  if(r.error){s.err=r.error;renderLineDiscount();return}
  store.lineDisc=null; closeModal(); renderAll(); if(store.billOpen) renderBillSheet();
}
