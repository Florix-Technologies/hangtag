// A receipt for a thermal printer, laid out as plain lines of fixed width (48 characters on 80 mm paper, 32 on 58 mm):
// shop header, bill number and date, customer, items, discounts, GST, total, payments, footer. Printer-neutral: a printer
// adapter (infrastructure/printing/) turns these lines into its own commands. Reads the invoice model only. Pure.
import { gstLines } from '../invoices/invoice.js';

export const THERMAL_COLUMNS=[48,42,32];
/* Printers' built-in character sets have no ₹, curly quotes or dashes: plain ASCII, other characters become "?" */
export function asciiText(s){
  return String(s==null?"":s).replace(/₹/g,"Rs.").replace(/[‘’‚′]/g,"'").replace(/[“”„″]/g,'"').replace(/[–—−‐]/g,"-")
    .replace(/×/g,"x").replace(/…/g,"...").replace(/ /g," ").normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^\x20-\x7E]/g,"?");
}
export const money=n=>{const p=Math.round((+n||0)*100),v=Math.abs(p)/100;return (p<0?"-":"")+v.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})};
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
  const S=inv.seller, T=inv.totals;
  center(S.name,{bold:true,big:true});
  if(S.address) center(S.address);
  if(S.phone) center("Ph: "+S.phone);
  if(S.gstin) center("GSTIN: "+S.gstin);
  center(inv.title.toUpperCase(),{bold:true});
  if(inv.status==="cancelled") center("*** CANCELLED ***",{bold:true});
  L.push(rule);
  row("Bill: "+inv.number,new Date(inv.t).toLocaleString("en-IN",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}));
  if(inv.buyer){
    wrap("Customer: "+inv.buyer.name,w).forEach(t=>add(t));
    if(inv.buyer.phone) wrap("Ph: "+inv.buyer.phone,w).forEach(t=>add(t));
    if(inv.buyer.gstin) add("GSTIN: "+inv.buyer.gstin);
  }
  if(inv.placeOfSupply&&inv.gstMode!=="none") wrap("Place of supply: "+inv.placeOfSupply.name+" ("+inv.placeOfSupply.code+")",w).forEach(t=>add(t));
  L.push(rule);
  inv.lines.forEach(l=>{
    wrap(l.name+(l.variant?" ("+l.variant+")":""),w).forEach(t=>add(t,{bold:true}));
    row(`  ${l.qtyText||l.qty} x ${money(l.rate)}${l.unit?"/"+l.unit:""}`,money(l.gross));
    if(l.discount) row(`  Discount${l.discountLabel?" "+l.discountLabel:""}`,"-"+money(l.discount));
    if(l.hsn||l.gstRate) add(`  ${l.hsn?"HSN "+l.hsn:""}${l.hsn&&l.gstRate?" | ":""}${l.gstRate?"GST "+l.gstRate+"%":""}`);
  });
  L.push(rule);
  row("Subtotal",money(T.subtotal));
  if(T.itemDiscount) row("Item discounts","-"+money(T.itemDiscount));
  if(T.billDiscount) row("Bill discount"+(T.billDiscountLabel?" "+T.billDiscountLabel:""),"-"+money(T.billDiscount));
  const G=gstLines(inv);
  if(G.length){ row("Taxable amount",money(T.taxable)); G.forEach(g=>row(g.label+(inv.inclusive?" (incl.)":""),money(g.amount))); }
  if(T.roundOff) row("Round off",(T.roundOff>0?"+":"")+money(T.roundOff));
  row("TOTAL","Rs."+money(T.total),{bold:true,big:true});
  if(T.credit){ row("Exchange credit","-"+money(T.credit)); row("Amount due",money(T.due),{bold:true}); }
  L.push(rule);
  if(!inv.payments.length) add(T.credit?"Nothing to pay (covered by credit)":"Nothing to pay");
  inv.payments.forEach(p=>{
    row("Paid by "+p.label,money(p.amount));
    if(p.method==="cash"&&p.change) row("  Received "+money(p.received),"Change "+money(p.change));
    if(p.ref) columns("  Ref: "+p.ref,"",w).map(t=>t.trimEnd()).filter(Boolean).forEach(t=>add(t));
  });
  if(inv.returned) row("Returned items",money(inv.returned));
  if(inv.refunded) row("Refunded",money(inv.refunded));
  L.push(rule);
  if(inv.footer) center(inv.footer);
  return {cols:w,logo:inv.logo||"",lines:L};
}
