// Receipt and invoice markup: an 80 mm receipt and an A4 invoice, both from the bill's invoice (services/receipt-model.js).
import { gstLines } from '../../../domain/invoices/invoice.js';
import { invoiceFor, payLines } from '../services/receipt-model.js';
import { esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

const row=(l,r,cls)=>`<div class="r-row${cls?" "+cls:""}"><span>${l}</span><span>${r}</span></div>`;
const pct=r=>r==null?"":Math.round(r*100)/100+"%";
/* A line's quantity as printed ("2.5 kg", "3") and its rate ("₹43/kg", "₹525") */
const qtyOf=l=>esc(l.qtyText||String(l.qty));
const rateOf=l=>inr(l.rate)+(l.unit?"/"+esc(l.unit):"");
/* Logo, shop name and contact lines (the shop profile controls all of it) */
function shopHTML(I){
  const S=I.seller;
  return `<div class="r-shop">${I.logo?`<img class="r-logo" src="${esc(I.logo)}" alt="">`:""}<b>${esc(S.name)}</b>${S.address?`<span>${esc(S.address)}</span>`:""}${S.phone?`<span>Phone ${esc(S.phone)}</span>`:""}${S.gstin?`<span>GSTIN ${esc(S.gstin)}${S.stateCode?` · ${esc(S.stateName)} (${esc(S.stateCode)})`:""}</span>`:""}</div>`;
}
/* Subtotal → discounts → taxable → GST → round off → total → credit, then payments, change and returns */
function totalsHTML(I){
  const T=I.totals, G=gstLines(I);
  let h=row("Subtotal",inrx(T.subtotal));
  if(T.itemDiscount) h+=row("Item discounts","−"+inrx(T.itemDiscount));
  if(T.billDiscount) h+=row("Bill discount"+(T.billDiscountLabel?" "+esc(T.billDiscountLabel):""),"−"+inrx(T.billDiscount));
  if(G.length&&!I.inclusive) h+=row("Taxable amount",inrx(T.taxable))+G.map(g=>row(g.label,inrx(g.amount))).join("");
  if(T.roundOff) h+=row("Round off",(T.roundOff>0?"+":"")+inrx(T.roundOff));
  h+=row("Total",inr(T.total),"big");
  if(G.length&&I.inclusive) h+=row("Taxable amount",inrx(T.taxable),"small")+G.map(g=>row("Includes "+g.label,inrx(g.amount),"small")).join("");
  if(T.credit) h+=row("Exchange credit","−"+inr(T.credit))+row("Amount due",inr(T.due),"big");
  const P=payLines(I);
  if(!P.length) h+=row("Paid",T.credit?"Covered by the exchange credit":"Nothing to pay");
  else if(P.length===1) h+=row("Paid",esc(P[0].label)+(T.credit?" "+inrx(P[0].amount):"")+(P[0].note?` <small>${esc(P[0].note)}</small>`:""));
  else h+=P.map(p=>row("Paid by "+esc(p.label)+(p.note?` <small>${esc(p.note)}</small>`:""),inrx(p.amount))).join("");
  if(I.change) h+=row("Change given",inrx(I.change),"small");
  if(I.returned) h+=row("Returned items",inr(I.returned),"small")+(I.refunded?row("Refunded",inr(I.refunded),"small"):"");
  return `<div class="r-tot">${h}</div>`;
}
function receipt80(I){
  let h=`<div class="rcpt${I.status==="cancelled"?" void":""}">${shopHTML(I)}`;
  h+=`<div class="r-meta">${I.totals.tax>0?`<b class="r-title">Tax invoice</b>`:""}${row("Bill",esc(I.number))}${row("Date",esc(dtLong(I.t)))}`;
  if(I.buyer) h+=row("Customer",esc(I.buyer.name)+(I.buyer.phone?" · "+esc(I.buyer.phone):""))+(I.buyer.gstin?row("Customer GSTIN",esc(I.buyer.gstin)):"");
  if(I.placeOfSupply&&I.gstMode==="inter") h+=row("Place of supply",esc(I.placeOfSupply.name));
  if(I.status==="cancelled") h+=`<div class="r-void">CANCELLED</div>`;
  h+=`</div><table class="r-items"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${I.lines.map(l=>`<tr><td><b>${esc(l.name)}</b>${l.variant||l.sku?`<span>${esc([l.variant,l.sku].filter(Boolean).join(" · "))}</span>`:""}${trackText(l)}${l.discount?`<span>Discount${l.discountLabel?" "+esc(l.discountLabel):""} −${inrx(l.discount)}</span>`:""}</td><td>${qtyOf(l)}</td><td>${rateOf(l)}</td><td>${inrx(l.gross)}</td></tr>`).join("")}</tbody></table>`;
  h+=totalsHTML(I);
  return h+`${I.footer?`<p class="r-foot">${esc(I.footer)}</p>`:""}</div>`;
}
/* A4: the full tax invoice — parties, HSN, taxable value and GST per line, GST by rate, amount in words */
function invoiceA4(I){
  const inter=I.gstMode==="inter", tax=I.totals.tax>0&&I.lineTax, hsn=I.lines.some(l=>l.hsn), T=I.totals;
  let h=`<div class="rcpt a4${I.status==="cancelled"?" void":""}"><div class="i-head">${shopHTML(I)}<div class="i-meta"><b class="r-title">${esc(I.title)}</b>${row("Invoice no",esc(I.number))}${row("Date",esc(dtLong(I.t)))}${I.placeOfSupply&&I.gstMode!=="none"?row("Place of supply",`${esc(I.placeOfSupply.name)} (${esc(I.placeOfSupply.code)})`):""}</div></div>`;
  if(I.status==="cancelled") h+=`<div class="r-void">CANCELLED — not a valid invoice</div>`;
  h+=`<div class="i-party"><span class="i-lab">Bill to</span>${I.buyer?`<b>${esc(I.buyer.name)}</b>${I.buyer.business?" <small>(business)</small>":""}${I.buyer.phone?`<span>${esc(I.buyer.phone)}</span>`:""}${I.buyer.email?`<span>${esc(I.buyer.email)}</span>`:""}${I.buyer.gstin?`<span>GSTIN ${esc(I.buyer.gstin)}</span>`:""}`:"<b>Walk-in customer</b>"}</div>`;
  const heads=["#","Item",...(hsn?["HSN"]:[]),"Qty","Rate","Discount",...(tax?["Taxable","GST",...(inter?["IGST"]:["CGST","SGST"])]:[]),"Amount"];
  h+=`<table class="r-items i-table"><thead><tr>${heads.map(x=>`<th>${x}</th>`).join("")}</tr></thead><tbody>${I.lines.map(l=>`<tr><td>${l.sl}</td><td><b>${esc(l.name)}</b>${l.variant||l.sku?`<span>${esc([l.variant,l.sku].filter(Boolean).join(" · "))}</span>`:""}${trackText(l)}</td>${hsn?`<td>${esc(l.hsn)}</td>`:""}<td>${qtyOf(l)}</td><td>${rateOf(l)}</td><td>${l.discount||l.billDiscount?"−"+inrx(l.discount+l.billDiscount):"—"}</td>`+
    (tax?`<td>${inrx(l.taxable)}</td><td>${pct(l.gstRate)}</td>${inter?`<td>${inrx(l.igst)}</td>`:`<td>${inrx(l.cgst)}</td><td>${inrx(l.sgst)}</td>`}`:"")+`<td>${l.total!=null?inrx(l.total):inrx(l.gross)}</td></tr>`).join("")}</tbody></table>`;
  h+=`<div class="i-foot"><div class="i-left">`;
  if(I.taxSummary.length) h+=`<table class="i-tax"><thead><tr><th>GST rate</th><th>Taxable</th>${inter?"<th>IGST</th>":"<th>CGST</th><th>SGST</th>"}<th>Total GST</th></tr></thead><tbody>${I.taxSummary.map(r=>`<tr><td>${r.rate!=null?pct(r.rate):"—"}</td><td>${inrx(r.taxable)}</td>${inter?`<td>${inrx(r.igst)}</td>`:`<td>${inrx(r.cgst)}</td><td>${inrx(r.sgst)}</td>`}<td>${inrx(r.tax)}</td></tr>`).join("")}</tbody></table>`;
  h+=`<p class="i-words"><span class="i-lab">Amount in words</span>${esc(I.amountInWords)}</p>`;
  if(I.returns.length) h+=`<div class="i-rets"><span class="i-lab">Returns and exchanges</span>${I.returns.map(r=>`<span>${r.kind==="exchange"?"Exchange":"Return"} · ${esc(dtLong(r.t))} · ${esc(r.items.map(i=>i.name+(i.variant?" "+i.variant:"")+" × "+(i.qtyText||i.qty)).join(", "))} · ${inr(r.value)}${r.refund?` · refunded ${inr(r.refund)} (${esc(r.label)})`:""}</span>`).join("")}</div>`;
  h+=`</div>${totalsHTML(I)}</div>`;
  if(T.tax>0) h+=`<p class="i-note">${I.inclusive?"Prices include GST.":"GST is added to the prices."}</p>`;
  return h+`${I.footer?`<p class="r-foot">${esc(I.footer)}</p>`:""}<p class="i-gen">Computer-generated invoice.</p></div>`;
}
/* s: a saved bill; paper: "80mm" | "a4" */
/* serial numbers and batches of a line, under the item */
const trackText=l=>(l.serials?`<span>SN ${esc(l.serials)}</span>`:"")+(l.batch?`<span>Batch ${esc(l.batch)}</span>`:"");
export function receiptHTML(s,paper){ const I=invoiceFor(s); return paper==="a4"?invoiceA4(I):receipt80(I); }
export const RECEIPT_CSS=`*{box-sizing:border-box}body{margin:0;font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#000;background:#fff}
.rcpt{width:72mm;margin:0 auto;padding:2mm 0;font-size:11.5px;line-height:1.35;position:relative}.rcpt.a4{width:auto;max-width:190mm;font-size:12.5px;padding:10mm 0}
.r-shop{text-align:center;display:flex;flex-direction:column;align-items:center;gap:1px;margin-bottom:6px}.r-shop b{font-size:15px}.r-logo{max-width:44mm;max-height:22mm;object-fit:contain;margin-bottom:3px}
.r-title{display:block;font-size:15px;margin:2px 0 4px}.r-meta{border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0;margin-bottom:4px}
.r-row{display:flex;justify-content:space-between;gap:8px}.r-row>span:last-child{text-align:right}.r-row small{font-size:.85em;color:#333}.r-row.big{font-weight:700;font-size:13.5px}.r-row.small{font-size:10.5px}
.r-void{text-align:center;font-weight:700;letter-spacing:.2em;margin-top:3px}.rcpt.void .r-items,.rcpt.void .r-tot{opacity:.55}
.r-items{width:100%;border-collapse:collapse}.r-items th{font-size:10px;text-align:right;border-bottom:1px solid #000;padding:2px 0}.r-items th:first-child,.r-items td:first-child{text-align:left}
.r-items td{text-align:right;vertical-align:top;padding:3px 0;border-bottom:1px dotted #999}.r-items td span{display:block;font-size:10px;color:#333}.r-items td+td{padding-left:4px;white-space:nowrap}
.r-tot{margin-top:4px;display:flex;flex-direction:column;gap:1px}.r-foot{text-align:center;margin:8px 0 0;font-size:10.5px}
.a4 .i-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:8px}
.a4 .r-shop{align-items:flex-start;text-align:left}.a4 .r-shop b{font-size:20px}.a4 .r-logo{max-width:50mm;max-height:24mm}
.a4 .i-meta{min-width:62mm}.a4 .r-title{font-size:18px;text-align:right;text-transform:uppercase;letter-spacing:.04em}
.i-party{display:flex;flex-direction:column;gap:1px;margin:6px 0 8px}.i-lab{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#444;margin-bottom:2px}
.a4 .i-table th,.a4 .i-table td{text-align:right;padding:4px 4px}.a4 .i-table th:nth-child(2),.a4 .i-table td:nth-child(2){text-align:left}.a4 .i-table td span{font-size:11px}
.i-foot{display:flex;gap:18px;justify-content:space-between;align-items:flex-start;margin-top:8px}.i-left{flex:1;display:flex;flex-direction:column;gap:8px}.a4 .r-tot{min-width:70mm}
.i-tax{border-collapse:collapse;font-size:11px}.i-tax th,.i-tax td{border:1px solid #999;padding:2px 6px;text-align:right}
.i-words,.i-note,.i-gen{margin:0;font-size:11px}.i-rets{display:flex;flex-direction:column;gap:2px;font-size:11px}.i-gen{margin-top:10px;color:#555;text-align:center}
.a4 .r-row.big{font-size:16px}.a4 .r-void{font-size:16px;border:2px solid #000;padding:4px;margin:6px 0}
@page{size:80mm auto;margin:3mm}`;
