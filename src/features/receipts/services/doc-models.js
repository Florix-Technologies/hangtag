// The document model of every A4 document (components/doc-render.js draws it; shared/utils/pdf.js docPdfBytes makes its
// PDF): a bill as a Tax Invoice or Bill, a quotation, a sales order, its delivery challan, a return's credit note and a
// purchase order. Built only from what was saved — nothing is recalculated here except the order totals the till itself
// uses (orders/use-cases/orders.js orderTotals). The shop's template settings add terms, bank details and the signature.
import { store } from '../../../shared/state/store.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { sellerOf } from '../../../domain/invoices/invoice.js';
import { amountInWords } from '../../../domain/invoices/amount-words.js';
import { docSettingsOf } from '../../../domain/documents/doc-settings.js';
import { discountLabel, normalizeDiscount } from '../../../domain/sales/discounts.js';
import { qtyText } from '../../../domain/catalog/units.js';
import { lineLabel } from '../../../domain/catalog/options.js';
import { PAY_LABELS } from '../../../domain/sales/payments.js';
import { poProgress } from '../../../domain/inventory/purchase-orders.js';
import { invoiceFor } from './receipt-model.js';
import { orderTotals } from '../../orders/use-cases/orders.js';
import { customerRepository } from '../../customers/repositories/customer-repository.js';
import { purchasesList, supplierById } from '../../inventory/services/purchase-state.js';
import { D } from '../../inventory/services/ledger.js';

const day = v => { if(!v) return ""; const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(String(v) + "T12:00:00") : new Date(v); return Number.isNaN(+d) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); };
const pct = r => r == null ? "—" : Math.round(r * 100) / 100 + "%";
const settings = () => docSettingsOf(store.settings);
function seller(){ const S = sellerOf(store.profile || {}); return { name: S.name, lines: [S.address, S.phone && "Phone " + S.phone, S.gstin && "GSTIN " + S.gstin] }; }
const base = () => { const D = settings(); return { seller: seller(), logo: store.logo || "", terms: D.terms, bank: D.bank, signature: D.signature, footer: store.settings && store.settings.footer || "" }; };

/* ---------- a bill: Tax Invoice (with GST) or Bill ---------- */
export function invoiceModel(s){
  const I = invoiceFor(s), Dset = settings(), T = I.totals, taxed = T.tax > 0, inter = I.gstMode === "inter", show = taxed && Dset.showGst, perLine = show && I.lineTax, hsn = I.lines.some(l => l.hsn);
  const columns = ["#", "Item", ...(hsn ? ["HSN"] : []), "Qty", "Rate", "Discount", ...(perLine ? ["Taxable", "GST %", ...(inter ? ["IGST"] : ["CGST", "SGST"])] : []), "Amount"];
  const rows = I.lines.map(l => [String(l.sl), { t: l.name, sub: [l.variant, l.sku, l.serials && "SN " + l.serials, l.batch && "Batch " + l.batch].filter(Boolean).join(" · ") }, ...(hsn ? [l.hsn || "—"] : []),
    l.qtyText, inrx(l.rate) + (l.unit ? "/" + l.unit : ""), l.discount ? "−" + inrx(l.discount) : "—",
    ...(perLine ? [inrx(l.taxable), pct(l.gstRate), ...(inter ? [inrx(l.igst)] : [inrx(l.cgst), inrx(l.sgst)])] : []), inrx(l.total != null ? l.total : l.gross)]);
  const totals = [["Subtotal", inrx(T.subtotal)]];
  if(T.itemDiscount) totals.push(["Item discounts", "−" + inrx(T.itemDiscount)]);
  if(T.billDiscount) totals.push(["Bill discount" + (T.billDiscountLabel ? " " + T.billDiscountLabel : ""), "−" + inrx(T.billDiscount)]);
  if(show && !I.inclusive){ totals.push(["Taxable amount", inrx(T.taxable)]); if(inter) totals.push(["IGST", inrx(T.igst)]); else totals.push(["CGST", inrx(T.cgst)], ["SGST", inrx(T.sgst)]); }
  if(T.roundOff) totals.push(["Round off", (T.roundOff > 0 ? "+" : "") + inrx(T.roundOff)]);
  totals.push(["Total", inr(T.total), true]);
  if(show && I.inclusive) totals.push(["Includes GST", inrx(T.tax)]);
  if(T.credit) totals.push(["Exchange credit", "−" + inr(T.credit)], ["Amount due", inr(T.due)]);
  if(I.payments.length) totals.push(["Paid" + (I.payments.length === 1 ? " · " + I.payments[0].label : ""), inrx(I.paid)]);
  if(I.balance > 0) totals.push(["Balance due", inr(I.balance)]);
  const b = I.buyer;
  return Object.assign(base(), { kind: taxed ? "invoice" : "bill", title: taxed ? "Tax Invoice" : "Bill", number: I.number,
    meta: [[taxed ? "Invoice no." : "Bill no.", I.number], ["Date", dtLong(I.t)], ["Place of supply", I.placeOfSupply && I.gstMode !== "none" ? I.placeOfSupply.name : ""]],
    parties: [{ label: "Bill to", name: b ? b.name : "Walk-in customer", lines: b ? [b.phone, b.email, b.gstin && "GSTIN " + b.gstin, b.business ? "Business customer" : ""] : [] }],
    columns, left: hsn ? 3 : 2, rows, totals,
    tax: show && I.taxSummary.length ? { head: ["GST rate", "Taxable", ...(inter ? ["IGST"] : ["CGST", "SGST"]), "Total GST"], rows: I.taxSummary.map(r => [pct(r.rate), inrx(r.taxable), ...(inter ? [inrx(r.igst)] : [inrx(r.cgst), inrx(r.sgst)]), inrx(r.tax)]) } : null,
    words: I.amountInWords, footer: I.footer, cancelled: I.status === "cancelled" ? (taxed ? "not a valid invoice" : "not a valid bill") : false,
    notice: (taxed ? (I.inclusive ? "Prices include GST. " : "GST is added to the prices. ") : "") + (taxed ? "Computer-generated invoice." : "Computer-generated bill.") });
}

