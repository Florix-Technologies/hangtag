// Discounts: on one bill line or on the whole bill, as a percentage or a fixed amount in rupees.
// A discount never takes off more than the amount it applies to. Only discounts here — GST is worked out afterwards
// (domain/sales/gst.js), on what is left. Pure; amounts in paise unless a name says rupees.
import { round2, sumP, toPaise, tooPrecise } from './paise.js';
import { inrx } from '../../shared/formatting/money.js';

export const DISCOUNT_TYPES=["percent","fixed"];

/* Anything saved or typed → { type, value } or null (no discount).
   A plain number is a fixed amount in rupees (bills saved before percentages existed). */
export function normalizeDiscount(d){
  if(d==null||d==="") return null;
  if(typeof d!=="object"){ const v=+d; return Number.isFinite(v)&&v>0?{type:"fixed",value:round2(v)}:null; }
  const v=+d.value;
  if(!Number.isFinite(v)||v<=0) return null;
  return d.type==="percent"?{type:"percent",value:Math.min(100,round2(v))}:{type:"fixed",value:round2(v)};
}
/* A saved bill discount → the discount box { type, value } (older versions saved ₹ off as a plain number), or null */
export function discountInput(saved){
  if(saved==null||saved==="") return null;
  if(typeof saved!=="object") return +saved>0?{type:"fixed",value:+saved}:null;
  return {type:saved.type==="percent"?"percent":"fixed",value:saved.value==null?"":saved.value};
}
/* What a discount takes off an amount (paise): a percentage of it, or the fixed amount — never more than the amount */
export function discountPaise(spec,basePaise){
  const d=normalizeDiscount(spec);
  if(!d||basePaise<=0) return 0;
  const off=d.type==="percent"?Math.round(basePaise*d.value/100):toPaise(d.value);
  return Math.min(off,basePaise);
}
/* A typed discount { type, value } checked against the amount it applies to (paise).
   null when it's fine (or empty = no discount), otherwise { error }. */
export function checkDiscount(input,basePaise){
  if(!input||input.value==null||String(input.value).trim()==="") return null;
  const v=+input.value;
  if(!Number.isFinite(v)) return {error:"Enter a number for the discount."};
  if(v<0) return {error:"A discount can't be negative."};
  if(tooPrecise(v)) return {error:"Use at most 2 decimal places."};
  if(input.type==="percent"){ if(v>100) return {error:"A discount can't be more than 100%."}; }
  else if(toPaise(v)>basePaise) return {error:`A discount can't be more than ${inrx(basePaise/100)}.`};
  return null;
}
/* Every discount on a bill: each line's against the line (q × price), the bill's against what the line discounts leave.
   lines: [{ name?, q, price, disc? }] → null, or { error, line } (line = index, or null for the bill discount) */
export function checkBillDiscounts(lines,billDisc){
  let after=0;
  for(const [i,l] of (lines||[]).entries()){
    const gross=toPaise(l.q*l.price), e=checkDiscount(l.disc,gross);
    if(e) return {error:(l.name?`${l.name}: `:"")+e.error,line:i};
    after+=gross-discountPaise(l.disc,gross);
  }
  const e=checkDiscount(billDisc,after);
  return e?{error:"Bill discount: "+e.error,line:null}:null;
}
/* Shares an amount (paise) over lines in proportion to their weights, exactly: the parts always add up to the amount
   (largest remainder; ties go to the earlier line). Used for the bill discount, so each line knows its share. */
export function allocate(totalPaise,weights){
  const w=weights.map(x=>Math.max(0,x)), sum=sumP(w);
  if(!sum||totalPaise<=0) return w.map(()=>0);
  const raw=w.map(x=>x*totalPaise/sum), out=raw.map(Math.floor);
  let left=totalPaise-sumP(out);
  const order=raw.map((r,i)=>[r-out[i],i]).sort((a,b)=>b[0]-a[0]||a[1]-b[1]);
  for(let k=0;left>0;k++,left--) out[order[k%order.length][1]]++;
  return out;
}
/* "10%" or "₹50" */
export function discountLabel(spec){
  const d=normalizeDiscount(spec);
  return !d?"":d.type==="percent"?`${d.value}%`:inrx(d.value);
}
