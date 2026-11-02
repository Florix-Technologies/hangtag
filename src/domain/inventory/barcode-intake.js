// Factory barcode intake: a code scanned (camera or a USB / Bluetooth scanner) or typed while stock comes in. A code that is
// already on a variant finds it (exact barcode first, then SKU); a code nobody has yet makes a new product with just what
// the counter needs (name, unit, price, cost, GST, HSN), the code as its barcode, then the stock goes in. A code is never on
// two variants: an archived product or a variant off sale that has it is named instead. Pure.
import { codeError, cleanCode } from '../catalog/barcode.js';
import { gtinKey, parseGs1 } from '../catalog/gs1.js';
import { cleanProductName, validHsn } from '../catalog/product-validation.js';
import { vLabel } from '../catalog/options.js';
import { inr, stripMoney } from '../../shared/formatting/money.js';

/* products: the whole catalog (archived too) · variantsOf(p, all) → { hit: { p, v } } (live, on sale) | { off: { p, v } }
   (archived product or variant off sale) | { unknown: code } | { error } */
/* A GS1 code (DataMatrix, GS1-128, Digital Link) is found by its GTIN, and also the same item's EAN-13 / UPC-A / GTIN-14;
   then the answer carries what it says (gs1: batch, expiry, serial …) for the stock-in to fill in. A new GS1 code makes a
   product with its GTIN as the barcode (the 13-digit EAN-13 when it starts with 0). */
export function lookupCode(raw,products,variantsOf){
  const g=parseGs1(raw);
  const code=g?(g.gtin[0]==="0"?g.gtin.slice(1):g.gtin):cleanCode(raw);
  if(!code) return {error:"Scan or type a code."};
  const all=[];(products||[]).forEach(p=>variantsOf(p,true).forEach(v=>all.push({p,v})));
  const lc=code.toLowerCase(), key=g?g.gtin:gtinKey(code);
  const find=list=>list.find(h=>h.v.bc&&h.v.bc.trim()===code)||list.find(h=>h.v.bc&&h.v.bc.trim().toLowerCase()===lc)||list.find(h=>h.v.sku&&h.v.sku.trim().toLowerCase()===lc)
    ||(key?list.find(h=>h.v.bc&&gtinKey(h.v.bc.trim())===key):null)||null;
  const extra=g?{gs1:g}:{};
  const live=find(all.filter(h=>!h.p.archived&&h.v.active!==false));
  if(live) return {hit:live,...extra};
  const off=find(all);
  if(off) return {off,...extra};
  const bad=g?null:codeError(raw);
  if(bad) return {error:bad};
  return {unknown:code,...extra};
}
/* Why a code found off sale can't take stock, in words */
export const offSaleText=({p,v})=>`${cleanCode(v.bc||v.sku)} is on ${[p.name,vLabel(v)].filter(Boolean).join(" · ")}, which is ${p.archived?"archived":"off sale"}. ${p.archived?"Unarchive it":"Switch that variant on"} in Products first.`;

const money=(v,label,required)=>{
  const s=stripMoney(String(v==null?"":v).trim());
  if(s==="") return required?{error:`Enter the ${label} (${inr(0)} or more).`}:{value:null};
  const n=Number(s);
  if(!Number.isFinite(n)||n<0) return {error:`The ${label} should be ${inr(0)} or more.`};
  if(!Number.isInteger(n)) return {error:`The ${label} is in whole rupees.`};
  if(n>10000000) return {error:`That ${label} is too large.`};
  return {value:n};
};
/* input: { code, name, unit, price, cost, gst, hsn, cat } · ctx: { taken (takenCodes of the catalog), id, vid, color, units
   ([[code, label, decimals]…]) } → { error, field } or { product } (one variant, no options, the code as its barcode) */
export function quickProduct(input,ctx){
  const x=input||{}, code=cleanCode(x.code);
  if(!code) return {error:"The product needs its code.",field:"code"};
  const ce=codeError(x.code); if(ce) return {error:ce,field:"code"};
  if(ctx.taken&&ctx.taken["b:"+code]) return {error:`Barcode ${code} is already used by ${ctx.taken["b:"+code]}.`,field:"code"};
  if(ctx.taken&&ctx.taken["s:"+code.toLowerCase()]) return {error:`${code} is already the SKU of ${ctx.taken["s:"+code.toLowerCase()]}.`,field:"code"};
  const name=cleanProductName(x.name);
  if(!name) return {error:"Enter the product's name.",field:"name"};
  if(name.length>80) return {error:"A product name can be at most 80 characters.",field:"name"};
  const price=money(x.price,"selling price",true); if(price.error) return {...price,field:"price"};
  const cost=money(x.cost,"cost price",false); if(cost.error) return {...cost,field:"cost"};
  const g=String(x.gst==null?"":x.gst).trim().replace("%",""), gst=g===""?null:Number(g);
  if(gst!=null&&(!Number.isFinite(gst)||gst<0||gst>100)) return {error:"GST % should be between 0 and 100.",field:"gst"};
  const hsn=String(x.hsn||"").replace(/\s/g,"");
  if(!validHsn(hsn)) return {error:"HSN code should be 4, 6 or 8 digits.",field:"hsn"};
  const units=ctx.units||[["pcs","Piece",0]], unit=String(x.unit||"pcs");
  if(!units.some(u=>u[0]===unit)) return {error:"Choose the unit.",field:"unit"};
  const product={id:ctx.id,name,cat:String(x.cat||"").trim().slice(0,40),brand:"",desc:"",price:price.value,cost:cost.value,color:ctx.color||"#8E8A83",archived:false,
    hsn,gst,code:"barcode",opts:[],variants:[{id:ctx.vid,o:[],sku:"",bc:code,price:null,cost:null,active:true}]};
  if(unit!=="pcs") product.unit=unit;
  return {product};
}
