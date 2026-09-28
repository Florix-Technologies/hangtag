// GST report for a period: invoices (bills) and credit notes (returns), from the tax saved on each bill line and each
// return line — never worked out again, so it always matches the invoices that were issued. Hangtag prepares these figures
// for filing; it does not file returns.
//   · B2B: a business customer with a valid GSTIN (as saved on the bill); everything else is B2C.
//   · Place of supply: the state saved on the bill (the customer's GSTIN state, else the shop's).
//   · Credit notes: every return, with the original invoice's number, date, customer and place of supply.
//   · Cancelled invoices are listed apart and left out of every total.
// Pure; rupees in and out, added up in paise.
import { gstinState, stateName } from '../sales/gst.js';
import { savedLine } from '../returns/return-value.js';
import { returnLineMoney } from '../reports/sales-report.js';
import { toPaise, toRupees } from '../sales/paise.js';

const R=toRupees, TAX=["taxable","cgst","sgst","igst"];
export const DISCLAIMER="Prepared by Hangtag from your saved invoices and credit notes to help with GST filing. Hangtag does not file GST returns.";
export const isB2B=s=>!!(s&&s.cust&&s.cust.type==="business"&&gstinState(s.cust.gstin));
const lineOf=(sale,ln)=>sale&&sale.items.find((x,k)=>(x.ln!=null?x.ln:k)===ln);
const rateOf=(sale,i)=>i&&i.gst!=null?+i.gst:+(sale&&sale.taxRate)||0;

