// The GST report for the Reports page's period and event filter (domain/gst/gst-report.js), and its CSV export: one file
// with a section per return table (B2B invoices, B2C by place of supply and rate, credit notes, HSN summary, rate-wise
// totals, documents issued, cancelled invoices). Built only from the saved invoices and credit notes.
import { gstReport } from '../../../domain/gst/gst-report.js';
import { inFilter } from '../../../domain/events/event.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { inDays, periodRange } from './report-data.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { csvText } from '../../../shared/utils/csv.js';

/* from, to: "yyyy-mm-dd" (whole days) · filter: "" | "store" | event id */
export function gstFor(from,to,filter){
  const d=D(), f=filter===undefined?(store.prefs.repEvent||""):filter;
  const sales=d.sales.filter(s=>inDays(s.t,from,to)&&inFilter(s,f));
  const returns=d.rets.filter(r=>inDays(r.t,from,to)&&inFilter(d.saleById[r.sale]||{},f));
  return gstReport({sales,returns,saleById:d.saleById});
}
const n2=v=>(Math.round((+v||0)*100)/100).toFixed(2);
/* The report as CSV rows (sections separated by a blank row) */
export function gstCsvRows(G,{from,to,gstin}){
  const rows=[["Hangtag GST report",from===to?from:from+" to "+to],["Shop GSTIN",gstin||""],[G.disclaimer],[]];
  const tax=o=>[n2(o.taxable),n2(o.cgst),n2(o.sgst),n2(o.igst),n2(o.tax)];
  rows.push(["SUMMARY","","Taxable value","CGST","SGST","IGST","Total GST","Value"]);
  rows.push(["Invoices",G.invoices.length,...tax(G.totals.invoices),n2(G.totals.invoiceValue)]);
  rows.push(["Credit notes (returns)",G.creditNotes.length,...tax(G.totals.creditNotes),n2(G.totals.creditValue)]);
  rows.push(["Net",G.invoices.length,...tax(G.totals.net),n2(G.totals.netValue)]);
  rows.push(["B2B (net)",G.b2b.count,...tax(G.b2b)],["B2C (net)",G.b2c.count,...tax(G.b2c)],["Nil-rated (0%) taxable",G.nilRated.lines,n2(G.nilRated.taxable)],[]);
  rows.push(["B2B INVOICES"],["Invoice no","Invoice date","Customer","GSTIN","Place of supply","Rate %","Taxable value","CGST","SGST","IGST","Invoice value"]);
  G.invoices.filter(i=>i.b2b).forEach(i=>byRate(i.lines).forEach((l,k)=>rows.push([i.no,dayKey(i.t),i.customer,i.gstin,place(i),l.rate,n2(l.taxable),n2(l.cgst),n2(l.sgst),n2(l.igst),k?"":n2(i.total)])));
  rows.push([],["B2C BY PLACE OF SUPPLY AND RATE (net of credit notes)"],["Place of supply","Rate %","Taxable value","CGST","SGST","IGST"]);
  G.b2cByPlace.forEach(p=>rows.push([place(p),p.rate,n2(p.taxable),n2(p.cgst),n2(p.sgst),n2(p.igst)]));
  rows.push([],["CREDIT NOTES (RETURNS)"],["Credit note no","Date","Invoice no","Invoice date","Customer","GSTIN","B2B/B2C","Place of supply","Rate %","Taxable value","CGST","SGST","IGST","Note value"]);
  G.creditNotes.forEach(c=>byRate(c.lines).forEach((l,k)=>rows.push([c.no,dayKey(c.t),c.invoiceNo,c.invoiceT?dayKey(c.invoiceT):"",c.customer,c.gstin,c.b2b?"B2B":"B2C",place(c),l.rate,n2(l.taxable),n2(l.cgst),n2(l.sgst),n2(l.igst),k?"":n2(c.total)])));
  rows.push([],["HSN SUMMARY (net of credit notes)"],["HSN","Quantity","Taxable value","CGST","SGST","IGST","Total GST"]);
  G.hsn.forEach(h=>rows.push([h.hsn||"(none)",h.q,...tax(h)]));
  rows.push([],["RATE-WISE (net of credit notes)"],["Rate %","Taxable value","CGST","SGST","IGST","Total GST"]);
  G.rates.forEach(r=>rows.push([r.rate,...tax(r)]));
  rows.push([],["DOCUMENTS ISSUED"],["Document","From","To","Count","Cancelled"]);
  rows.push(["Invoices",G.docs.invoices.first,G.docs.invoices.last,G.docs.invoices.count,G.docs.invoices.cancelled],["Credit notes",G.docs.creditNotes.first,G.docs.creditNotes.last,G.docs.creditNotes.count,0]);
  rows.push([],["CANCELLED INVOICES (not in any total)"],["Invoice no","Date","Customer","Value"]);
  G.cancelled.forEach(i=>rows.push([i.no,dayKey(i.t),i.customer,n2(i.total)]));
  if(G.issues.length){ rows.push([],["CHECK BEFORE FILING"]); G.issues.forEach(x=>rows.push([x.text])); }
  return rows;
}
const place=d=>d.pos?d.pos+"-"+(d.posName||""):"";
/* A document's lines added up by rate */
export function byRate(lines){
  const m={}; lines.forEach(l=>{const o=m[l.rate]||(m[l.rate]={rate:l.rate,taxable:0,cgst:0,sgst:0,igst:0});["taxable","cgst","sgst","igst"].forEach(k=>{o[k]=Math.round((o[k]+l[k])*100)/100})});
  return Object.values(m).sort((a,b)=>a.rate-b.rate);
}
export async function exportGstCsv(){
  const R=periodRange(), G=gstFor(R.from,R.to);
  if(!G.invoices.length&&!G.creditNotes.length&&!G.cancelled.length){toast("No invoices in this period.");return}
  await use("files").saveFile(`gst-${R.from}${R.to!==R.from?"-to-"+R.to:""}.csv`,"﻿"+csvText(gstCsvRows(G,{from:R.from,to:R.to,gstin:(store.profile||{}).gstin})),"text/csv");
}
