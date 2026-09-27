// What a receipt shows, as data and as text.
import { lineLabel } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { PAY_LABELS, payLabel, paymentsOf } from '../../../domain/sales/payments.js';
import { saleGstSplit } from '../../../domain/sales/gst.js';
import { D } from '../../inventory/services/ledger.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

/* ================= receipts: print (80 mm or A4), image download, share, WhatsApp ================= */

export function shopInfo(){
  const p=store.profile||{};
  return {name:p.shop_name||"My shop",address:[p.address,p.city,p.state].filter(Boolean).join(", "),phone:p.phone||"",gstin:p.gstin||""};
}
export function saleReturns(sid){ return (D().retBySale[sid]||[]); }
/* Everything a receipt shows, from the bill's own saved copy (never today's prices or rates).
   Bills saved before the GST split show their GST as CGST + SGST halves (domain/sales/gst.js saleGstSplit). */
export function receiptModel(s){
  const shop=shopInfo(), lines=s.items.map(i=>({name:i.n,var:lineLabel(i),sku:i.sku||"",q:i.q,price:i.price,amt:i.q*i.price,disc:i.dAmt||0}));
  const rets=saleReturns(s.id), tax=s.tax||0, G=saleGstSplit(s);
  const pays=paymentsOf(s).map(p=>({label:PAY_LABELS[p.method]||p.method,method:p.method,amount:p.amount,ref:p.ref||"",received:p.received,change:p.change||0}));
  return {shop,no:s.no,t:s.t,cust:s.cust,lines,sub:s.sub,disc:s.disc||0,tax,rate:s.taxRate||0,incl:s.taxIncl!==false,mode:G.mode,
    cgst:G.cgst,sgst:G.sgst,igst:G.igst,roundOff:s.roundOff||0,total:s.total,
    credit:s.credit||0,paid:s.total-(s.credit||0),pay:payLabel(s),pays,change:pays.reduce((a,p)=>a+p.change,0),kind:s.kind||"sale",void:!!s.void,
    returned:rets.reduce((a,r)=>a+r.value,0),refunded:rets.reduce((a,r)=>a+(r.refund||0),0),footer:store.settings.footer||""};
}
/* GST lines: CGST + SGST, or IGST (with the rate when the whole bill has one) → [{ label, amount }] */
export function gstLines(R){
  if(!R.tax) return [];
  const r=f=>R.rate?" "+Math.round(R.rate*f*100)/100+"%":"";
  return R.mode==="inter"?[{label:"IGST"+r(1),amount:R.igst}]:[{label:"CGST"+r(.5),amount:R.cgst},{label:"SGST"+r(.5),amount:R.sgst}];
}
/* How it was paid → [{ label, amount, note }] ("Cash", "₹400", "received ₹500 · change ₹100") */
export function payLines(R){
  return R.pays.map(p=>({label:p.label,amount:p.amount,note:p.method==="cash"&&p.change?`received ${inrx(p.received)} · change ${inrx(p.change)}`:p.ref?"ref "+p.ref:""}));
}
/* Plain-text bill for WhatsApp / sharing */

export function receiptText(s){
  const R=receiptModel(s), L=[];
  L.push(`*${R.shop.name}*`); if(R.shop.address) L.push(R.shop.address); if(R.shop.gstin) L.push("GSTIN "+R.shop.gstin);
  L.push("", `Bill ${R.no} · ${dtLong(R.t)}`); if(R.cust) L.push("Customer: "+R.cust.name+(R.cust.gstin?" · GSTIN "+R.cust.gstin:""));
  L.push("");
  R.lines.forEach(l=>L.push(`${l.name}${l.var?" ("+l.var+")":""} × ${l.q} = ${inr(l.amt)}${l.disc?` (−${inrx(l.disc)})`:""}`));
  L.push("");
  if(R.disc) L.push("Discount: −"+inrx(R.disc));
  if(!R.incl) gstLines(R).forEach(g=>L.push(`${g.label}: ${inrx(g.amount)}`));
  if(R.roundOff) L.push("Round off: "+(R.roundOff>0?"+":"")+inrx(R.roundOff));
  L.push(`*Total: ${inr(R.total)}*`+(R.incl&&R.tax?` (incl. ${gstLines(R).map(g=>g.label+" "+inrx(g.amount)).join(", ")})`:""));
  if(R.credit) L.push(`Exchange credit: −${inr(R.credit)}`, `Paid: ${inr(R.paid)} (${R.pay})`);
  else if(R.pays.length>1) L.push("Paid: "+payLines(R).map(p=>`${p.label} ${inrx(p.amount)}`).join(" + "));
  else L.push("Paid by "+R.pay);
  if(R.change) L.push("Change: "+inrx(R.change));
  if(R.footer) L.push("", R.footer);
  return L.join("\n");
}
