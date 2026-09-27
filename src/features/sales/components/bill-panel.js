// The bill being rung up (panel, bar, sheet).
import { store } from '../../../shared/state/store.js';
import { lineLabel } from '../../../domain/catalog/variants.js';
import { billTotals } from '../services/totals.js';
import { PAYN } from '../../../domain/sales/sale.js';
import { thumb } from '../../products/components/thumb.js';
import { prod } from '../../products/services/catalog.js';
import { availOf, cartPcs } from '../services/cart.js';
import { billNo, isVoid, todayStats } from '../services/sales-log.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { hhmm } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { initials } from '../../../shared/utils/text.js';

/* ---------- the bill ---------- */

export function payBtns(dis){const d=dis?" disabled":"";return `<button class="pay cash" data-pay="cash"${d}>Cash<span class="kh">C</span></button><button class="pay upi" data-pay="upi"${d}>UPI<span class="kh">U</span></button><button class="pay card" data-pay="card"${d}>Card<span class="kh">K</span></button>`}
export function lineHTML(c,i){
  const p=prod(c.p)||{id:c.p,name:c.name,color:c.color};
  const lab=lineLabel(c), a=availOf(c.v);
  return `<div class="li">${thumb(p,"sm")}<div><div class="nm">${esc(c.name)}</div><div class="sub">${lab?`<span class="szl">${esc(lab)}</span>`:""}<span>${inr(c.price)} each</span></div></div><div class="lir"><span class="amt">${inr(c.q*c.price)}</span><span class="step"><button data-dec="${i}" aria-label="One less ${esc(c.name)} ${esc(lab)}">−</button><b>${c.q}</b><button data-inc="${i}" aria-label="One more ${esc(c.name)} ${esc(lab)}"${a<=0?" disabled":""}>+</button></span></div></div>`;
}
export function custLineHTML(){
  if(store.cartCust&&store.cartCust.name)return `<div class="custline"><span class="avatar sm">${esc(initials(store.cartCust.name))}</span><div><b>${esc(store.cartCust.name)}</b>${store.cartCust.phone?`<span>${esc(store.cartCust.phone)}</span>`:""}</div><button class="link xs" data-act="pickcust">Change</button><button class="iconbtn sm" data-act="nocust" aria-label="Remove customer">${ICON.x}</button></div>`;
  return `<div class="custline walkin"><span>Customer · <b>Walk-in</b></span><button class="link xs" data-act="pickcust">+ Add customer</button></div>`;
}
export function emptyBillHTML(){
  const t=todayStats();
  let h=`<div class="be">${ICON.bag}<p><b>No items yet</b><br>Tap a product, or search or scan.</p></div>`;
  h+=`<div class="tmini"><div><span>Sold today</span><b>${inr(t.rev)}</b></div><div><span>Bills</span><b>${t.bills}</b></div><div><span>Pieces</span><b>${t.pcs}</b></div></div>`;
  if(store.lastSale&&!isVoid(store.lastSale.id))h+=`<div class="lastbill"><div><div class="eyebrow">Last bill · ${esc(hhmm(store.lastSale.t))}</div><b>${inr(store.lastSale.total)}</b> · ${PAYN[store.lastSale.pay]}</div><button class="btn xs" data-billview="${esc(store.lastSale.id)}">Receipt</button></div>`;
  return h;
}
export function billPanelHTML(where){
  const pcs=cartPcs(),T=billTotals(store.cart,store.disc),empty=!store.cart.length;
  return `<div class="bp">
    <div class="bp-head"><div><div class="eyebrow">Bill #${billNo()}</div><div class="bp-title">${empty?"New bill":pcs+" piece"+(pcs>1?"s":"")}</div></div><div class="bp-hact">${empty?"":`<button class="link" data-act="clear">Clear</button>`}${where==="sheet"?`<button class="iconbtn" data-act="closesheet" aria-label="Close bill">${ICON.x}</button>`:""}</div></div>
    ${custLineHTML()}
    <div class="bp-items">${empty?emptyBillHTML():store.cart.map(lineHTML).join("")}</div>
    <div class="bp-foot">
      <div class="row"><span>Subtotal</span><span class="tnum">${inr(T.sub)}</span></div>
      <div class="row"><label for="disc_${where}">Discount</label><span class="discwrap">₹<input id="disc_${where}" data-disc type="number" inputmode="numeric" min="0" step="1" placeholder="0" value="${store.disc?store.disc:""}"${empty?" disabled":""}></span></div>
      ${T.rate?`<div class="row taxrow"><span>GST ${esc(String(T.rate))}%${T.incl?" (included)":""}</span><span class="tnum" data-tax>${inr(T.tax)}</span></div>`:""}
      <div class="row tot"><span>Total</span><span class="grand" data-grand>${inr(T.total)}</span></div>
      <div class="pays">${payBtns(empty)}</div>
    </div></div>`;
}
export function billBarHTML(){
  if(!store.cart.length){const t=todayStats();return `<div class="bb-empty"><div><div class="eyebrow">Today</div><div class="bb-today"><b>${inr(t.rev)}</b><span>${t.bills} bill${t.bills===1?"":"s"} · ${t.pcs} pcs</span></div></div><span class="bb-hint">Tap a product<br>to start a bill</span></div>`}
  const pcs=cartPcs(),T=billTotals(store.cart,store.disc);
  return `<button class="bb-sum" data-act="openbill" aria-label="View bill"><span class="bb-th">${store.cart.slice(-3).map(c=>thumb(prod(c.p)||{id:c.p,name:c.name,color:c.color},"xs")).join("")}</span><span class="bb-cnt"><b>${pcs} piece${pcs>1?"s":""}${store.cartCust&&store.cartCust.name?" · "+esc(store.cartCust.name):""}</b><small>View bill ${ICON.up}</small></span><span class="bb-total" data-grand>${inr(T.total)}</span></button><div class="pays">${payBtns(false)}</div>`;
}
export function typingDisc(){const a=document.activeElement;return !!(a&&a.matches&&a.matches("[data-disc]"))}
export function renderBill(){if(typingDisc())return;$("#billPanel").innerHTML=billPanelHTML("panel");$("#billBar").innerHTML=billBarHTML()}
export function updateBillTotals(){const T=billTotals(store.cart,store.disc);$$("[data-grand]").forEach(g=>{g.textContent=inr(T.total)});$$("[data-tax]").forEach(g=>{g.textContent=inr(T.tax)})}
export function renderBillSheet(){
  if(!store.cart.length){closeSheets();return}
  if(typingDisc())return;
  document.body.style.overflow="hidden";
  $("#sheetHost").innerHTML=`<div class="scrim" data-scrim><div class="sheet billsheet" role="dialog" aria-modal="true" aria-label="Current bill">${billPanelHTML("sheet")}</div></div>`;
}
export function closeSheets(){store.pick=null;store.billOpen=false;$("#sheetHost").innerHTML="";document.body.style.overflow=""}
