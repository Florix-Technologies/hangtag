// "Payment successful" sheet.
import { PAYN } from '../../../domain/sales/sale.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';

export function showPaid(sale){
  document.body.style.overflow="hidden";
  $("#sheetHost").innerHTML=`<div class="scrim" data-scrim data-paid><div class="sheet paid" role="dialog" aria-modal="true" aria-labelledby="paidT">
    <div class="paid-ic">${ICON.ok}</div>
    <h3 id="paidT">Payment successful</h3>
    <div class="paid-amt">${inr(sale.total-(sale.credit||0))}</div>
    <p class="paid-sub">${esc(PAYN[sale.pay]||sale.pay)} · Bill ${esc(sale.no)}${sale.cust?" · "+esc(sale.cust.name):""}</p>
    <div class="paid-acts"><button class="btn" data-print="${esc(sale.id)}">Print</button><button class="btn" data-wa="${esc(sale.id)}">WhatsApp</button><button class="btn" data-share="${esc(sale.id)}">${navigator.share?"Share":"Download"}</button></div>
    <button class="btn primary gbtn" data-act="newsale" id="newSaleBtn">New sale</button>
    <button class="link xs danger" data-undosale="${esc(sale.id)}">Cancel this bill</button>
  </div></div>`;
  const b=$("#newSaleBtn"); if(b) b.focus({preventScroll:true});
}
