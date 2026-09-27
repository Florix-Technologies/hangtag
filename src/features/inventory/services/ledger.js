// Read model over bills, returns and stock moves (derived once per change).
import { store } from '../../../shared/state/store.js';
import { invoiceNo } from '../../sales/services/totals.js';
import { products } from '../../products/services/catalog.js';
import { dayKey } from '../../../shared/formatting/dates.js';

export const invalidate=()=>{store._d=null};
export function D(){
  if(store._d)return store._d;
  const docs=Object.values(Object.assign({},store.remoteDays,store.localDays));
  const voids=new Set();docs.forEach(d=>(d.voids||[]).forEach(v=>voids.add(v)));
  const seen=new Set(),sales=[];
  docs.forEach(d=>(d.sales||[]).forEach(s=>{
    if(s&&Array.isArray(s.items)&&!seen.has(s.id)){
      seen.add(s.id);
      sales.push(Object.assign({},s,{void:voids.has(s.id)}));
    }
  }));
  sales.sort((a,b)=>a.t-b.t);
  // invoice numbers for bills saved before numbering existed (display only)
  const perDay={};
  sales.forEach(s=>{const k=dayKey(s.t);perDay[k]=(perDay[k]||0)+1;if(!s.no)s.no=invoiceNo(s.t,perDay[k])});
  const vIdx={};
  products().forEach(p=>(p.variants||[]).forEach(v=>{vIdx[v.id]={v,p}}));
  const resolve=i=>{if(i.v&&vIdx[i.v])return i.v;const k=i.p+":"+(i.s==null?"":i.s);return vIdx[k]?k:(i.v||null)};
  const sold={},saleById={};
  sales.forEach(s=>{saleById[s.id]=s;if(s.void)return;s.items.forEach(i=>{const vid=resolve(i);if(vid)sold[vid]=(sold[vid]||0)+i.q})});
  const rets=Object.values(store.returnsMap).filter(r=>r&&Array.isArray(r.items)).sort((a,b)=>a.t-b.t);
  const returned={},retLine={},retBySale={};
  rets.forEach(r=>{
    (retBySale[r.sale]=retBySale[r.sale]||[]).push(r);
    r.items.forEach(it=>{const vid=resolve(it);if(vid)returned[vid]=(returned[vid]||0)+it.q;const k=r.sale+"|"+it.ln;retLine[k]=(retLine[k]||0)+it.q});
  });
  const moved={};
  Object.values(store.moves).forEach(m=>{if(m&&m.v)moved[m.v]=(moved[m.v]||0)+(Math.round(+m.q)||0)});
  store._d={sales,saleById,vIdx,resolve,sold,returned,retLine,retBySale,rets,moved};
  return store._d;
}
/* The variant record { v, p } for a variant id, and whether it was ever sold or returned */
export const vRec=vid=>D().vIdx[vid];
export const hasHistory=vid=>{const d=D();return !!(d.sold[vid]||d.returned[vid]||d.sales.some(s=>s.items.some(i=>d.resolve(i)===vid)))};
/* Whether a variant has any stock record (opening, stock in, adjustment) */
export const hasMoves=vid=>Object.values(store.moves).some(m=>m.v===vid);
