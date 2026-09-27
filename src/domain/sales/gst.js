// GST on a bill. Which tax applies: none (GST switched off), CGST + SGST (customer in the shop's state, or no
// customer GSTIN) or IGST (a customer GSTIN from another state). Then the tax on each line, after its discounts,
// for prices that include GST or prices with GST added on top. Pure and deterministic; amounts in paise.
import { round2 } from './paise.js';

export const GST_MODES={NONE:"none",INTRA:"intra",INTER:"inter"};

/* GST state codes (the first two digits of a GSTIN) */
const STATES={"01":"Jammu and Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh","05":"Uttarakhand","06":"Haryana","07":"Delhi",
  "08":"Rajasthan","09":"Uttar Pradesh","10":"Bihar","11":"Sikkim","12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur","15":"Mizoram",
  "16":"Tripura","17":"Meghalaya","18":"Assam","19":"West Bengal","20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh",
  "24":"Gujarat","26":"Dadra and Nagar Haveli and Daman and Diu","27":"Maharashtra","29":"Karnataka","30":"Goa","31":"Lakshadweep",
  "32":"Kerala","33":"Tamil Nadu","34":"Puducherry","35":"Andaman and Nicobar Islands","36":"Telangana","37":"Andhra Pradesh","38":"Ladakh"};
const key=s=>String(s||"").toLowerCase().replace(/&/g,"and").replace(/[^a-z]/g,"");
const BY_NAME=Object.fromEntries(Object.entries(STATES).map(([c,n])=>[key(n),c]));
Object.assign(BY_NAME,{jandk:"01",jammukashmir:"01",uttaranchal:"05",newdelhi:"07",nctofdelhi:"07",orissa:"21",damananddiu:"26",
  dadraandnagarhaveli:"26",pondicherry:"34",andamanandnicobar:"35",andaman:"35"});

export const stateName=code=>STATES[code]||"";
/* State code from a GSTIN ("27ABCDE1234F1Z5" → "27"), or "" when it isn't a GSTIN of a known state */
export function gstinState(gstin){
  const g=String(gstin||"").toUpperCase().replace(/\s/g,"");
  return /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(g)&&STATES[g.slice(0,2)]?g.slice(0,2):"";
}
/* State code from a state's name ("Maharashtra" → "27"), or "" */
export const stateCode=name=>BY_NAME[key(name)]||"";

/* Which GST applies to a sale.
   settings: { taxOn } · shop: { gstin, state } (the shop profile) · customer: { gstin, type } or null (walk-in).
   → { mode, shopState, pos (place of supply), b2b (a business customer with a GSTIN) } */
export function placeOfSupply({settings,shop,customer}){
  const custState=gstinState(customer&&customer.gstin);
  const b2b=!!(customer&&customer.type==="business"&&custState);
  if(!settings||!settings.taxOn) return {mode:GST_MODES.NONE,shopState:"",pos:"",b2b};
  const shopState=gstinState(shop&&shop.gstin)||stateCode(shop&&shop.state);
  const inter=!!(custState&&shopState&&custState!==shopState);
  return {mode:inter?GST_MODES.INTER:GST_MODES.INTRA,shopState,pos:custState||shopState,b2b};
}
/* The GST rate of a line: the product's own rate when it has one, else the shop's rate (settings.taxRate) */
export function lineRate(productRate,settings){
  const own=productRate===""||productRate==null?NaN:+productRate;
  return Number.isFinite(own)&&own>=0?own:Math.max(0,+(settings&&settings.taxRate)||0);
}
/* Tax on one line whose amount after discounts is amountPaise.
   inclusive: the amount already includes GST (taxable + tax = amount); otherwise GST is added on top.
   CGST and SGST are each half the rate, worked out once and doubled, so they are always equal. */
export function lineTax(amountPaise,rate,{mode,inclusive}){
  const r=Math.max(0,+rate||0), none={taxable:amountPaise,cgst:0,sgst:0,igst:0,tax:0,total:amountPaise,rate:mode===GST_MODES.NONE?0:r};
  if(mode===GST_MODES.NONE||!r||amountPaise<=0) return none;
  if(mode===GST_MODES.INTER){
    const igst=Math.round(inclusive?amountPaise*r/(100+r):amountPaise*r/100);
    return inclusive?{taxable:amountPaise-igst,cgst:0,sgst:0,igst,tax:igst,total:amountPaise,rate:r}
      :{taxable:amountPaise,cgst:0,sgst:0,igst,tax:igst,total:amountPaise+igst,rate:r};
  }
  const half=Math.round(inclusive?amountPaise*r/(2*(100+r)):amountPaise*r/200);
  return inclusive?{taxable:amountPaise-2*half,cgst:half,sgst:half,igst:0,tax:2*half,total:amountPaise,rate:r}
    :{taxable:amountPaise,cgst:half,sgst:half,igst:0,tax:2*half,total:amountPaise+2*half,rate:r};
}
/* A saved bill's GST split (rupees): { mode, cgst, sgst, igst }. Bills saved before the split kept only their GST
   amount: it counts as CGST + SGST halves (the database upgrade in schema.sql 3e does the same). */
export function saleGstSplit(sale){
  const tax=sale.tax||0;
  if(sale.cgst!=null||sale.igst!=null) return {mode:sale.gst&&sale.gst.mode||(sale.igst?GST_MODES.INTER:tax?GST_MODES.INTRA:GST_MODES.NONE),cgst:sale.cgst||0,sgst:sale.sgst||0,igst:sale.igst||0};
  const cgst=round2(tax/2);
  return tax?{mode:GST_MODES.INTRA,cgst,sgst:round2(tax-cgst),igst:0}:{mode:GST_MODES.NONE,cgst:0,sgst:0,igst:0};
}
/* Lines' tax added up by rate, lowest rate first: [{ rate, taxable, cgst, sgst, igst, tax }] (paise) */
export function taxBreakdown(lines){
  const by={};
  lines.forEach(l=>{ if(!l.rate&&!l.tax) return; const o=by[l.rate]||(by[l.rate]={rate:l.rate,taxable:0,cgst:0,sgst:0,igst:0,tax:0});
    o.taxable+=l.taxable;o.cgst+=l.cgst;o.sgst+=l.sgst;o.igst+=l.igst;o.tax+=l.tax; });
  return Object.values(by).sort((a,b)=>a.rate-b.rate);
}
