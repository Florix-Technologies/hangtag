// The GST report for the Reports page's period and event filter (domain/gst/gst-report.js), and its CSV export: one file
// with a section per return table (B2B invoices, B2C by place of supply and rate, credit notes, HSN summary, rate-wise
// totals, documents issued, cancelled invoices). Built only from the saved invoices and credit notes.
// Filing preparation for a month (domain/gst/filing.js): the return's sections, checks, and exports as CSV, Excel, PDF
// and a structured JSON dataset, each logged in the shop's settings so later changes to the month can be spotted.
import { gstReport } from '../../../domain/gst/gst-report.js';
import { inFilter } from '../../../domain/events/event.js';
import { store } from '../../../shared/state/store.js';
import { can } from '../../shop/services/access.js';
import { D } from '../../inventory/services/ledger.js';
import { inDays, periodRange } from './report-data.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { csvText } from '../../../shared/utils/csv.js';
import { xlsxBytes } from '../../../shared/utils/xlsx.js';
import { pdfBytes } from '../../../shared/utils/pdf.js';
import { DEFAULT_B2CL_LIMIT, filingSections, gstr1Json, monthRange } from '../../../domain/gst/filing.js';
import { numberingFor } from '../../sales/services/doc-numbers.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';

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

/* ---------- filing preparation for a month (domain/gst/filing.js) ---------- */
/* The month the GST filing view shows ("yyyy-mm"): chosen there, else the month of the Reports period's end */
export function gstMonth(){
  const v=store.gstView&&store.gstView.month;
  return monthRange(v)?v:periodRange().to.slice(0,7);
}
const lastExportOf=(month)=>(store.settings.gstExports||[]).filter(x=>x.period===month).sort((a,b)=>b.t-a.t)[0]||null;
/* { P (the month), G (the GST report), F (the filing sections), last (the month's last export) } */
export function filingFor(month){
  const P=monthRange(month||gstMonth()), G=gstFor(P.from,P.to), last=lastExportOf(P.month);
  return {P,G,F:filingSections(G,{b2clLimit:store.settings.b2clLimit==null?DEFAULT_B2CL_LIMIT:store.settings.b2clLimit,lastExport:last,formats:[numberingFor("invoice"),numberingFor("credit")]}),last};
}
const r2=v=>Math.round((+v||0)*100)/100;
const d10=t=>dayKey(t);
/* The filing sections as tables: [{ name, head, rows }] — the same for Excel, PDF and CSV */
export function filingTables({P,F},{gstin}){
  const rt=r=>[r.rate,r2(r.taxable),r2(r.cgst),r2(r.sgst),r2(r.igst)];
  const T=F.totals;
  return [
    {name:"Summary",head:["Item","Value"],rows:[["Period",P.label],["Shop GSTIN",gstin||"(not set)"],["Invoices",T.invoices],["Cancelled invoices (left out)",T.cancelled],["Credit notes",T.creditNotes],
      ["Invoice value",r2(T.invoiceValue)],["Credit notes value",r2(T.creditValue)],["Total sales (net)",r2(T.value)],["Discounts given",r2(T.discounts)],
      ["Taxable value (net)",r2(T.taxable)],["CGST",r2(T.cgst)],["SGST",r2(T.sgst)],["IGST",r2(T.igst)],["Total GST",r2(T.tax)],
      ["B2B taxable (net)",r2(T.b2b.taxable)],["B2C taxable (net)",r2(T.b2c.taxable)],["B2C large limit",r2(F.b2clLimit)],["Note",F.disclaimer]]},
    {name:"B2B",head:["GSTIN","Customer","Invoice no","Invoice date","Invoice value","Place of supply","Rate %","Taxable value","CGST","SGST","IGST"],
      rows:F.b2b.flatMap(x=>x.rates.map((r,k)=>[x.gstin,x.customer,x.no,d10(x.t),k?"":r2(x.value),place(x),...rt(r)]))},
    {name:"B2C large",head:["Invoice no","Invoice date","Invoice value","Place of supply","Rate %","Taxable value","CGST","SGST","IGST"],
      rows:F.b2cl.flatMap(x=>x.rates.map((r,k)=>[x.no,d10(x.t),k?"":r2(x.value),place(x),...rt(r)]))},
    {name:"B2C others",head:["Supply","Place of supply","Rate %","Taxable value","CGST","SGST","IGST"],rows:F.b2cs.map(x=>[x.supply==="INTER"?"Inter-state":"Intra-state",place(x),...rt(x)])},
    {name:"Credit notes B2B",head:["GSTIN","Customer","Note no","Note date","Invoice no","Invoice date","Note value","Place of supply","Rate %","Taxable value","CGST","SGST","IGST"],
      rows:F.cdnr.flatMap(x=>x.rates.map((r,k)=>[x.gstin,x.customer,x.no,d10(x.t),x.invoiceNo,x.invoiceT?d10(x.invoiceT):"",k?"":r2(x.value),place(x),...rt(r)]))},
    {name:"Credit notes B2C large",head:["Note no","Note date","Invoice no","Invoice date","Note value","Place of supply","Rate %","Taxable value","CGST","SGST","IGST"],
      rows:F.cdnur.flatMap(x=>x.rates.map((r,k)=>[x.no,d10(x.t),x.invoiceNo,x.invoiceT?d10(x.invoiceT):"",k?"":r2(x.value),place(x),...rt(r)]))},
    {name:"Nil rated",head:["Supply","Nil-rated value"],rows:F.nil.map(x=>[{INTERB2B:"Inter-state to registered",INTRAB2B:"Intra-state to registered",INTERB2C:"Inter-state to unregistered",INTRAB2C:"Intra-state to unregistered"}[x.type]||x.type,r2(x.taxable)])},
    {name:"HSN",head:["HSN","Unit","Quantity","Rate %","Total value","Taxable value","CGST","SGST","IGST","Total GST"],
      rows:F.hsn.map(x=>[x.hsn||"(none)","PCS",x.q,x.rate,r2(x.value),r2(x.taxable),r2(x.cgst),r2(x.sgst),r2(x.igst),r2(x.tax)])},
    {name:"Documents",head:["Document","Series","From","To","Total","Cancelled","Net issued"],
      rows:[...F.series.invoices.map(s=>["Invoices",s.series,s.from,s.to,s.total,s.cancelled,s.net]),...F.series.creditNotes.map(s=>["Credit notes",s.series,s.from,s.to,s.total,0,s.total])]},
    {name:"Checks",head:["Check before filing"],rows:F.checks.length?F.checks.map(c=>[c.text]):[["Nothing to check."]]},
  ];
}
/* Exports the month: "csv" | "xlsx" | "pdf" | "json". Each export is logged (time, device, format, totals, fingerprint). */
export async function exportGst(format){
  const X=filingFor(), {P,G,F}=X, gstin=(store.profile||{}).gstin||"";
  if(!G.invoices.length&&!G.creditNotes.length&&!G.cancelled.length){ toast(`No invoices in ${P.label}.`); return false; }
  const tables=filingTables(X,{gstin}), base=`gst-${P.month}`;
  let ok=false;
  if(format==="csv") ok=await use("files").saveFile(base+".csv","﻿"+csvText([["Hangtag GST filing preparation",P.label],[F.disclaimer],[],...tables.flatMap(t=>[[t.name.toUpperCase()],t.head,...t.rows,[]])]),"text/csv");
  else if(format==="xlsx") ok=await use("files").saveFile(base+".xlsx",xlsxBytes(tables.map(t=>({name:t.name,rows:[t.head,...t.rows]}))),"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  else if(format==="pdf") ok=await use("files").saveFile(base+".pdf",pdfBytes({title:`GST filing preparation · ${P.label}`,subtitle:`${(store.profile||{}).shop_name||""}${gstin?" · GSTIN "+gstin:""}`,footer:F.disclaimer,
    blocks:tables.map(t=>({heading:t.name,head:t.head,rows:t.rows}))}),"application/pdf");
  else if(format==="json") ok=await use("files").saveFile(base+"-gstr1.json",JSON.stringify(gstr1Json(F,{gstin,period:P}),null,2),"application/json");
  if(ok===false) return false;
  logGstExport(P.month,format,F);
  return true;
}
function logGstExport(month,format,F){
  const T=F.totals, entry={period:month,format,t:Date.now(),dev:store.dev,digest:F.digest,totals:{taxable:T.taxable,tax:T.tax,value:T.value,invoices:T.invoices,creditNotes:T.creditNotes}};
  // the export history is kept in the shop's settings: only someone who may change them records it (a role that only
  // sees reports still exports)
  if(!can("manage_settings")) return;
  store.settings=Object.assign({},store.settings,{gstExports:[entry,...(store.settings.gstExports||[])].slice(0,60)});
  saveSettings(); enqueue({type:"settings"}); flushSbQueue();
}
