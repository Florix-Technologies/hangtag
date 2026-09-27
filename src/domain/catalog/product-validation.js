// Product rules checked before a product is saved (the database repeats the ones that must always hold).
import { checkOptions, vLabel } from './options.js';
import { codeError } from './barcode.js';

/* Product names: trimmed, single spaces */
export const cleanProductName=s=>String(s||"").trim().replace(/\s+/g," ");
/* HSN: 4, 6 or 8 digits (or none) */
export const validHsn=h=>!h||/^\d{4}(\d{2}){0,2}$/.test(h);
/* Every SKU/barcode already used by OTHER products: { "s:<sku lowercase>" | "b:<barcode>": "Product Black / M" } */
export function takenCodes(products,exceptId,variantsOf){
  const taken={};
  products.forEach(p=>{if(p.id===exceptId)return;variantsOf(p,true).forEach(v=>{const lab=(p.name+" "+vLabel(v)).trim();if(v.sku)taken["s:"+v.sku.trim().toLowerCase()]=lab;if(v.bc)taken["b:"+v.bc.trim()]=lab})});
  return taken;
}
/* draft: { name, price, cost, hsn, gst, hasOpts, opts } (form strings); combos: [{ o, cell:{ sku, bc, stock, price, cost } }] (the
   current combinations); kept: [{ o, cell }] saved variants that are no longer combinations but stay for their history (their
   codes still count); taken: from takenCodes(). Returns { error } for the first problem, or { name, price, cost, hsn, gst }. */
export function validateProductDraft(draft,combos,kept,taken){
  const e=draft;
  const name=cleanProductName(e.name);
  if(!name)return {error:"Enter a product name."};
  const price=Math.round(+e.price);if(e.price===""||isNaN(price)||price<0)return {error:"Enter a selling price (₹0 or more)."};
  const cost=e.cost===""||e.cost==null?null:Math.round(+e.cost);if(cost!=null&&(isNaN(cost)||cost<0))return {error:"Cost price can't be negative."};
  const hsn=String(e.hsn||"").replace(/\s/g,"");if(!validHsn(hsn))return {error:"HSN code should be 4, 6 or 8 digits."};
  const g=String(e.gst==null?"":e.gst).trim(),gst=g===""?null:+g;if(gst!=null&&(isNaN(gst)||gst<0||gst>100))return {error:"GST % should be between 0 and 100."};
  if(e.hasOpts){
    if(!e.opts.length)return {error:"Add an option (for example Size), or untick “multiple options”."};
    const bad=checkOptions(e.opts);if(bad)return bad;
  }
  // SKU and barcode unique within the shop and within this product
  const mine={};
  const claim=(x,lab)=>{
    const sku=String(x.cell.sku||"").trim(),bc=String(x.cell.bc||"").trim();
    for(const [key,val,what] of [["s:"+sku.toLowerCase(),sku,"SKU"],["b:"+bc,bc,"Barcode"]]){
      if(!val)continue;
      if(taken[key])return `${what} ${val} is already used by ${taken[key]}.`;
      if(mine[key])return `${what} ${val} is used twice in this product (${mine[key]} and ${lab}).`;
      mine[key]=lab;
    }
    return null;
  };
  for(const x of kept){const m=claim(x,(x.o||[]).join(" / ")||"one size");if(m)return {error:m}}
  for(const x of combos){
    const lab=(x.o||[]).join(" / ")||name;
    const m=claim(x,lab);if(m)return {error:m};
    const ce=codeError(x.cell.bc);if(ce)return {error:`${lab}: ${ce}`};
    const st=x.cell.stock===""||x.cell.stock==null?0:Math.round(+x.cell.stock);if(isNaN(st)||st<0)return {error:`Stock for ${lab} can't be negative.`};
    for(const f of ["price","cost"]){const v=x.cell[f];if(v!==""&&v!=null&&(isNaN(+v)||+v<0))return {error:`${f==="price"?"Price":"Cost"} for ${lab} can't be negative.`}}
  }
  return {name,price,cost,hsn,gst};
}
