// The bill being rung up (panel, bar, sheet).
import { store } from '../../../shared/state/store.js';
import { lineLabel } from '../../../domain/catalog/variants.js';
import { discountLabel, normalizeDiscount } from '../../../domain/sales/discounts.js';
import { payLabel } from '../../../domain/sales/payments.js';
import { billTotals } from '../services/totals.js';
import { billDiscountError } from '../use-cases/discounts.js';
import { discountRowsHTML, gstRowsHTML, roundRowHTML, sumRow } from './bill-summary.js';
import { thumb } from '../../products/components/thumb.js';
import { prod } from '../../products/services/catalog.js';
import { availOf, cartPcs } from '../services/cart.js';
import { billNo, isVoid, todayStats } from '../services/sales-log.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { hhmm } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { initials } from '../../../shared/utils/text.js';
import { billHoldHTML, billOrderHTML, billQuoteHTML } from '../../orders/components/bill-extras.js';

/* ---------- the bill ---------- */

/* Cash / UPI / Card open the payment screen with that method chosen (Split is there too) */
export function payBtns(dis){const d=dis?" disabled":"";return `<button class="pay cash" data-pay="cash"${d}>Cash<span class="kh">C</span></button><button class="pay upi" data-pay="upi"${d}>UPI<span class="kh">U</span></button><button class="pay card" data-pay="card"${d}>Card<span class="kh">K</span></button>`}
export function lineHTML(c,i,L){
  const p=prod(c.p)||{id:c.p,name:c.name,color:c.color};
  const lab=lineLabel(c), a=availOf(c.v), what=esc((c.name+" "+lab).trim()), d=normalizeDiscount(c.disc), off=L?L.itemDisc:0, gross=c.q*c.price;
  return `<div class="li" data-li="${i}">${thumb(p,"sm")}<div><div class="nm">${esc(c.name)}</div><div class="sub">${lab?`<span class="szl">${esc(lab)}</span>`:""}${c.sku?`<span class="lsku">SKU ${esc(c.sku)}</span>`:""}<span>${inr(c.price)} each</span>${d?`<span class="ldisc" data-ldisc="${i}">${esc(discountLabel(d))} off · −${inrx(off)}</span>`:""}</div>`+
    `<button type="button" class="link xs ldbtn" data-linedisc="${i}" aria-label="${d?"Change the":"Add a"} discount on ${what}">${d?"Edit discount":"Discount"}</button><button type="button" class="link xs rmline" data-rmline="${i}" aria-label="Remove ${what} from the bill">Remove</button></div>`+
    `<div class="lir"><span class="amt" data-lineamt="${i}">${off?`<s>${inr(gross)}</s> `:""}${inrx(gross-off)}</span><span class="step"><button data-dec="${i}" aria-label="One less ${what}">−</button>`+
    `<input type="number" inputmode="numeric" min="1" max="${c.q+Math.max(0,a)}" step="1" value="${c.q}" data-lineqty="${i}" aria-label="Quantity of ${what}">`+
    `<button data-inc="${i}" aria-label="One more ${what}"${a<=0?" disabled":""}>+</button></span></div></div>`;
}
export function custLineHTML(){
  if(store.cartCust&&store.cartCust.name)return `<div class="custline"><span class="avatar sm">${esc(initials(store.cartCust.name))}</span><div><b>${esc(store.cartCust.name)}</b>${store.cartCust.phone?`<span>${esc(store.cartCust.phone)}</span>`:""}</div><button class="link xs" data-act="pickcust">Change</button><button class="iconbtn sm" data-act="nocust" aria-label="Remove customer">${ICON.x}</button></div>`;
  return `<div class="custline walkin"><span>Customer · <b>Walk-in</b></span><button class="link xs" data-act="pickcust">+ Add customer</button></div>`;
}
export function emptyBillHTML(){
  const t=todayStats();
  let h=`<div class="be">${ICON.bag}<p><b>No items yet</b><br>Tap a product, or search or scan.</p></div>`;
  h+=`<div class="tmini"><div><span>Sold today</span><b>${inr(t.rev)}</b></div><div><span>Bills</span><b>${t.bills}</b></div><div><span>Pieces</span><b>${t.pcs}</b></div></div>`;
  if(store.lastSale&&!isVoid(store.lastSale.id))h+=`<div class="lastbill"><div><div class="eyebrow">Last bill · ${esc(hhmm(store.lastSale.t))}</div><b>${inr(store.lastSale.total)}</b> · ${esc(payLabel(store.lastSale))}</div><button class="btn xs" data-billview="${esc(store.lastSale.id)}">Receipt</button></div>`;
  return h;
}
/* Rows under the discount box: the bill discount taken off, GST, round off and the total (redrawn while typing a discount) */
const billSumHTML=T=>discountRowsHTML({itemDisc:0,billDisc:T.billDisc},store.disc)+gstRowsHTML(T)+roundRowHTML(T)+`<div class="row tot"><span>Total</span><span class="grand" data-grand>${inr(T.total)}</span></div>`;
function discBoxHTML(where,empty){
  const d=store.disc||{type:"fixed",value:""}, ty=d.type==="percent"?"percent":"fixed", dis=empty?" disabled":"";
  return `<div class="row discrow"><label for="disc_${where}">Bill discount</label><span class="discwrap"><span class="dtype" role="group" aria-label="Discount in rupees or percent">`+
    `<button type="button" data-disctype="fixed" aria-pressed="${ty==="fixed"}"${dis}>₹</button><button type="button" data-disctype="percent" aria-pressed="${ty==="percent"}"${dis}>%</button></span>`+
    `<input id="disc_${where}" data-disc type="number" inputmode="decimal" min="0" ${ty==="percent"?'max="100" ':""}step="any" placeholder="0" value="${esc(d.value===""||d.value==null?"":String(d.value))}" aria-describedby="discerr_${where}"${dis}></span></div>`;
}
export function billPanelHTML(where){
  const pcs=cartPcs(),T=billTotals(store.cart,store.disc),empty=!store.cart.length,err=empty?"":billDiscountError();
  return `<div class="bp">
    <div class="bp-head"><div><div class="eyebrow">Bill #${billNo()}</div><div class="bp-title">${empty?"New bill":pcs+" piece"+(pcs>1?"s":"")}</div></div><div class="bp-hact">${billHoldHTML(empty)}${empty?"":`<button class="link" data-act="clear">Clear</button>`}${where==="sheet"?`<button class="iconbtn" data-act="closesheet" aria-label="Close bill">${ICON.x}</button>`:""}</div></div>
    ${custLineHTML()}${billOrderHTML()}
    <div class="bp-items">${empty?emptyBillHTML():store.cart.map((c,i)=>lineHTML(c,i,T.lines[i])).join("")}</div>
    <div class="bp-foot">
      ${sumRow("Subtotal",inr(T.sub))}${discountRowsHTML({itemDisc:T.itemDisc,billDisc:0})}
      ${discBoxHTML(where,empty)}
      <div data-billsum>${billSumHTML(T)}</div>
      <p class="discerr" id="discerr_${where}" data-discerr role="alert"${err?"":" hidden"}>${esc(err)}</p>
      <div class="pays">${payBtns(empty||!!err)}</div>${billQuoteHTML(empty)}
    </div></div>`;
}
export function billBarHTML(){
  if(!store.cart.length){const t=todayStats();return `<div class="bb-empty"><div><div class="eyebrow">Today</div><div class="bb-today"><b>${inr(t.rev)}</b><span>${t.bills} bill${t.bills===1?"":"s"} · ${t.pcs} pcs</span></div></div><span class="bb-hint">Tap a product<br>to start a bill</span></div>`}
  const pcs=cartPcs(),T=billTotals(store.cart,store.disc);
  return `<button class="bb-sum" data-act="openbill" aria-label="View bill"><span class="bb-th">${store.cart.slice(-3).map(c=>thumb(prod(c.p)||{id:c.p,name:c.name,color:c.color},"xs")).join("")}</span><span class="bb-cnt"><b>${pcs} piece${pcs>1?"s":""}${store.cartCust&&store.cartCust.name?" · "+esc(store.cartCust.name):""}</b><small>View bill ${ICON.up}</small></span><span class="bb-total" data-grand>${inr(T.total)}</span></button><div class="pays">${payBtns(!!billDiscountError())}</div>`;
}
export function typingDisc(){const a=document.activeElement;return !!(a&&a.matches&&a.matches("[data-disc],[data-lineqty]"))}
export function renderBill(){if(typingDisc())return;$("#billPanel").innerHTML=billPanelHTML("panel");$("#billBar").innerHTML=billBarHTML()}
/* While the discount is being typed: redraw the figures, the message and the pay buttons, not the box being typed in */
export function updateBillTotals(){
  const T=billTotals(store.cart,store.disc),err=billDiscountError();
  $$("[data-billsum]").forEach(b=>{b.innerHTML=billSumHTML(T)});
  $$("[data-grand]").forEach(g=>{g.textContent=inr(T.total)});
  $$("[data-discerr]").forEach(p=>{p.textContent=err;p.hidden=!err});
  $$(".pays [data-pay]").forEach(b=>{b.disabled=!store.cart.length||!!err});
}
export function renderBillSheet(){
  if(!store.cart.length){closeSheets();return}
  if(typingDisc())return;
  document.body.style.overflow="hidden";
  $("#sheetHost").innerHTML=`<div class="scrim" data-scrim><div class="sheet billsheet" role="dialog" aria-modal="true" aria-label="Current bill">${billPanelHTML("sheet")}</div></div>`;
}
export function closeSheets(){store.pick=null;store.billOpen=false;$("#sheetHost").innerHTML="";document.body.style.overflow=""}
