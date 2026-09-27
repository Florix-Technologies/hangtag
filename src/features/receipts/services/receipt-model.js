// What a receipt shows, as data and as text.
import { lineLabel } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { PAYN } from '../../../domain/sales/sale.js';
import { D } from '../../inventory/services/ledger.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';

/* ================= receipts: print (80 mm or A4), image download, share, WhatsApp ================= */

export function shopInfo(){
  const p=store.profile||{};
  return {name:p.shop_name||"My shop",address:[p.address,p.city,p.state].filter(Boolean).join(", "),phone:p.phone||"",gstin:p.gstin||""};
}
export function saleReturns(sid){ return (D().retBySale[sid]||[]); }
/* Everything a receipt shows, from the bill's own saved copy (never today's prices) */

export function receiptModel(s){
  const shop=shopInfo(), lines=s.items.map(i=>({name:i.n,var:lineLabel(i),sku:i.sku||"",q:i.q,price:i.price,amt:i.q*i.price}));
  const rets=saleReturns(s.id);
  return {shop,no:s.no,t:s.t,cust:s.cust,lines,sub:s.sub,disc:s.disc||0,tax:s.tax||0,rate:s.taxRate||0,incl:s.taxIncl!==false,total:s.total,
    credit:s.credit||0,paid:s.total-(s.credit||0),pay:PAYN[s.pay]||s.pay,kind:s.kind||"sale",void:!!s.void,
    returned:rets.reduce((a,r)=>a+r.value,0),refunded:rets.reduce((a,r)=>a+(r.refund||0),0),footer:store.settings.footer||""};
}
/* Plain-text bill for WhatsApp / sharing */

export function receiptText(s){
  const R=receiptModel(s), L=[];
  L.push(`*${R.shop.name}*`); if(R.shop.address) L.push(R.shop.address); if(R.shop.gstin) L.push("GSTIN "+R.shop.gstin);
  L.push("", `Bill ${R.no} · ${dtLong(R.t)}`); if(R.cust) L.push("Customer: "+R.cust.name);
  L.push("");
  R.lines.forEach(l=>L.push(`${l.name}${l.var?" ("+l.var+")":""} × ${l.q} = ${inr(l.amt)}`));
  L.push("");
  if(R.disc) L.push("Discount: −"+inr(R.disc));
  if(R.rate&&!R.incl) L.push(`GST ${R.rate}%: ${inr(R.tax)}`);
  L.push(`*Total: ${inr(R.total)}*`+(R.rate&&R.incl?` (incl. GST ${inr(R.tax)})`:""));
  if(R.credit) L.push(`Exchange credit: −${inr(R.credit)}`, `Paid: ${inr(R.paid)} (${R.pay})`); else L.push("Paid by "+R.pay);
  if(R.footer) L.push("", R.footer);
  return L.join("\n");
}
