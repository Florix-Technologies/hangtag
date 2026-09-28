// GST filing preparation for a month: the GST report (gst-report.js — the tax saved on each bill and return line)
// organised by the sections of the monthly outward-supplies return (GSTR-1):
//   B2B invoice-wise · B2C large (inter-state, no GSTIN, above the shop's limit) · B2C others by place of supply and rate
//   (net of their credit notes) · credit notes to registered (CDNR) and unregistered (CDNUR, large invoices) buyers ·
//   nil-rated supplies · HSN summary by rate · documents issued per series,
// the checks to make before filing (GSTIN, HSN, gaps and out-of-order numbers, changes after the last export) and the
// same figures as a structured JSON dataset. Hangtag prepares data for filing; it never files returns. Pure.
import { DISCLAIMER } from './gst-report.js';
import { toPaise, toRupees } from '../sales/paise.js';

export const DEFAULT_B2CL_LIMIT=100000;
const R=toRupees, K=["taxable","cgst","sgst","igst"];
const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
const pad=n=>String(n).padStart(2,"0");

/* "yyyy-mm" → { from, to (yyyy-mm-dd), label ("September 2026"), fp ("092026", the return period) } or null */
export function monthRange(ym){
  const m=/^(\d{4})-(\d{2})$/.exec(String(ym||""));
  if(!m||+m[2]<1||+m[2]>12) return null;
  const y=+m[1], mo=+m[2], last=new Date(Date.UTC(y,mo,0)).getUTCDate();
  return {from:`${y}-${pad(mo)}-01`,to:`${y}-${pad(mo)}-${pad(last)}`,label:`${MONTHS[mo-1]} ${y}`,fp:pad(mo)+y,month:`${y}-${pad(mo)}`};
}
/* A document's lines added up by rate (paise inside, rupees out), with sign -1 for credit notes */
function rateRows(lines,sign=1){
  const m={};
  lines.forEach(l=>{const o=m[l.rate]||(m[l.rate]={rate:l.rate,taxable:0,cgst:0,sgst:0,igst:0});K.forEach(k=>{o[k]+=sign*toPaise(l[k])})});
  return Object.values(m).sort((a,b)=>a.rate-b.rate).map(o=>({rate:o.rate,taxable:R(o.taxable),cgst:R(o.cgst),sgst:R(o.sgst),igst:R(o.igst)}));
}
const acc=(map,key,init,x,sign=1)=>{const o=map[key]||(map[key]={...init,taxable:0,cgst:0,sgst:0,igst:0});K.forEach(k=>{o[k]+=sign*toPaise(x[k])});return o};
const outP=o=>{const r={...o};K.forEach(k=>{r[k]=R(o[k])});r.tax=R(o.cgst+o.sgst+o.igst);return r};
const interState=d=>d.mode==="inter"||toPaise(d.igst)!==0;
const numOrder=(a,b)=>String(a).localeCompare(String(b),"en",{numeric:true});

/* Numbers like "INV-250925-004": the series is everything before the last "-", the number after it */
export function splitDocNo(no){
  const m=/^(.*?)(\d+)$/.exec(String(no||""));
  return m?{series:m[1].replace(/-$/,""),n:+m[2]}:{series:String(no||""),n:null};
}
/* Documents issued, per series: from, to, total, cancelled, net — and the numbers missing inside each series, and
   numbers out of time order */
export function docSeries(docs){
  const S={};
  docs.forEach(d=>{const x=splitDocNo(d.no);const s=S[x.series]||(S[x.series]={series:x.series,docs:[]});s.docs.push({...d,n:x.n})});
  return Object.values(S).sort((a,b)=>numOrder(a.series,b.series)).map(s=>{
    const nums=s.docs.map(d=>d.n).filter(n=>n!=null).sort((a,b)=>a-b), have=new Set(nums), missing=[];
    if(nums.length) for(let n=Math.min(1,nums[0]);n<=nums[nums.length-1]&&missing.length<50;n++) if(n>0&&!have.has(n)) missing.push(n);
    const byTime=s.docs.slice().sort((a,b)=>a.t-b.t||a.n-b.n), late=[];
    for(let i=1;i<byTime.length;i++) if(byTime[i].n!=null&&byTime[i-1].n!=null&&byTime[i].n<byTime[i-1].n) late.push(byTime[i].no);
    const sorted=s.docs.slice().sort((a,b)=>(a.n??0)-(b.n??0)), cancelled=s.docs.filter(d=>d.cancelled).length;
    const seen=new Set(), dupes=[]; s.docs.forEach(d=>{ if(seen.has(d.no)&&!dupes.includes(d.no)) dupes.push(d.no); seen.add(d.no); });
    return {series:s.series,from:sorted[0].no,to:sorted[sorted.length-1].no,total:s.docs.length,cancelled,net:s.docs.length-cancelled,missing,outOfOrder:late,duplicates:dupes};
  });
}
/* A short fingerprint of every document in the report (number, value, tax, cancelled): an export remembers it, so a
   later change to the month's documents can be spotted */
