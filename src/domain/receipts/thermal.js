// A receipt for a thermal printer, laid out as plain lines of fixed width (48 characters on 80 mm paper, 32 on 58 mm):
// shop header, bill number and date, customer, items, then the money rows of the bill's one document
// (domain/documents/bill-content.js — the same totals, payments and balance in the same words as the 80 mm receipt, the
// A4 invoice and its PDF), footer. Printer-neutral: a printer adapter (infrastructure/printing/) turns these lines into its
// own commands. Reads the invoice model only. Pure.
import { billContent } from '../documents/bill-content.js';
import { formatMoney, printText } from '../../shared/formatting/money.js';
import { fmtDateTime } from '../../shared/formatting/dates.js';

export const THERMAL_COLUMNS=[48,42,32];
/* Printers' built-in character sets have no currency symbols beyond ASCII (₹ → its region's plain form, money.js printText),
   curly quotes or dashes: plain ASCII, other characters become "?" */
export function asciiText(s){
  return printText(s,"thermal").replace(/[‘’‚′]/g,"'").replace(/[“”„″]/g,'"').replace(/[–—−‐]/g,"-")
    .replace(/×/g,"x").replace(/…/g,"...").replace(/ /g," ").normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^\x20-\x7E]/g,"?");
}
/* An amount in the columns: 2 decimals, the region's grouping, no symbol (the total carries it) */
export const money=n=>formatMoney(n,{output:"thermal",decimals:2,symbol:false});
/* Words wrapped to the width (a word longer than a line is cut) */
export function wrap(text,cols){
  const out=[];let cur="";
  asciiText(text).split(/\s+/).filter(Boolean).forEach(w=>{
    while(w.length>cols){ if(cur){out.push(cur);cur=""} out.push(w.slice(0,cols)); w=w.slice(cols); }
    if(!cur) cur=w; else if(cur.length+1+w.length<=cols) cur+=" "+w; else {out.push(cur);cur=w}
  });
  if(cur) out.push(cur);
  return out.length?out:[""];
}
/* Left text and right text on one line; the left side is cut to make room */
export function pair(left,right,cols){
  const r=asciiText(right), l=asciiText(left), room=Math.max(0,cols-r.length-1);
  return (l.length>room?l.slice(0,room):l).padEnd(room," ")+" "+r;
}
/* Left and right text as lines of the width: one line when both fit, otherwise the left text wrapped and the right text
   right-aligned on the line below — nothing is cut (a bill number or an amount must never lose characters) */
export function columns(left,right,cols){
  const l=asciiText(left), r=asciiText(right);
  if(l.length+1+r.length<=cols) return [pair(l,r,cols)];
  const lead=(l.match(/^ */)||[""])[0].slice(0,Math.max(0,cols-1));
  return [...wrap(l,cols-lead.length).map(t=>lead+t),...wrap(r,cols).map(t=>t.padStart(cols," "))];
}
/* inv: the invoice model (domain/invoices/invoice.js). → { cols, logo, lines: [{ text, align, bold, big }] }
   A "big" line is printed at double width, so it is laid out at half the columns. */
export function thermalReceipt(inv,{cols=48}={}){
  const w=THERMAL_COLUMNS.includes(+cols)?+cols:48, L=[], rule={text:"-".repeat(w),align:"left"};
  const width=o=>o&&o.big?Math.floor(w/2):w;
  const add=(text,o)=>L.push(Object.assign({text:asciiText(text),align:"left"},o||{}));
  const center=(text,o)=>wrap(text,width(o)).forEach(t=>add(t,Object.assign({align:"center"},o)));
  const row=(l,r,o)=>columns(l,r,width(o)).forEach(t=>add(t,o));
  const B=billContent(inv), S=B.seller;
  center(S.name,{bold:true,big:true});
  if(S.address) center(S.address);
  if(S.phone) center("Ph: "+S.phone);
  if(S.gstin) center("GSTIN: "+S.gstin);
  center(B.title.toUpperCase(),{bold:true});
  if(B.cancelled) center("*** CANCELLED ***",{bold:true});
  L.push(rule);
  row(B.numberLabel+" "+inv.number,fmtDateTime(inv.t,{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}));
  if(inv.buyer){
    wrap("Customer: "+inv.buyer.name,w).forEach(t=>add(t));
    if(inv.buyer.phone) wrap("Ph: "+inv.buyer.phone,w).forEach(t=>add(t));
    if(inv.buyer.gstin) add("GSTIN: "+inv.buyer.gstin);
  }
  if(B.placeOfSupply) wrap("Place of supply: "+B.placeOfSupply.name+" ("+B.placeOfSupply.code+")",w).forEach(t=>add(t));
  L.push(rule);
  inv.lines.forEach(l=>{
    wrap(l.name+(l.variant?" ("+l.variant+")":""),w).forEach(t=>add(t,{bold:true}));
    if(l.serials) wrap("SN "+l.serials,w).forEach(t=>add(t));
    if(l.batch) wrap("Batch "+l.batch,w).forEach(t=>add(t));
    row(`  ${l.qtyText||l.qty} x ${money(l.rate)}${l.unit?"/"+l.unit:""}`,money(l.gross));
    if(l.discount) row(`  Discount${l.discountLabel?" "+l.discountLabel:""}`,"-"+money(l.discount));
    if(l.hsn||l.gstRate) add(`  ${l.hsn?"HSN "+l.hsn:""}${l.hsn&&l.gstRate?" | ":""}${l.gstRate?"GST "+l.gstRate+"%":""}`);
  });
  L.push(rule);
  // the document's rows: the grand ones (TOTAL, AMOUNT DUE, BALANCE DUE) in capitals and bold, the total at double width
  const amount=x=>(x.sign==="−"?"-":x.sign)+money(x.amount), grandLabel=l=>l.replace(/^[^(]+/,s=>s.toUpperCase());
  B.totals.forEach(x=>x.key==="total"?row("TOTAL",formatMoney(x.amount,{output:"thermal",decimals:2}),{bold:true,big:true}):row(x.grand?grandLabel(x.label):x.label,amount(x),x.grand?{bold:true}:undefined));
  L.push(rule);
  if(B.settled) add(B.settled);
  B.payments.forEach((p,i)=>{ const raw=inv.payments[i]||{};
    row(p.label,money(p.amount));
    if(raw.method==="cash"&&raw.change) row("  Received "+money(raw.received),"Change "+money(raw.change));
    if(raw.ref) columns("  Ref: "+raw.ref,"",w).map(t=>t.trimEnd()).filter(Boolean).forEach(t=>add(t));
  });
  // what follows (the change is printed under its cash payment above)
  B.closing.filter(x=>x.key!=="change").forEach(x=>row(x.grand?grandLabel(x.label):x.label,amount(x),x.grand?{bold:true}:undefined));
  L.push(rule);
  if(B.footer) center(B.footer);
  return {cols:w,logo:B.logo,lines:L};
}
