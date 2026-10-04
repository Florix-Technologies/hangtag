// Bill totals and invoice numbers with this shop's settings: GST on or off, prices with or without GST, each product's
// own GST rate, and CGST + SGST or IGST from the shop's and the customer's GSTIN. The maths is in the domain
// (domain/sales/checkout-totals.js); this only gathers what it needs.
import { store } from '../../../shared/state/store.js';
import { computeCheckout } from '../../../domain/sales/checkout-totals.js';
import { lineRate, placeOfSupply } from '../../../domain/sales/gst.js';
import { prod } from '../../products/services/catalog.js';
import { explodeKits } from '../../../domain/catalog/bundles.js';
import { linePaise, toRupees } from '../../../domain/sales/paise.js';

/* The bill's customer with their saved GSTIN and type (the bill itself keeps id, name and mobile) */
export function billCustomer(cust){
  if(!cust||!cust.name) return null;
  const c=cust.id&&store.customers[cust.id];
  return c?{...cust,gstin:c.gstin||"",type:c.type||"individual"}:{...cust,gstin:cust.gstin||"",type:cust.type||"individual"};
}
/* Which GST applies to a bill for this customer (null = walk-in): { mode, shopState, pos, b2b } */
export const gstContext=cust=>placeOfSupply({settings:store.settings,shop:store.profile||{},customer:billCustomer(cust)});
/* A bill line's GST rate: the product's own rate, else the shop's */
export const rateOf=c=>c&&c.gst!=null&&c.gst!==""&&Number.isFinite(+c.gst)?+c.gst:lineRate((prod(c.p)||{}).gst,store.settings);
/* Totals for bill lines ({ q, price, p, disc? }) with a bill discount, for a customer (default: the bill's customer).
   A kit line (c.kit) is worked out as its items (domain/catalog/bundles.js explodeKits, at the kit's GST rate), exactly as
   the saved bill will have it; its figures come back as one line, so the bill shows the kit as one item. */
export function billTotals(lines,billDisc,cust){
  const g=gstContext(cust===undefined?store.cartCust:cust), gst={mode:g.mode,inclusive:!!store.settings.taxIncl};
  const calc=ls=>computeCheckout({lines:ls.map(c=>({q:c.q,price:c.price,disc:c.disc,rate:rateOf(c)})),billDisc,gst});
  if(!lines.some(c=>Array.isArray(c.kit)&&c.kit.length)) return calc(lines);
  const X=explodeKits(lines,rateOf); if(X.error) return calc(lines);
  const T=calc(X.lines), owner=[]; lines.forEach((c,i)=>{ const n=Array.isArray(c.kit)&&c.kit.length?c.kit.length:1; for(let k=0;k<n;k++) owner.push(i); });
  const P=v=>Math.round(v*100), out=lines.map(()=>null);
  X.lines.forEach((f,k)=>{ const i=owner[k], L=T.lines[k], o=out[i];
    out[i]=o?Object.fromEntries(Object.keys(L).map(key=>[key,key==="rate"?L.rate:toRupees(P(o[key])+P(L[key]))])):{...L}; });
  // a kit line shows the kit's own price and only the discount given on it (what it saves on its items is in its price)
  lines.forEach((c,i)=>{ if(!(Array.isArray(c.kit)&&c.kit.length)) return; const o=out[i], gross=linePaise(c.q,c.price), net=P(o.gross)-P(o.itemDisc);
    out[i]={...o,gross:toRupees(gross),itemDisc:toRupees(gross-net)}; });
  const sum=k=>toRupees(out.reduce((a,o)=>a+P(o[k]),0)), sub=sum("gross"), itemDisc=sum("itemDisc");
  return {...T,lines:out,sub,itemDisc,disc:toRupees(P(itemDisc)+P(T.billDisc))};
}