export function gstDigest(G){
  const sig=[...G.invoices,...G.cancelled].map(d=>`i|${d.id}|${d.no}|${toPaise(d.total)}|${toPaise(d.tax)}|${d.cancelled?1:0}`)
    .concat(G.creditNotes.map(d=>`c|${d.id}|${d.no}|${toPaise(d.total)}|${toPaise(d.tax)}`)).sort().join("\n");
  let h=0x811c9dc5;
  for(let i=0;i<sig.length;i++){ h^=sig.charCodeAt(i); h=Math.imul(h,0x01000193)>>>0; }
  return h.toString(16).padStart(8,"0")+":"+(G.invoices.length+G.cancelled.length+G.creditNotes.length);
}

/* G: gstReport(...) for the month · opts: { b2clLimit (rupees), lastExport? ({ digest, t }) } */
export function filingSections(G,{b2clLimit=DEFAULT_B2CL_LIMIT,lastExport=null}={}){
  const lim=toPaise(b2clLimit);
  const large=d=>!d.b2b&&interState(d)&&toPaise(d.total)>lim;
  const cnLarge=c=>!c.b2b&&interState(c)&&toPaise(c.invoiceValue)>lim;
  const inv=d=>({no:d.no,t:d.t,customer:d.customer,gstin:d.gstin,pos:d.pos,posName:d.posName,value:d.total,taxable:d.taxable,tax:d.tax,rates:rateRows(d.lines)});
  // credit notes (gst-report.js) hold what they give back as positive figures: they come off the sections below
  const note=c=>({no:c.no,t:c.t,invoiceNo:c.invoiceNo,invoiceT:c.invoiceT,customer:c.customer,gstin:c.gstin,pos:c.pos,posName:c.posName,value:c.total,
    taxable:c.taxable,tax:c.tax,rates:rateRows(c.lines)});
  const b2b=G.invoices.filter(d=>d.b2b).map(inv), b2cl=G.invoices.filter(large).map(inv);
  const cs={}, nil={}, hsn={};
  G.invoices.forEach(d=>{
    if(!d.b2b&&!large(d)) d.lines.forEach(l=>acc(cs,d.pos+"|"+l.rate+"|"+(interState(d)?"INTER":"INTRA"),{pos:d.pos,posName:d.posName,rate:l.rate,supply:interState(d)?"INTER":"INTRA"},l));
    d.lines.forEach(l=>{
      if(!l.rate){const k=(interState(d)?"INTER":"INTRA")+(d.b2b?"B2B":"B2C");const o=nil[k]||(nil[k]={type:k,taxable:0});o.taxable+=toPaise(l.taxable);}
      const h=acc(hsn,(l.hsn||"")+"|"+l.rate,{hsn:l.hsn||"",rate:l.rate,q:0,value:0},l); h.q+=l.q; h.value+=toPaise(l.total);
    });
  });
  G.creditNotes.forEach(c=>{
    if(!c.b2b&&!cnLarge(c)) c.lines.forEach(l=>acc(cs,c.pos+"|"+l.rate+"|"+(interState(c)?"INTER":"INTRA"),{pos:c.pos,posName:c.posName,rate:l.rate,supply:interState(c)?"INTER":"INTRA"},l,-1));
    c.lines.forEach(l=>{
      if(!l.rate){const k=(interState(c)?"INTER":"INTRA")+(c.b2b?"B2B":"B2C");const o=nil[k]||(nil[k]={type:k,taxable:0});o.taxable-=toPaise(l.taxable);}
      const h=acc(hsn,(l.hsn||"")+"|"+l.rate,{hsn:l.hsn||"",rate:l.rate,q:0,value:0},l,-1); h.q-=l.q; h.value-=toPaise(l.total);
    });
  });
  const cdnr=G.creditNotes.filter(c=>c.b2b).map(note), cdnur=G.creditNotes.filter(cnLarge).map(note);
  const series={invoices:docSeries([...G.invoices,...G.cancelled]),creditNotes:docSeries(G.creditNotes)};
  const checks=G.issues.map(x=>({kind:x.kind,text:x.text}));
  [...series.invoices.map(s=>["Invoice",s]),...series.creditNotes.map(s=>["Credit note",s])].forEach(([what,s])=>{
    if(s.missing.length) checks.push({kind:"gap",text:`${what} series ${s.series||"(no prefix)"}: number${s.missing.length>1?"s":""} ${s.missing.slice(0,10).join(", ")}${s.missing.length>10?"…":""} missing in this month.`});
    if(s.duplicates.length) checks.push({kind:"duplicate",text:`${what} number${s.duplicates.length>1?"s":""} ${s.duplicates.slice(0,5).join(", ")} used more than once.`});
    if(s.outOfOrder.length) checks.push({kind:"order",text:`${what} series ${s.series||"(no prefix)"}: ${s.outOfOrder.slice(0,5).join(", ")} numbered out of time order.`});
  });
  const digest=gstDigest(G);
  if(lastExport&&lastExport.digest&&lastExport.digest!==digest) checks.push({kind:"changed",text:"Invoices or credit notes in this month changed after the last export. Export again and correct what was filed."});
  return {b2b,b2cl,b2cs:Object.values(cs).sort((a,b)=>numOrder(a.pos,b.pos)||a.rate-b.rate).map(outP),cdnr,cdnur,
    nil:Object.values(nil).map(o=>({type:o.type,taxable:R(o.taxable)})),
    hsn:Object.values(hsn).sort((a,b)=>numOrder(a.hsn,b.hsn)||a.rate-b.rate).map(o=>({...outP(o),value:R(o.value)})),
    series,checks,digest,b2clLimit:R(lim),
    totals:{...G.totals.net,value:G.totals.netValue,invoiceValue:G.totals.invoiceValue,creditValue:G.totals.creditValue,discounts:G.totals.discounts||0,
      invoices:G.invoices.length,creditNotes:G.creditNotes.length,cancelled:G.cancelled.length,b2b:G.b2b,b2c:G.b2c},
    disclaimer:DISCLAIMER};
}

