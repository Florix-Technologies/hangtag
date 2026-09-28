// What a return is worth, from the original bill's saved figures only: each returned piece gets back what was paid for
// it (its line's total after the line discount and its share of the bill discount, with its GST), at the bill's own
// rates and place of supply. Nothing is recalculated from today's prices or settings.
//   · A line returned in parts: each part is its share of the line; the part that finishes the line gets what is left,
//     so the parts always add up to the line exactly (to the paisa).
//   · The bill's round off is given back only by the return that finishes the whole bill, so a bill returned
//     completely refunds exactly its total.
//   · Bills saved before line GST was kept: a line's share of the bill total, and of the bill's GST (split like the bill).
// Pure; rupees in and out, worked in paise.
import { saleGstSplit } from '../sales/gst.js';
import { sumP, toPaise, toRupees } from '../sales/paise.js';

export const lineNo=(i,k)=>i.ln!=null?i.ln:k;
const TAX=["cgst","sgst","igst"];

/* A bill line's saved figures in paise: { lt (what was paid), tx (taxable), cgst, sgst, igst, rate } */
export function savedLine(sale,i){
  if(i.lt!=null) return {lt:toPaise(i.lt),cgst:toPaise(i.cgst),sgst:toPaise(i.sgst),igst:toPaise(i.igst),rate:+i.gst||0,tx:toPaise(i.tx!=null?i.tx:i.lt-(i.cgst||0)-(i.sgst||0)-(i.igst||0))};
  const ratio=sale.sub>0?sale.total/sale.sub:1, lt=toPaise(i.q*i.price*ratio), total=toPaise(sale.total);
  const tax=total>0?Math.round(lt*toPaise(sale.tax)/total):0, g=saleGstSplit(sale), inter=g.mode==="inter";
  const cgst=inter?0:Math.round(tax/2);
  return {lt,tx:lt-tax,cgst,sgst:inter?0:tax-cgst,igst:inter?tax:0,rate:+sale.taxRate||0};
}
/* What earlier returns of this bill took back, per line: { [ln]: { q, lt, cgst, sgst, igst } } (paise).
   Returns saved before their GST was kept count their GST as a share of the line's by pieces. */
export function returnedSoFar(sale,prior){
  const out={}, line={};
  sale.items.forEach((i,k)=>{line[lineNo(i,k)]=i});
  (prior||[]).forEach(r=>(r.items||[]).forEach(it=>{
    const o=out[it.ln]||(out[it.ln]={q:0,lt:0,cgst:0,sgst:0,igst:0}), sl=line[it.ln];
    o.q+=it.q; o.lt+=toPaise(it.value);
    if(it.tx!=null) TAX.forEach(x=>{o[x]+=toPaise(it[x])});
    else if(sl&&sl.q){ const f=savedLine(sale,sl); TAX.forEach(x=>{o[x]+=Math.round(f[x]*it.q/sl.q)}); }
  }));
  return out;
}
/* sale: the saved bill · picks: { [line no]: pieces coming back } · prior: this bill's earlier returns
   → { lines: [{ ln, q, unit, value, tx, cgst, sgst, igst, rate, hsn }], items, roundOff, value, taxable, tax, cgst, sgst, igst, whole }
   (rupees), or { error } when more is picked than is left on a line. */
export function quoteReturn(sale,picks,prior){
  const done=returnedSoFar(sale,prior), lines=[];
  let whole=true;
  for(const [k,i] of sale.items.entries()){
    const ln=lineNo(i,k), d=done[ln]||{q:0,lt:0,cgst:0,sgst:0,igst:0}, left=Math.max(0,i.q-d.q), q=Math.max(0,Math.round(+(picks||{})[ln]||0));
    if(q>left) return {error:`Only ${left} of ${i.n} can still be returned.`,line:ln};
    if(d.q+q<i.q) whole=false;
    if(!q) continue;
    const f=savedLine(sale,i), last=d.q+q>=i.q, part=x=>last?Math.max(0,f[x]-d[x]):Math.round(f[x]*q/i.q);
    const lt=part("lt"), tax={cgst:part("cgst"),sgst:part("sgst"),igst:part("igst")};
    const tx=lt-tax.cgst-tax.sgst-tax.igst;
    lines.push({ln,q,unit:toRupees(Math.round(lt/q)),value:toRupees(lt),tx:toRupees(tx),cgst:toRupees(tax.cgst),sgst:toRupees(tax.sgst),igst:toRupees(tax.igst),rate:f.rate,hsn:i.hsn||""});
  }
  const P=k=>sumP(lines.map(l=>toPaise(l[k]))), items=P("value"), ro=whole&&lines.length?toPaise(sale.roundOff||0):0;
  return {lines,items:toRupees(items),roundOff:toRupees(ro),value:toRupees(items+ro),taxable:toRupees(P("tx")),
    cgst:toRupees(P("cgst")),sgst:toRupees(P("sgst")),igst:toRupees(P("igst")),tax:toRupees(P("cgst")+P("sgst")+P("igst")),whole};
}
/* An exchange: what comes back is credit against the new bill (whose total is a whole rupee). The difference is settled in
   whole rupees too, like a bill: the paise left over (from discount shares, less than 50 either way) go to the credit note's
   round off, never to its taxable value or GST. → { credit, refund, collect, roundOff, value (the credit note's value) } (rupees) */
export function exchangeSettlement(returnValue,newTotal){
  const n=toPaise(newTotal), d=n-toPaise(returnValue), adj=d-Math.round(d/100)*100, v=toPaise(returnValue)+adj;
  return {credit:toRupees(Math.min(v,n)),refund:toRupees(Math.max(0,v-n)),collect:toRupees(Math.max(0,n-v)),roundOff:toRupees(adj),value:toRupees(v)};
}
/* Pieces of a bill line still returnable, given its earlier returns */
export const returnableQty=(sale,i,k,prior)=>{const d=returnedSoFar(sale,prior)[lineNo(i,k)];return Math.max(0,i.q-(d?d.q:0))};
/* A returned piece goes back on the shelf unless it was marked "not for resale" */
export const restocks=item=>item.restock!==false;
