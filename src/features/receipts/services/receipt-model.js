// The invoice of a bill (domain/invoices/invoice.js) with this shop's details, and the bill as plain text.
// Every bill output — receipt, A4 invoice, picture, print, thermal print, messages — starts here, from the bill's saved
// figures; nothing is recalculated.
import { buildInvoice } from '../../../domain/invoices/invoice.js';
import { billContent, billRows, paymentNote } from '../../../domain/documents/bill-content.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';
import { documentLogo, documentLogoPlace } from './logo-display.js';

export function saleReturns(sid){ return (D().retBySale[sid]||[]); }
/* The invoice for a saved bill: shop profile, the customer's saved email / GSTIN, returns, footer and logo */
export function invoiceFor(s){
  const cust=s.cust&&s.cust.id?store.customers[s.cust.id]:null;
  return buildInvoice(s,{profile:store.profile||{},customer:cust,returns:saleReturns(s.id),footer:store.settings.footer||"",logo:documentLogo(),logoAlign:documentLogoPlace("receipt")});
}
/* How it was paid → [{ label, amount, note }] ("Cash", ₹400, "received ₹500 · change ₹100") */
export const payLines = inv => inv.payments.map(p => ({ label: p.label, amount: p.amount, note: paymentNote(p, inrx) }));
/* Plain-text bill for WhatsApp / sharing: the bill's one document (domain/documents/bill-content.js) as text — the same
   rows, words and order as the printed receipt and the A4 invoice; the figures to look at in bold */
export function receiptText(s){
  const B=billContent(invoiceFor(s)), L=[];
  L.push(`*${B.seller.name}*`); if(B.seller.address) L.push(B.seller.address); if(B.seller.gstin) L.push("GSTIN "+B.seller.gstin);
  L.push("", `${B.kind==="invoice"?B.title:"Bill"} ${B.number} · ${dtLong(B.t)}`);
  if(B.cancelled) L.push("CANCELLED");
  if(B.buyer) L.push("Customer: "+B.buyer.name+(B.buyer.gstin?" · GSTIN "+B.buyer.gstin:""));
  L.push("");
  B.lines.forEach(l=>L.push(`${l.name}${l.variant?" ("+l.variant+")":""} × ${l.qtyText||l.qty} = ${inrx(l.gross)}${l.discount?` (−${inrx(l.discount)})`:""}`));
  L.push("");
  billRows(B).forEach(x=>{ const v=x.amount==null?"":(x.sign||"")+inrx(x.amount), line=v?`${x.label}: ${v}`:x.label; L.push(x.grand?`*${line}*`:line+(x.note?` (${x.note})`:"")); });
  if(B.footer) L.push("", B.footer);
  return L.join("\n");
}
