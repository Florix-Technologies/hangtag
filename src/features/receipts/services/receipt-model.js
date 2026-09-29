// The invoice of a bill (domain/invoices/invoice.js) with this shop's details, and the bill as plain text.
// Every bill output — receipt, A4 invoice, picture, print, thermal print, messages — starts here, from the bill's saved
// figures; nothing is recalculated.
import { buildInvoice, gstLines } from '../../../domain/invoices/invoice.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

export function saleReturns(sid){ return (D().retBySale[sid]||[]); }
/* The invoice for a saved bill: shop profile, the customer's saved email / GSTIN, returns, footer and logo */
export function invoiceFor(s){
  const cust=s.cust&&s.cust.id?store.customers[s.cust.id]:null;
  return buildInvoice(s,{profile:store.profile||{},customer:cust,returns:saleReturns(s.id),footer:store.settings.footer||"",logo:store.logo||""});
}
/* How it was paid → [{ label, amount, note }] ("Cash", ₹400, "received ₹500 · change ₹100") */
export function payLines(inv){
  return inv.payments.map(p=>({label:p.label,amount:p.amount,note:[p.method==="cash"&&p.change?`received ${inrx(p.received)} · change ${inrx(p.change)}`:p.ref?"ref "+p.ref:"",
    p.last4?"card ••"+p.last4:"",p.verification==="verified"?"verified":p.verification==="unverified"?"unverified":""].filter(Boolean).join(" · ")}));
}
/* Plain-text bill for WhatsApp / sharing / SMS-length summaries */
export function receiptText(s){
  const I=invoiceFor(s), T=I.totals, G=gstLines(I), L=[];
  L.push(`*${I.seller.name}*`); if(I.seller.address) L.push(I.seller.address); if(I.seller.gstin) L.push("GSTIN "+I.seller.gstin);
  L.push("", `Bill ${I.number} · ${dtLong(I.t)}`);
  if(I.status==="cancelled") L.push("CANCELLED");
  if(I.buyer) L.push("Customer: "+I.buyer.name+(I.buyer.gstin?" · GSTIN "+I.buyer.gstin:""));
  L.push("");
  I.lines.forEach(l=>L.push(`${l.name}${l.variant?" ("+l.variant+")":""} × ${l.qtyText||l.qty} = ${inrx(l.gross)}${l.discount?` (−${inrx(l.discount)})`:""}`));
  L.push("");
  if(T.discount) L.push("Discount: −"+inrx(T.discount));
  if(!I.inclusive) G.forEach(g=>L.push(`${g.label}: ${inrx(g.amount)}`));
  if(T.roundOff) L.push("Round off: "+(T.roundOff>0?"+":"")+inrx(T.roundOff));
  L.push(`*Total: ${inr(T.total)}*`+(I.inclusive&&G.length?` (incl. ${G.map(g=>g.label+" "+inrx(g.amount)).join(", ")})`:""));
  if(T.credit) L.push(`Exchange credit: −${inr(T.credit)}`, `Paid: ${inr(T.due)} (${I.payments.map(p=>p.label).join(" + ")||"covered by the credit"})`);
  else if(I.payments.length>1) L.push("Paid: "+payLines(I).map(p=>`${p.label} ${inrx(p.amount)}`).join(" + "));
  else L.push(I.payments[0]?"Paid by "+I.payments[0].label:"Nothing to pay");
  if(I.change) L.push("Change: "+inrx(I.change));
  if(I.footer) L.push("", I.footer);
  return L.join("\n");
}