/* A bill as an invoice for GST: its lines' saved taxable value and tax (paise inside, rupees out) */
export function gstInvoice(sale){
  const lines=sale.items.map(i=>{const f=savedLine(sale,i);return {rate:rateOf(sale,i),hsn:i.hsn||"",q:i.q,taxable:f.tx,cgst:f.cgst,sgst:f.sgst,igst:f.igst,total:f.lt}});
  return {...doc({id:sale.id,no:sale.no||"",t:sale.t,cancelled:!!sale.void,sale,lines,total:toPaise(sale.total),roundOff:toPaise(sale.roundOff||0)}),discount:R(toPaise(sale.disc||0))};
}
/* A return as a credit note: its lines' GST as saved on the return (or their share of the bill line's), with the bill's details */
export function gstCreditNote(ret,sale){
  const lines=(ret.items||[]).map(i=>{const m=returnLineMoney(sale,i),sl=lineOf(sale,i.ln);
    return {rate:i.gst!=null?+i.gst:rateOf(sale,sl),hsn:i.hsn||(sl&&sl.hsn)||"",q:i.q,taxable:-toPaise(m.rev),cgst:-toPaise(m.cgst),sgst:-toPaise(m.sgst),igst:-toPaise(m.igst),total:toPaise(i.value)}});
  const d=doc({id:ret.id,no:ret.no||"",t:ret.t,cancelled:false,sale,lines,total:toPaise(ret.value),roundOff:toPaise(ret.ro||0)});
  return {...d,invoiceNo:sale&&sale.no||"",invoiceT:sale&&sale.t||null,invoiceValue:sale?R(toPaise(sale.total)):0,saleId:sale&&sale.id||"",kind:ret.kind||"return"};
}
function doc({id,no,t,cancelled,sale,lines,total,roundOff}){
  const s=sale||{}, sum=k=>lines.reduce((a,l)=>a+l[k],0), pos=s.gst&&s.gst.pos||"";
  return {id,no,t,cancelled,b2b:isB2B(s),gstin:s.cust&&s.cust.gstin||"",customer:s.cust&&s.cust.name||"",business:!!(s.cust&&s.cust.type==="business"),
    pos,posName:stateName(pos),mode:s.gst&&s.gst.mode||(sum("igst")?"inter":sum("cgst")?"intra":"none"),
    lines:lines.map(l=>({...l,taxable:R(l.taxable),cgst:R(l.cgst),sgst:R(l.sgst),igst:R(l.igst),total:R(l.total)})),
    taxable:R(sum("taxable")),cgst:R(sum("cgst")),sgst:R(sum("sgst")),igst:R(sum("igst")),tax:R(sum("cgst")+sum("sgst")+sum("igst")),total:R(total),roundOff:R(roundOff)};
}
const add=(o,x,sign=1)=>{TAX.forEach(k=>{o[k]=(o[k]||0)+sign*toPaise(x[k])});return o};
const out=o=>{const r={...o};TAX.forEach(k=>{r[k]=R(o[k]||0)});r.tax=R((o.cgst||0)+(o.sgst||0)+(o.igst||0));return r};
const numOrder=(a,b)=>String(a).localeCompare(String(b),"en",{numeric:true});
/* sales: bills dated in the period (cancelled ones too) · returns: returns dated in the period · saleById: every bill */
export function gstReport({sales,returns,saleById}){
  const all=(sales||[]).map(gstInvoice), invoices=all.filter(d=>!d.cancelled), cancelled=all.filter(d=>d.cancelled);
  const notes=(returns||[]).filter(r=>!(saleById[r.sale]||{}).void).map(r=>gstCreditNote(r,saleById[r.sale]));
  const T={inv:{},cn:{}}, b2b={count:0,notes:0}, b2c={count:0,notes:0}, rates={}, hsn={}, pos={}, nil={taxable:0,count:0};
  let invTotal=0,cnTotal=0;
  invoices.forEach(d=>{add(T.inv,d); invTotal+=toPaise(d.total); const g=d.b2b?b2b:b2c; g.count++; add(g,d);
    d.lines.forEach(l=>{add(rates[l.rate]||(rates[l.rate]={rate:l.rate}),l); const h=hsn[l.hsn||"—"]||(hsn[l.hsn||"—"]={hsn:l.hsn||"",q:0}); h.q+=l.q; add(h,l);
      if(!d.b2b){const k=d.pos+"|"+l.rate; add(pos[k]||(pos[k]={pos:d.pos,posName:d.posName,rate:l.rate}),l);}
      if(!l.rate){nil.taxable+=toPaise(l.taxable);nil.count++;}})});
  notes.forEach(d=>{add(T.cn,d); cnTotal+=toPaise(d.total); const g=d.b2b?b2b:b2c; g.notes++; add(g,d,-1);
    d.lines.forEach(l=>{add(rates[l.rate]||(rates[l.rate]={rate:l.rate}),l,-1); const h=hsn[l.hsn||"—"]||(hsn[l.hsn||"—"]={hsn:l.hsn||"",q:0}); h.q-=l.q; add(h,l,-1);
      if(!d.b2b){const k=d.pos+"|"+l.rate; add(pos[k]||(pos[k]={pos:d.pos,posName:d.posName,rate:l.rate}),l,-1);}
      if(!l.rate) nil.taxable-=toPaise(l.taxable);})});
  const net={}; TAX.forEach(k=>{net[k]=(T.inv[k]||0)-(T.cn[k]||0)});
  const issues=[];
  all.forEach(d=>{ if(d.business&&!d.b2b) issues.push({kind:"gstin",no:d.no,text:`Invoice ${d.no}: business customer without a valid GSTIN — reported as B2C.`});
    if(!d.cancelled&&d.tax>0&&d.lines.some(l=>!l.hsn&&(l.cgst||l.sgst||l.igst))) issues.push({kind:"hsn",no:d.no,text:`Invoice ${d.no}: a taxed line has no HSN code.`}); });
  const nums=list=>list.map(d=>d.no).filter(Boolean).sort(numOrder);
  const docs={invoices:{count:all.length,cancelled:cancelled.length,first:nums(all)[0]||"",last:nums(all).slice(-1)[0]||""},
    creditNotes:{count:notes.length,first:nums(notes)[0]||"",last:nums(notes).slice(-1)[0]||""}};
  return {invoices,cancelled,creditNotes:notes,
    totals:{invoices:out(T.inv),creditNotes:out(T.cn),net:out(net),invoiceValue:R(invTotal),creditValue:R(cnTotal),netValue:R(invTotal-cnTotal),
      discounts:R(invoices.reduce((a,d)=>a+toPaise(d.discount),0))},
    b2b:out(b2b),b2c:out(b2c),rates:Object.values(rates).sort((a,b)=>a.rate-b.rate).map(out),
    hsn:Object.values(hsn).sort((a,b)=>numOrder(a.hsn,b.hsn)).map(out),b2cByPlace:Object.values(pos).sort((a,b)=>numOrder(a.pos,b.pos)||a.rate-b.rate).map(out),
    nilRated:{taxable:R(nil.taxable),lines:nil.count},docs,issues,disclaimer:DISCLAIMER};
}
