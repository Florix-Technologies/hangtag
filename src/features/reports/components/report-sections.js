// Reports page sections built on the report definitions (domain/reports/sales-report.js): the summary, gross profit with
// its cost coverage, stock movement, GST, and the event filter.
import { MOVE_LABELS, MOVE_TYPES, movementTotals } from '../../../domain/inventory/stock-ledger.js';
import { profitSummary } from '../../../domain/reports/sales-report.js';
import { STORE, sortEvents } from '../../../domain/events/event.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { dayBounds } from '../../finance/services/books-data.js';
import { byRate, gstFor } from '../services/gst-data.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';
import { periodRange } from '../services/report-data.js';

const row=(a,b,note)=>`<div class="row"><span>${a}${note?` <small class="note">${note}</small>`:""}</span><span class="tnum">${b}</span></div>`;
/* The figures and what each one means (K: kstats) */
export function summaryHTML(K,P){
  return `<div class="rt-sum repsum">${row("Gross sales",inrx(K.gross),"bills incl. GST")}${row("Returns","−"+inrx(K.returns),`${K.returnCount} return${K.returnCount===1?"":"s"}, ${K.exchangeReturns} exchange${K.exchangeReturns===1?"":"s"}`)}
    <div class="row tot">${`<span>Total sales</span><span class="tnum">${inrx(K.total)}</span>`}</div>
    ${row("Discounts given",inrx(K.discounts))}${row("Net sales (revenue)",inrx(K.netSales),"without GST, after discounts and returns")}
    ${row("GST",inrx(K.gst),[K.cgst?"CGST "+inrx(K.cgst):"",K.sgst?"SGST "+inrx(K.sgst):"",K.igst?"IGST "+inrx(K.igst):""].filter(Boolean).join(" · "))}
    ${K.roundOff?row("Round off",inrx(K.roundOff)):""}${row("Refunds paid",inrx(K.refunds))}
    ${K.exchanges?row("Exchange bills",inrx(K.exchangeSales),`${K.exchanges} · ${inrx(K.exchangeCredit)} covered by returned items`):""}
    ${row("Cost of goods",P.covered||!P.netSales?inrx(P.cogs):"unknown",P.complete?"":`known for ${Math.round(P.coverage*100)}% of net sales`)}
    ${row("Gross profit",P.covered?inrx(P.grossProfit):"—",P.covered?(P.complete?`margin ${P.margin}%`:`on ${inrx(P.covered)} of sales with a known cost · margin ${P.margin}%`):"no cost prices yet")}</div>`;
}
/* Gross profit: never from missing costs; the coverage is always shown when it isn't complete */
export function profitHTML(lines){
  const P=profitSummary(lines);
  if(!P.netSales&&!P.covered) return `<p class="muted">No sales in this period.</p>`;
  const cov=Math.round(P.coverage*100);
  return `<div class="gp"><div><span>Sales${store.settings.taxOn?" (without GST)":""}</span><b>${inrx(P.covered)}</b></div><div><span>Cost of goods</span><b>${inrx(P.cogs)}</b></div><div><span>Gross profit</span><b class="${P.grossProfit<0?"neg":""}">${inrx(P.grossProfit)}</b></div><div><span>Gross margin</span><b>${P.margin==null?"—":P.margin+"%"}</b></div></div>`+
    (P.complete?`<p class="note" style="margin:10px 0 0">Uses the cost price saved on each bill, so it doesn't change if you edit costs later.</p>`
      :`<p class="note" style="margin:10px 0 0">Cost known for ${cov}% of net sales: ${inrx(P.covered)} with a cost, ${inrx(P.uncovered)} without${P.piecesWithoutCost?` (${P.piecesWithoutCost} piece${P.piecesWithoutCost===1?"":"s"})`:""}. Profit covers only the sales with a cost — add cost prices in Products for a full picture.</p>`);
}
/* Stock in and out in the period, by kind (the stock ledger) */
export function movementHTML(R){
  const b=dayBounds(R.from,R.to), M=movementTotals(D().ledger,b), types=MOVE_TYPES.filter(k=>M.byType[k]);
  if(!types.length) return `<p class="muted">No stock changes in this period.</p>`;
  return `<div class="rt-sum">${types.map(k=>row(MOVE_LABELS[k],(k==="SALE"||k==="EXCHANGE_OUT"?"−":k==="ADJUST"&&M.byType[k].pieces<0?"":"+")+M.byType[k].pieces+" pcs",M.byType[k].entries+" entr"+(M.byType[k].entries===1?"y":"ies"))).join("")}
    <div class="row tot"><span>Net change</span><span class="tnum">${M.net>0?"+":""}${M.net} pcs</span></div></div>`;
}
/* GST for the period: net of credit notes, B2B / B2C, and the report + CSV */
export function gstCardHTML(R){
  const G=gstFor(R.from,R.to), N=G.totals.net;
  if(!G.invoices.length&&!G.creditNotes.length&&!G.cancelled.length) return `<p class="muted">No invoices in this period.</p>`;
  return `<div class="bookkpis"><div><span>Taxable value</span><b>${inrx(N.taxable)}</b></div><div><span>CGST + SGST</span><b>${inrx(N.cgst+N.sgst)}</b></div><div><span>IGST</span><b>${inrx(N.igst)}</b></div><div class="hl"><span>Total GST</span><b>${inrx(N.tax)}</b></div></div>
    <p class="note">${G.invoices.length} invoice${G.invoices.length===1?"":"s"} (B2B ${G.b2b.count}, B2C ${G.b2c.count}) · ${G.creditNotes.length} credit note${G.creditNotes.length===1?"":"s"}${G.cancelled.length?` · ${G.cancelled.length} cancelled (left out)`:""}${G.issues.length?` · <b>${G.issues.length} to check</b>`:""}</p>
    <div class="setactions"><button class="btn xs" data-act="gstview">Open GST report</button><button class="btn xs" data-act="gstcsv">Download GST CSV</button></div>`;
}
const tbl=(hd,rows)=>`<div class="tw"><table class="tbl"><thead><tr>${hd.map(x=>`<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.map(r=>`<tr>${r.map(x=>`<td>${esc(x)}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${hd.length}">None</td></tr>`}</tbody></table></div>`;
/* The full GST report for the period, in a sheet */
export function openGstView(){
  const R=periodRange(), G=gstFor(R.from,R.to), N=G.totals;
  const t=o=>[inrx(o.taxable),inrx(o.cgst),inrx(o.sgst),inrx(o.igst),inrx(o.tax)];
  const place=d=>d.pos?d.pos+" "+(d.posName||""):"—";
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet billview wide" role="dialog" aria-modal="true" aria-label="GST report">
    <div class="sh-head"><div class="sh-t"><h3>GST report</h3><p>${esc(R.label)}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <p class="note">${esc(G.disclaimer)}</p>
    ${G.issues.length?`<div class="setsec"><h4>Check before filing</h4>${G.issues.map(x=>`<p class="note">${ICON.warn} ${esc(x.text)}</p>`).join("")}</div>`:""}
    <div class="setsec"><h4>Totals</h4>${tbl(["","Documents","Taxable","CGST","SGST","IGST","GST"],[["Invoices",G.invoices.length,...t(N.invoices)],["Credit notes",G.creditNotes.length,...t(N.creditNotes)],["Net","",...t(N.net)],["B2B (net)",G.b2b.count,...t(G.b2b)],["B2C (net)",G.b2c.count,...t(G.b2c)]])}</div>
    <div class="setsec"><h4>By rate (net)</h4>${tbl(["Rate","Taxable","CGST","SGST","IGST","GST"],G.rates.map(r=>[r.rate+"%",...t(r)]))}</div>
    <div class="setsec"><h4>HSN summary (net)</h4>${tbl(["HSN","Qty","Taxable","CGST","SGST","IGST","GST"],G.hsn.map(h=>[h.hsn||"(none)",h.q,...t(h)]))}</div>
    <div class="setsec"><h4>B2B invoices</h4>${tbl(["Invoice","Date","Customer","GSTIN","Place of supply","Taxable","GST","Value"],G.invoices.filter(i=>i.b2b).map(i=>[i.no,dayKey(i.t),i.customer,i.gstin,place(i),inrx(i.taxable),inrx(i.tax),inrx(i.total)]))}</div>
    <div class="setsec"><h4>B2C by place of supply and rate (net)</h4>${tbl(["Place of supply","Rate","Taxable","CGST","SGST","IGST"],G.b2cByPlace.map(p=>[place(p),p.rate+"%",inrx(p.taxable),inrx(p.cgst),inrx(p.sgst),inrx(p.igst)]))}</div>
    <div class="setsec"><h4>Credit notes</h4>${tbl(["Credit note","Date","Invoice","Customer","Rates","Taxable","GST","Value"],G.creditNotes.map(c=>[c.no||"—",dayKey(c.t),c.invoiceNo,c.customer||"Walk-in",byRate(c.lines).map(l=>l.rate+"%").join(", "),inrx(c.taxable),inrx(c.tax),inrx(c.total)]))}</div>
    <div class="setsec"><h4>Documents issued</h4>${tbl(["Document","From","To","Count","Cancelled"],[["Invoices",G.docs.invoices.first,G.docs.invoices.last,G.docs.invoices.count,G.docs.invoices.cancelled],["Credit notes",G.docs.creditNotes.first,G.docs.creditNotes.last,G.docs.creditNotes.count,0]])}</div>
    ${G.cancelled.length?`<div class="setsec"><h4>Cancelled invoices (left out)</h4>${tbl(["Invoice","Date","Value"],G.cancelled.map(i=>[i.no,dayKey(i.t),inrx(i.total)]))}</div>`:""}
    <div class="setactions"><button class="btn sm primary" data-act="gstcsv">Download GST CSV</button><button class="btn sm" data-modal-close>Close</button></div>
  </div></div>`;
}
/* Reports for everything, the store only, or one event */
export function eventFilterHTML(){
  const evs=sortEvents(Object.values(store.events||{})); if(!evs.length) return "";
  const cur=store.prefs.repEvent||"";
  const b=(k,l)=>`<button class="chipbtn" data-repevent="${esc(k)}" aria-pressed="${cur===k}">${esc(l)}</button>`;
  return `<div class="filters" role="group" aria-label="Where it was sold">${b("","Everywhere")}${b(STORE,"Store only")}${evs.map(e=>b(e.id,e.name+(e.status==="closed"?" (closed)":""))).join("")}</div>`;
}