/* ---------- quotations, sales orders and delivery challans ---------- */
function buyerOf(o){ const saved = o.cust && o.cust.id ? customerRepository().get(o.cust.id) : null; return Object.assign({}, saved || {}, o.cust || {}); }
function orderRows(o, T, showGst){
  return (o.items || []).map((l, i) => { const x = T.lines[i] || {}, d = normalizeDiscount(l.disc);
    return [{ t: l.name || "", sub: l.vl || "" }, qtyText(l.q, l.u), inrx(l.price), d ? discountLabel(d) : "—", ...(showGst ? [inrx(x.taxable || 0), x.rate ? `${pct(x.rate)} · ${inrx(x.tax || 0)}` : "—"] : []), inrx(x.total || 0)]; });
}
function orderTotalsRows(T, showGst){
  const out = [["Subtotal", inrx(T.sub)]];
  if(T.disc) out.push(["Discount", "− " + inrx(T.disc)]);
  if(showGst){ out.push(["Taxable", inrx(T.taxable)]); if(T.cgst) out.push(["CGST", inrx(T.cgst)]); if(T.sgst) out.push(["SGST", inrx(T.sgst)]); if(T.igst) out.push(["IGST", inrx(T.igst)]); }
  if(T.roundOff) out.push(["Round off", inrx(T.roundOff)]);
  out.push(["Total", inr(T.total), true]);
  return out;
}
/* A quotation (headed with the shop's quotation title; never "invoice") or a sales order */
export function orderModel(o){
  if(!o) return null;
  const T = orderTotals(o), S = store.settings || {}, B = buyerOf(o), quote = o.kind === "quote";
  const showGst = (quote ? S.quoteGst !== false : settings().showGst) && T.mode !== "none";
  return Object.assign(base(), { kind: quote ? "quotation" : "salesorder", title: quote ? (String(S.quoteTitle || "").trim() || "QUOTATION") : "Sales Order", number: o.no || "Draft",
    meta: [[quote ? "Quotation no." : "Order no.", o.no || "Draft"], ["Date", day(o.t)], quote ? ["Valid until", day(o.validUntil) || "—"] : ["Deliver by", day(o.deliverBy)]],
    parties: [{ label: quote ? "Quotation for" : "Customer", name: B.name || "Customer", lines: [B.phone, B.email, B.gstin && "GSTIN " + B.gstin, B.address] }],
    columns: ["Item", "Qty", "Unit price", "Discount", ...(showGst ? ["Taxable", "GST"] : []), "Total"], left: 1, rows: orderRows(o, T, showGst), totals: orderTotalsRows(T, showGst),
    words: amountInWords(T.total), notes: o.notes || "", terms: o.terms || (quote ? "" : settings().terms),
    signature: (quote ? S.quoteSignature : "") || settings().signature, footer: (quote ? S.quoteFooter : "") || S.footer || "",
    notice: quote ? "This is a quotation, not a bill." : "This confirms the order. It is not a bill: the bill follows on delivery.",
    cancelled: o.status === "cancelled" ? true : false });
}
/* The delivery challan of a sales order: what goes with this delivery (what is still to deliver), no prices */
export function challanModel(o){
  if(!o || o.kind !== "sales") return null;
  const B = buyerOf(o), rows = (o.items || []).map((l, i) => { const left = Math.max(0, (+l.q || 0) - (+l.fq || 0));
    return [String(i + 1), { t: l.name || "", sub: l.vl || "" }, qtyText(l.q, l.u), qtyText(+l.fq || 0, l.u), qtyText(left, l.u)]; });
  return Object.assign(base(), { kind: "challan", title: "Delivery Challan", number: (o.no || "Order") + "-DC",
    meta: [["Challan no.", (o.no || "Order") + "-DC"], ["Date", day(Date.now())], ["Against order", o.no || ""]],
    parties: [{ label: "Deliver to", name: B.name || "Customer", lines: [B.phone, B.address, B.gstin && "GSTIN " + B.gstin] }],
    columns: ["#", "Item", "Ordered", "Delivered before", "This delivery"], left: 2, rows, totals: [], terms: "", bank: "",
    notes: o.notes || "", notice: "Goods sent for delivery against the order above. This is not a bill.", signature: "Received by (name and signature)" });
}