/* ---------- the structured dataset (GSTR-1 section names and fields; for checking and for an accountant's tools) ---------- */
const d8=t=>{const d=new Date(t);return `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${d.getFullYear()}`};
const itms=rates=>rates.map((r,i)=>({num:i+1,itm_det:{rt:r.rate,txval:r.taxable,iamt:r.igst,camt:r.cgst,samt:r.sgst,csamt:0}}));
const groupBy=(list,key)=>{const m=new Map();list.forEach(x=>{const k=key(x);if(!m.has(k))m.set(k,[]);m.get(k).push(x)});return m};
/* F: filingSections(...) · shop: { gstin } · period: monthRange(...) */
export function gstr1Json(F,{gstin,period}){
  return {
    _prepared_by:"Hangtag",_note:F.disclaimer+" Check every figure before using it for a return.",
    gstin:gstin||"",fp:period&&period.fp||"",
    b2b:[...groupBy(F.b2b,x=>x.gstin)].map(([ctin,list])=>({ctin,inv:list.map(x=>({inum:x.no,idt:d8(x.t),val:x.value,pos:x.pos,rchrg:"N",inv_typ:"R",itms:itms(x.rates)}))})),
    b2cl:[...groupBy(F.b2cl,x=>x.pos)].map(([pos,list])=>({pos,inv:list.map(x=>({inum:x.no,idt:d8(x.t),val:x.value,itms:itms(x.rates)}))})),
    b2cs:F.b2cs.map(x=>({sply_ty:x.supply,pos:x.pos,typ:"OE",rt:x.rate,txval:x.taxable,iamt:x.igst,camt:x.cgst,samt:x.sgst,csamt:0})),
    cdnr:[...groupBy(F.cdnr,x=>x.gstin)].map(([ctin,list])=>({ctin,nt:list.map(x=>({ntty:"C",nt_num:x.no,nt_dt:d8(x.t),val:x.value,pos:x.pos,rchrg:"N",inv_typ:"R",
      orig_inum:x.invoiceNo,orig_idt:x.invoiceT?d8(x.invoiceT):"",itms:itms(x.rates)}))})),
    cdnur:F.cdnur.map(x=>({typ:"B2CL",ntty:"C",nt_num:x.no,nt_dt:d8(x.t),val:x.value,pos:x.pos,orig_inum:x.invoiceNo,orig_idt:x.invoiceT?d8(x.invoiceT):"",itms:itms(x.rates)})),
    nil:{inv:F.nil.map(x=>({sply_ty:{INTERB2B:"INTRB2B",INTRAB2B:"INTRAB2B",INTERB2C:"INTRB2C",INTRAB2C:"INTRAB2C"}[x.type],nil_amt:x.taxable,expt_amt:0,ngsup_amt:0}))},
    hsn:{data:F.hsn.map((x,i)=>({num:i+1,hsn_sc:x.hsn,desc:"",uqc:"PCS",qty:x.q,val:x.value,txval:x.taxable,iamt:x.igst,camt:x.cgst,samt:x.sgst,csamt:0,rt:x.rate}))},
    doc_issue:{doc_det:[
      {doc_num:1,docs:F.series.invoices.map((s,i)=>({num:i+1,from:s.from,to:s.to,totnum:s.total,cancel:s.cancelled,net_issue:s.net}))},
      {doc_num:5,docs:F.series.creditNotes.map((s,i)=>({num:i+1,from:s.from,to:s.to,totnum:s.total,cancel:0,net_issue:s.total}))}]},
  };
}
