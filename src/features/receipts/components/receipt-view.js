// Receipt markup for 80 mm and A4.
import { receiptModel } from '../services/receipt-model.js';
import { esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';

export function receiptHTML(s,paper){
  const R=receiptModel(s), a4=paper==="a4";
  const row=(l,r,cls)=>`<div class="r-row${cls?" "+cls:""}"><span>${l}</span><span>${r}</span></div>`;
  let h=`<div class="rcpt${a4?" a4":""}">`;
  h+=`<div class="r-shop"><b>${esc(R.shop.name)}</b>${R.shop.address?`<span>${esc(R.shop.address)}</span>`:""}${R.shop.phone?`<span>Phone ${esc(R.shop.phone)}</span>`:""}${R.shop.gstin?`<span>GSTIN ${esc(R.shop.gstin)}</span>`:""}</div>`;
  h+=`<div class="r-meta">${a4?`<b class="r-title">${R.rate?"Tax invoice":"Invoice"}</b>`:""}${row("Bill",esc(R.no))}${row("Date",esc(dtLong(R.t)))}${R.cust?row("Customer",esc(R.cust.name)+(R.cust.phone?" · "+esc(R.cust.phone):"")):""}${R.void?`<div class="r-void">CANCELLED</div>`:""}</div>`;
  h+=`<table class="r-items"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${R.lines.map(l=>`<tr><td><b>${esc(l.name)}</b>${l.var?`<span>${esc(l.var)}${l.sku?" · "+esc(l.sku):""}</span>`:l.sku?`<span>${esc(l.sku)}</span>`:""}</td><td>${l.q}</td><td>${inr(l.price)}</td><td>${inr(l.amt)}</td></tr>`).join("")}</tbody></table>`;
  h+=`<div class="r-tot">${row("Subtotal",inr(R.sub))}${R.disc?row("Discount","−"+inr(R.disc)):""}${R.rate&&!R.incl?row("GST "+R.rate+"%",inr(R.tax)):""}${row("Total",inr(R.total),"big")}${R.rate&&R.incl?row("Includes GST "+R.rate+"%",inr(R.tax),"small"):""}`;
  if(R.credit) h+=row("Exchange credit","−"+inr(R.credit))+row("Paid ("+esc(R.pay)+")",inr(R.paid),"big");
  else h+=row("Paid",esc(R.pay));
  if(R.returned) h+=row("Returned items",inr(R.returned),"small")+(R.refunded?row("Refunded",inr(R.refunded),"small"):"");
  h+=`</div>${R.footer?`<p class="r-foot">${esc(R.footer)}</p>`:""}</div>`;
  return h;
}
export const RECEIPT_CSS=`*{box-sizing:border-box}body{margin:0;font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#000;background:#fff}
.rcpt{width:72mm;margin:0 auto;padding:2mm 0;font-size:11.5px;line-height:1.35}.rcpt.a4{width:auto;max-width:180mm;font-size:13px;padding:10mm 0}
.r-shop{text-align:center;display:flex;flex-direction:column;gap:1px;margin-bottom:6px}.r-shop b{font-size:15px}.a4 .r-shop{align-items:flex-start;text-align:left}.a4 .r-shop b{font-size:20px}
.r-title{display:block;font-size:15px;margin:6px 0}.r-meta{border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0;margin-bottom:4px}
.r-row{display:flex;justify-content:space-between;gap:8px}.r-row.big{font-weight:700;font-size:13.5px}.a4 .r-row.big{font-size:16px}.r-row.small{font-size:10.5px}
.r-void{text-align:center;font-weight:700;letter-spacing:.2em;margin-top:3px}
.r-items{width:100%;border-collapse:collapse}.r-items th{font-size:10px;text-align:right;border-bottom:1px solid #000;padding:2px 0}.r-items th:first-child,.r-items td:first-child{text-align:left}
.r-items td{text-align:right;vertical-align:top;padding:3px 0;border-bottom:1px dotted #999}.r-items td span{display:block;font-size:10px;color:#333}.a4 .r-items td span{font-size:12px}.r-items td+td{padding-left:4px;white-space:nowrap}
.r-tot{margin-top:4px;display:flex;flex-direction:column;gap:1px}.r-foot{text-align:center;margin:8px 0 0;font-size:10.5px}
@page{size:80mm auto;margin:3mm}`;
