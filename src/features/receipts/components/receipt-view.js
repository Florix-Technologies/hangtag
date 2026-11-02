// The 80 mm receipt (on screen, printed from the browser): a layout of the bill's one document
// (domain/documents/bill-content.js), like every other output — the A4 tax invoice is the document model's
// (services/doc-models.js invoiceModel, laid out by components/doc-render.js for its preview, print and PDF), the thermal
// printer's text is domain/receipts/thermal.js, the shared image and the WhatsApp text are services/receipt-output.js and
// services/receipt-model.js. None of them decides a total, a label or an order: the document does.
import { billContent, billRows, lineSub } from '../../../domain/documents/bill-content.js';
import { invoiceFor } from '../services/receipt-model.js';
import { invoiceModel } from '../services/doc-models.js';
import { documentHTML } from './doc-render.js';
import { docOptions } from './doc-actions.js';
import { esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

const row = (l, r, cls) => `<div class="r-row${cls ? " " + cls : ""}"><span>${l}</span><span>${r}</span></div>`;
/* a money row of the document, as printed: its sign and the exact amount */
export const rowAmount = (x, fmt = inrx) => x.amount == null ? "" : (x.sign || "") + fmt(x.amount);
/* A line's quantity as printed ("2.5 kg", "3") and its rate ("₹43/kg", "₹525") */
const qtyOf = l => esc(l.qtyText || String(l.qty));
const rateOf = l => inr(l.rate) + (l.unit ? "/" + esc(l.unit) : "");
/* Logo, shop name and contact lines (the shop profile controls all of it) */
function shopHTML(B){
  const S = B.seller;
  return `<div class="r-shop">${B.logo ? `<img class="r-logo r-logo-${esc(B.logoAlign || "center")}" src="${esc(B.logo)}" alt="">` : ""}<b>${esc(S.name)}</b>${S.address ? `<span>${esc(S.address)}</span>` : ""}${S.phone ? `<span>Phone ${esc(S.phone)}</span>` : ""}${S.gstin ? `<span>GSTIN ${esc(S.gstin)}${S.stateCode ? ` · ${esc(S.stateName)} (${esc(S.stateCode)})` : ""}</span>` : ""}</div>`;
}
/* The document's money rows: totals, how it was paid (or what settled it), then the balance due, change and returns */
function totalsHTML(B){
  return `<div class="r-tot">${billRows(B).map(x => row(esc(x.label) + (x.note ? ` <small>${esc(x.note)}</small>` : ""), rowAmount(x), x.grand ? "big" : x.small ? "small" : "")).join("")}</div>`;
}
function receipt80(B){
  let h = `<div class="rcpt${B.cancelled ? " void" : ""}">${shopHTML(B)}`;
  h += `<div class="r-meta">${B.kind === "invoice" ? `<b class="r-title">${esc(B.title)}</b>` : ""}${row(esc(B.numberLabel), esc(B.number))}${row("Date", esc(dtLong(B.t)))}`;
  if(B.buyer) h += row("Customer", esc(B.buyer.name) + (B.buyer.phone ? " · " + esc(B.buyer.phone) : "")) + (B.buyer.gstin ? row("Customer GSTIN", esc(B.buyer.gstin)) : "");
  if(B.placeOfSupply && B.gstMode === "inter") h += row("Place of supply", esc(B.placeOfSupply.name));
  if(B.cancelled) h += `<div class="r-void">CANCELLED</div>`;
  h += `</div><table class="r-items"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${B.lines.map(l => `<tr><td><b>${esc(l.name)}</b>${lineSub(l) ? `<span>${esc(lineSub(l))}</span>` : ""}${l.discount ? `<span>Discount${l.discountLabel ? " " + esc(l.discountLabel) : ""} −${inrx(l.discount)}</span>` : ""}</td><td>${qtyOf(l)}</td><td>${rateOf(l)}</td><td>${inrx(l.gross)}</td></tr>`).join("")}</tbody></table>`;
  h += totalsHTML(B);
  return h + `${B.footer ? `<p class="r-foot">${esc(B.footer)}</p>` : ""}</div>`;
}
/* s: a saved bill; paper: "80mm" | "a4" (the A4 tax invoice: the same page as its preview and PDF) */
export function receiptHTML(s, paper){ return paper === "a4" ? documentHTML(invoiceModel(s), docOptions()) : receipt80(billContent(invoiceFor(s))); }
export const RECEIPT_CSS=`*{box-sizing:border-box}body{margin:0;font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#000;background:#fff}
.rcpt{width:72mm;margin:0 auto;padding:2mm 0;font-size:11.5px;line-height:1.35;position:relative}
.r-shop{text-align:center;display:flex;flex-direction:column;align-items:center;gap:1px;margin-bottom:6px}.r-logo-left{align-self:flex-start}.r-logo-right{align-self:flex-end}.r-shop b{font-size:15px}.r-logo{max-width:44mm;max-height:22mm;object-fit:contain;margin-bottom:3px}
.r-title{display:block;font-size:15px;margin:2px 0 4px}.r-meta{border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0;margin-bottom:4px}
.r-row{display:flex;justify-content:space-between;gap:8px}.r-row>span:last-child{text-align:right}.r-row small{font-size:.85em;color:#333}.r-row.big{font-weight:700;font-size:13.5px}.r-row.small{font-size:10.5px}
.r-void{text-align:center;font-weight:700;letter-spacing:.2em;margin-top:3px}.rcpt.void .r-items,.rcpt.void .r-tot{opacity:.55}
.r-items{width:100%;border-collapse:collapse}.r-items th{font-size:10px;text-align:right;border-bottom:1px solid #000;padding:2px 0}.r-items th:first-child,.r-items td:first-child{text-align:left}
.r-items td{text-align:right;vertical-align:top;padding:3px 0;border-bottom:1px dotted #999}.r-items td span{display:block;font-size:10px;color:#333}.r-items td+td{padding-left:4px;white-space:nowrap}
.r-tot{margin-top:4px;display:flex;flex-direction:column;gap:1px}.r-foot{text-align:center;margin:8px 0 0;font-size:10.5px}
@page{size:80mm auto;margin:3mm}`;
