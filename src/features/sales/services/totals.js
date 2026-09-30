// Bill totals and invoice numbers with this shop's settings: GST on or off, prices with or without GST, each product's
// own GST rate, and CGST + SGST or IGST from the shop's and the customer's GSTIN. The maths is in the domain
// (domain/sales/checkout-totals.js); this only gathers what it needs.
import { store } from '../../../shared/state/store.js';
import { computeCheckout } from '../../../domain/sales/checkout-totals.js';
import { lineRate, placeOfSupply } from '../../../domain/sales/gst.js';
import { formatInvoiceNo, nextDocNo } from '../../../domain/sales/sale.js';
import { prod } from '../../products/services/catalog.js';

/* The bill's customer with their saved GSTIN and type (the bill itself keeps id, name and mobile) */
export function billCustomer(cust){
  if(!cust||!cust.name) return null;
  const c=cust.id&&store.customers[cust.id];
  return c?{...cust,gstin:c.gstin||"",type:c.type||"individual"}:{...cust,gstin:cust.gstin||"",type:cust.type||"individual"};
}
/* Which GST applies to a bill for this customer (null = walk-in): { mode, shopState, pos, b2b } */
export const gstContext=cust=>placeOfSupply({settings:store.settings,shop:store.profile||{},customer:billCustomer(cust)});
/* A bill line's GST rate: the product's own rate, else the shop's */
export const rateOf=c=>lineRate((prod(c.p)||{}).gst,store.settings);
/* Totals for bill lines ({ q, price, p, disc? }) with a bill discount, for a customer (default: the bill's customer) */
export function billTotals(lines,billDisc,cust){
  const g=gstContext(cust===undefined?store.cartCust:cust);
  return computeCheckout({lines:lines.map(c=>({q:c.q,price:c.price,disc:c.disc,rate:rateOf(c)})),billDisc,gst:{mode:g.mode,inclusive:!!store.settings.taxIncl}});
}
export const invoiceNo=(t,seq,dev)=>formatInvoiceNo(store.settings.prefix,t,seq,dev);
/* The next number of a document made on this device at time t, in this device's own series (no other device makes it,
   even offline): bills (the shop's prefix), credit notes ("CN-"), quotations ("QT-"), sales orders ("SO-")…
   docs: the documents of that kind this device knows ({ no, t, dev }) */
export const deviceDocNo=(prefix,docs,t)=>nextDocNo(prefix,docs,t,store.dev);
export const nextBillNo=(sales,t)=>deviceDocNo(store.settings.prefix||"",sales,t);
