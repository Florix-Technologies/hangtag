// One bill, every presentation. A saved bill's facts (the invoice: domain/invoices/invoice.js buildInvoice) become ONE
// document — its title, the parties, the lines, then the totals, the payments and what follows them, in the words and the
// order every output uses. The 80 mm receipt and its image, the A4 tax invoice (preview, print and PDF), the thermal
// printer's text and the WhatsApp / SMS text only lay this document out, each in its own way; none of them decides a
// label, a sign, an order or whether a row is shown. So the preview, the PDF and the printed slip can't disagree.
// Pure. Amounts stay numbers (each output formats them its own way: ₹1,234.50 on paper, 1234.50 on a thermal printer).
import { gstLines } from '../invoices/invoice.js';
import { inrx } from '../../shared/formatting/money.js';

/* Under a line's name: its variant, SKU, serial numbers and batches */
export const lineSub = l => [l.variant, l.sku, l.serials && "SN " + l.serials, l.batch && "Batch " + l.batch].filter(Boolean).join(" · ");
/* How a payment was made, in a few words: cash received and change (fmt: how money is written), the reference, the card's
   last digits, verified or not */
export const paymentNote = (p, fmt = String) => [p.method === "cash" && p.change ? `received ${fmt(p.received)} · change ${fmt(p.change)}` : p.ref ? "ref " + p.ref : "",
  p.last4 ? "card ••" + p.last4 : "", p.verification === "verified" ? "verified" : p.verification === "unverified" ? "unverified" : ""].filter(Boolean).join(" · ");

/* inv: the invoice; opts: { showGst } (an A4 template may leave GST out of the totals; receipts always show it)
   → { kind ("invoice" | "bill"), title, numberLabel, number, t, status, cancelled (the words, or false), seller, logo, buyer,
       placeOfSupply, gstMode, inclusive, lineTax, lines (the invoice's), totals, payments, closing, settled, words,
       taxSummary, notice, footer }
   totals / closing rows: { key, label, amount, sign ("" | "+" | "−"), grand (the figure to look at), small }
   payments: { key: "pay", method, label ("Paid by Cash"), amount, note (paymentNote) }
   settled: what to say when there is no payment and nothing owed ("Nothing to pay", "Covered by the exchange credit"), or "" */
export function billContent(inv, { showGst = true } = {}){
  const T = inv.totals, taxed = T.tax > 0, G = showGst ? gstLines(inv) : [];
  const row = (key, label, amount, o = {}) => ({ key, label, amount, sign: o.sign || "", grand: !!o.grand, small: !!o.small });
  const totals = [row("subtotal", "Subtotal", T.subtotal)];
  if(T.itemDiscount) totals.push(row("itemDiscount", "Item discounts", T.itemDiscount, { sign: "−" }));
  if(T.billDiscount) totals.push(row("billDiscount", "Bill discount" + (T.billDiscountLabel ? " " + T.billDiscountLabel : ""), T.billDiscount, { sign: "−" }));
  if(G.length && !inv.inclusive){ totals.push(row("taxable", "Taxable amount", T.taxable)); G.forEach((g, i) => totals.push(row("gst" + i, g.label, g.amount))); }
  if(T.roundOff) totals.push(row("roundOff", "Round off", Math.abs(T.roundOff), { sign: T.roundOff > 0 ? "+" : "−" }));
  totals.push(row("total", "Total", T.total, { grand: true }));
  if(G.length && inv.inclusive){ totals.push(row("taxable", "Taxable amount", T.taxable, { small: true })); G.forEach((g, i) => totals.push(row("gst" + i, "Includes " + g.label, g.amount, { small: true }))); }
  if(T.credit) totals.push(row("credit", "Exchange credit", T.credit, { sign: "−" }), row("due", "Amount due", T.due, { grand: true }));
  const payments = (inv.payments || []).map(p => ({ key: "pay", method: p.method, label: "Paid by " + p.label, amount: p.amount, note: paymentNote(p, inrx) }));
  // part (or all) of the bill on the customer's account: said plainly, never "paid" for the whole bill
  const closing = [];
  if(inv.balance > 0) closing.push(row("balance", inv.buyer ? "Balance due (on account)" : "Balance due", inv.balance, { grand: true }));
  if(inv.change) closing.push(row("change", "Change given", inv.change, { small: true }));
  if(inv.returned) closing.push(row("returned", "Returned items", inv.returned, { small: true }));
  if(inv.refunded) closing.push(row("refunded", "Refunded", inv.refunded, { small: true }));
  const settled = !payments.length && !(inv.balance > 0) ? (T.credit ? "Covered by the exchange credit" : "Nothing to pay") : "";
  const kind = taxed ? "invoice" : "bill";
  return { kind, title: taxed ? "Tax Invoice" : "Bill", numberLabel: taxed ? "Invoice no." : "Bill no.", number: inv.number, t: inv.t, status: inv.status,
    cancelled: inv.status === "cancelled" ? (taxed ? "not a valid invoice" : "not a valid bill") : false,
    seller: inv.seller, logo: inv.logo || "", buyer: inv.buyer, placeOfSupply: inv.placeOfSupply && inv.gstMode !== "none" ? inv.placeOfSupply : null,
    gstMode: inv.gstMode, inclusive: inv.inclusive, lineTax: inv.lineTax, lines: inv.lines, totals, payments, closing, settled,
    words: inv.amountInWords, taxSummary: showGst ? inv.taxSummary : [], returns: inv.returns || [],
    notice: (taxed ? (inv.inclusive ? "Prices include GST. " : "GST is added to the prices. ") : "") + (taxed ? "Computer-generated invoice." : "Computer-generated bill."),
    footer: inv.footer || "" };
}
/* Every money row in order — totals, payments (or what settled it), then what follows — for outputs that list them all:
   [{ key, label, amount | null, sign, grand, small, note }] */
export function billRows(doc){
  return [...doc.totals, ...(doc.payments.length ? doc.payments.map(p => ({ key: "pay", label: p.label, amount: p.amount, sign: "", grand: false, small: false, note: p.note }))
    : doc.settled ? [{ key: "settled", label: doc.settled, amount: null, sign: "", grand: false, small: false }] : []), ...doc.closing];
}