/* ---------- a return's credit note ---------- */
export function creditNoteModel(r){
  if(!r) return null;
  const s = D().saleById[r.sale], c = s && s.cust, items = r.items || [];
  const rows = items.map((i, k) => [String(k + 1), { t: i.n || "", sub: lineLabel(i) }, qtyText(i.q, i.u), inrx(i.price != null ? i.price : (i.value || 0) / (i.q || 1)), inrx(i.value != null ? i.value : (i.price || 0) * (i.q || 0))]);
  const tax = items.reduce((a, i) => a + (i.cgst || 0) + (i.sgst || 0) + (i.igst || 0), 0);
  const totals = [["Value of goods returned", inrx(r.value || 0), true]];
  if(tax) totals.splice(0, 0, ["Includes GST", inrx(tax)]);
  if(r.refund) totals.push(["Refunded" + (r.pay ? " · " + (PAY_LABELS[r.pay] || r.pay) : ""), inrx(r.refund)]);
  if(r.kind === "exchange") totals.push(["Used for the exchange bill", inrx(Math.max(0, (r.value || 0) - (r.refund || 0)))]);
  return Object.assign(base(), { kind: "creditnote", title: "Credit Note", number: r.no || "",
    meta: [["Credit note no.", r.no || "—"], ["Date", dtLong(r.t)], ["Against bill", s ? s.no : ""]],
    parties: [{ label: "Customer", name: c && c.name ? c.name : "Walk-in customer", lines: [c && c.phone, c && c.gstin && "GSTIN " + c.gstin] }],
    columns: ["#", "Item returned", "Qty", "Rate", "Value"], left: 2, rows, totals, words: amountInWords(r.value || 0),
    notes: r.reason ? "Reason: " + r.reason : "", bank: "", notice: r.kind === "exchange" ? "Goods returned in an exchange." : "Goods returned against the bill above." });
}

/* ---------- a purchase order to a supplier ---------- */
export function purchaseOrderModel(po){
  if(!po) return null;
  const sup = supplierById(po.supplierId) || {}, P = poProgress(po, purchasesList()), S = sellerOf(store.profile || {});
  let sub = 0, gst = 0;
  const rows = P.lines.map((l, i) => { const amt = (+l.price || 0) * (+l.q || 0), g = amt * (+l.gst || 0) / 100; sub += amt; gst += g;
    return [String(i + 1), { t: l.name || "", sub: l.vl || "" }, qtyText(l.q, l.u), l.price != null ? inrx(l.price) : "—", l.gst != null ? pct(l.gst) : "—", amt ? inrx(amt) : "—"]; });
  const total = Math.round((sub + gst) * 100) / 100, hasPrice = sub > 0;
  return Object.assign(base(), { kind: "po", title: "Purchase Order", number: po.no || "Draft",
    meta: [["PO no.", po.no || "Draft"], ["Date", day(po.t)], ["Deliver by", day(po.expected)]],
    parties: [{ label: "Supplier", name: sup.name || "Supplier", lines: [sup.phone, sup.gstin && "GSTIN " + sup.gstin, sup.address] },
      { label: "Deliver to", name: S.name, lines: [S.address, S.phone && "Phone " + S.phone] }],
    columns: ["#", "Item", "Qty", "Rate", "GST", "Amount"], left: 2, rows,
    totals: hasPrice ? [["Subtotal", inrx(sub)], ["GST", inrx(gst)], ["Total", inr(total), true]] : [],
    words: hasPrice ? amountInWords(total) : "", notes: po.notes || "", terms: "", bank: "", footer: "",
    notice: "Please supply the items above at the rates shown and quote this PO number on your bill.", cancelled: po.status === "cancelled" ? true : false });
}
