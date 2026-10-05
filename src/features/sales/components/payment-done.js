// "Payment successful" sheet: what was paid and how, the change to hand back, and the bill out — print, download, share,
// and send to the customer.
import { PAY_LABELS, dueAmtOf, paymentsOf } from '../../../domain/sales/payments.js';
import { loadChannels } from '../../delivery/use-cases/send-invoice.js';
import { sendBoxHTML } from '../../delivery/components/send-actions.js';
import { printStateHTML } from '../../printing/components/print-actions.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

export function showPaid(sale){
  const ps=paymentsOf(sale), change=ps.reduce((a,p)=>a+(p.change||0),0), owed=+dueAmtOf(sale)||0, paidNow=ps.reduce((a,p)=>a+(+p.amount||0),0);
  const how=ps.length?ps.map(p=>`${PAY_LABELS[p.method]||p.method}${ps.length>1?" "+inrx(p.amount):""}${p.ref?" · ref "+p.ref:""}${p.last4?" · card ••"+p.last4:""}${p.verification==="verified"?" · verified":p.verification==="unverified"?" · unverified":""}`).join(" + "):"Nothing to collect";
  document.body.style.overflow="hidden";
  $("#sheetHost").innerHTML=`<div class="scrim" data-scrim data-paid><div class="sheet paid" role="dialog" aria-modal="true" aria-labelledby="paidT">
    <div class="paid-ic">${ICON.ok}</div>
    <h3 id="paidT">${owed>0||ps.some(p=>p.verification==="unverified")?"Sale completed":"Payment successful"}</h3>
    <div class="paid-amt">${inr(owed>0?paidNow:sale.total-(sale.credit||0))}${owed>0?`<small> paid now</small>`:""}</div>
    <p class="paid-no">Invoice <b data-paidno>${esc(sale.no)}</b></p>
    <p class="paid-sub">${esc(how)}${sale.cust?" · "+esc(sale.cust.name):""}</p>
    ${owed>0?`<p class="paid-change" data-paidowed><b>${inrx(owed)}</b> on ${esc(sale.cust&&sale.cust.name||"the customer")}'s account</p>`:""}
    ${ps.some(p=>p.verification==="unverified")?`<p class="paid-change" data-unverified>UPI checked by hand: <b>Unverified</b> until it's matched with your UPI provider.</p>`:""}
    ${change>0?`<p class="paid-change" data-change>Give change <b>${inrx(change)}</b> <span>(received ${inrx(ps.find(p=>p.method==="cash").received)})</span></p>`:""}
    <div class="paid-acts"><button class="btn" data-billview="${esc(sale.id)}">View bill</button><button class="btn" data-print="${esc(sale.id)}">Print</button><button class="btn" data-dlreceipt="${esc(sale.id)}">Download</button>${navigator.share?`<button class="btn" data-share="${esc(sale.id)}">Share</button>`:""}</div>
    ${printStateHTML(sale.id)}
    ${sendBoxHTML(sale)}
    <button class="btn primary gbtn" data-act="newsale" id="newSaleBtn">New sale</button>
    <button class="link xs danger" data-undosale="${esc(sale.id)}">Cancel this bill</button>
  </div></div>`;
  const b=$("#newSaleBtn"); if(b) b.focus({preventScroll:true});
  loadChannels();   // so WhatsApp knows whether the shop's server can send it
}
