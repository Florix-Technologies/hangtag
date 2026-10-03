// Purchase orders: what the shop asked a supplier for. A PO never changes stock; only receiving does, and receiving is an
// ordinary purchase (domain/inventory/purchase.js) that points at the PO (poId), so the stock ledger, the supplier's
// account, serials, batches and expiry all work as they always have.
//   stored status:  draft → sent → (closed) · cancelled        (closed: done with it, even if not everything came)
//   shown status:   draft · sent · partly received · received · closed · cancelled   — "received" and "partly received"
//                   are worked out from the purchases that point at the PO, so two phones receiving never fight over it
// The database repeats the rules (supabase/schema.sql section 3r): a receipt is refused when it would take more than is
// still to come unless the person said the supplier sent extra (allowOver), so the same delivery can't be received twice.
// Comparing PO, goods received and the supplier's bill happens here too (discrepancies), never by hand. Pure.
import { decimalsOf, roundQty } from '../catalog/units.js';
import { toPaise, toRupees, tooPrecise } from '../sales/paise.js';

export const PO_STATUSES = ["draft", "sent", "closed", "cancelled"];
export const PO_LABELS = { draft: "Draft", sent: "Sent", partial: "Partly received", received: "Received", closed: "Closed", cancelled: "Cancelled" };
export const PO_NEXT = { draft: ["sent", "cancelled", "closed"], sent: ["draft", "cancelled", "closed"], closed: [], cancelled: [] };
export const PO_PREFIX = "PO-";
export const MAX_PO_LINES = 200;
const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, max || 500);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* A line: { ln, p, v, name, vl, u, q (ordered), price (agreed cost per unit, before GST), gst } */
/* The first problem with a PO before it is saved → { error, field, line? } or null */
export function checkPO(po){
  if(!po || !po.id) return { error: "The purchase order has no id." };
  if(!PO_STATUSES.includes(po.status)) return { error: "Unknown status.", field: "status" };
  if(!po.supplierId) return { error: "Choose the supplier.", field: "supplier" };
  const items = po.items || [];
  if(!items.length) return { error: "Add at least one product: scan it or search for it.", field: "items" };
  if(items.length > MAX_PO_LINES) return { error: `A purchase order can have up to ${MAX_PO_LINES} lines.`, field: "items" };
  const seen = new Set();
  for(const [i, l] of items.entries()){
    const lab = l.name || `Line ${i + 1}`;
    if(!l.v || !l.p) return { error: `${lab}: choose the product.`, field: "items", line: i };
    if(seen.has(l.v)) return { error: `${lab} is on the order twice. Change the quantity instead.`, field: "items", line: i };
    seen.add(l.v);
    const q = +l.q, dp = decimalsOf(l.u);
    if(!(Number.isFinite(q) && q > 0)) return { error: `${lab}: enter how many to order.`, field: "qty", line: i };
    if(Math.abs(q * 10 ** dp - Math.round(q * 10 ** dp)) > 1e-6) return { error: dp ? `${lab}: use at most ${dp} decimal places.` : `${lab}: order whole pieces.`, field: "qty", line: i };
    if(q > 1000000) return { error: `${lab}: that quantity is too large.`, field: "qty", line: i };
    if(l.price != null && l.price !== "" && (!(Number.isFinite(+l.price) && +l.price >= 0) || tooPrecise(+l.price))) return { error: `${lab}: enter the agreed price (₹0 or more, at most 2 decimals).`, field: "price", line: i };
    if(l.gst != null && l.gst !== "" && !(Number.isFinite(+l.gst) && +l.gst >= 0 && +l.gst <= 100)) return { error: `${lab}: GST % should be between 0 and 100.`, field: "gst", line: i };
  }
  if(po.expected && !DAY_RE.test(po.expected)) return { error: "Enter the expected date as a date.", field: "expected" };
  if(String(po.notes || "").length > 500) return { error: "Notes can be at most 500 characters.", field: "notes" };
  return null;
}
export const canMovePO = (from, to) => from === to || (PO_NEXT[from] || []).includes(to);

/* The purchases (receipts) that belong to a PO and still count (not cancelled) */
export const receiptsOf = (po, purchases) => (purchases || []).filter(p => p && po && p.poId === po.id && p.status !== "cancelled");
/* Received so far per variant, from those receipts: { [variant id]: qty } */
export function receivedBy(po, purchases){
  const out = {};
  receiptsOf(po, purchases).forEach(p => (p.lines || []).forEach(l => { out[l.v] = roundQty((out[l.v] || 0) + (+l.q || 0)); }));
  return out;
}
/* Each line with what is ordered, received and still to come (never below 0), and the shown status.
   → { lines: [{ ...line, ordered, received, remaining, over }], status, ordered, received, remaining, extras: [{ v, q }] } */
export function poProgress(po, purchases){
  const got = receivedBy(po, purchases), known = new Set();
  const lines = (po && po.items || []).map(l => {
    known.add(l.v);
    const ordered = +l.q || 0, received = got[l.v] || 0;
    return { ...l, ordered, received, remaining: roundQty(Math.max(0, ordered - received)), over: roundQty(Math.max(0, received - ordered)) };
  });
  const extras = Object.entries(got).filter(([v, q]) => !known.has(v) && q > 0).map(([v, q]) => ({ v, q }));
  const ordered = lines.reduce((a, l) => a + l.ordered, 0), received = lines.reduce((a, l) => a + Math.min(l.received, l.ordered), 0);
  const any = lines.some(l => l.received > 0) || extras.length > 0, all = lines.length > 0 && lines.every(l => l.remaining <= 0);
  const st = po ? po.status : "draft";
  const status = st === "cancelled" || st === "closed" ? st : all ? "received" : any ? "partial" : st;
  return { lines, status, ordered: roundQty(ordered), received: roundQty(received), remaining: roundQty(ordered - received), extras };
}
/* Can this PO be received now? → null or the reason */
export function receiveBlock(po){
  if(!po) return "That purchase order isn't on this device.";
  if(po.status === "cancelled") return "This purchase order is cancelled.";
  if(po.status === "closed") return "This purchase order is closed.";
  return null;
}
/* The receiving screen starts with what is still to come on every line (a person only changes what differs) */
export const receiveDefaults = (po, purchases) => Object.fromEntries(poProgress(po, purchases).lines.map(l => [l.v, l.remaining]));
/* A receiving session → the purchase input (domain/inventory/purchase.js buildPurchase) for the lines with a quantity.
   counts: { [variant id]: qty received now } · extra: { [variant id]: { serials?, batch? } } · opts: { invoiceNo, invoiceDate }
   → { error } or { input, over: [{ name, q, remaining }] } — over: lines receiving more than is still to come (needs allowOver) */
export function receivingInput(po, purchases, counts, extra, opts){
  const block = receiveBlock(po); if(block) return { error: block };
  const P = poProgress(po, purchases), x = extra || {}, o = opts || {};
  const lines = [], over = [];
  P.lines.forEach(l => {
    const q = roundQty(+(counts || {})[l.v] || 0);
    if(!(q > 0)) return;
    if(q > l.remaining) over.push({ name: l.name, q, remaining: l.remaining });
    lines.push(Object.assign({ p: l.p, v: l.v, q: String(q), cost: l.price == null || l.price === "" ? "0" : String(l.price), gst: l.gst == null ? "" : String(l.gst) }, x[l.v] || {}));
  });
  if(!lines.length) return { error: "Enter what arrived: at least one quantity more than 0." };
  return { input: { supplierId: po.supplierId, invoiceNo: clean(o.invoiceNo, 40), invoiceDate: o.invoiceDate || "", lines, paid: 0, method: "", note: clean(`PO ${po.no || ""}`, 200), poId: po.id }, over };
}

/* ---------- Smart reorder → draft purchase orders ---------- */
/* recs: [{ v, p, name, vl, u, q (suggested), cost }] · supplierOf(variant id, product id) → supplier id or null
   → [{ supplierId, items: [{ p, v, name, vl, u, q, price }] }] — one draft per supplier (items without a known supplier
   share one group with supplierId null, so the owner picks the supplier once) */
export function draftsFromReorder(recs, supplierOf){
  const groups = new Map();
  (recs || []).forEach(r => {
    if(!r || !r.v || !(+r.q > 0)) return;
    const sid = (supplierOf && supplierOf(r.v, r.p)) || null;
    if(!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push({ p: r.p, v: r.v, name: r.name, vl: r.vl || "", ...(r.u && r.u !== "pcs" ? { u: r.u } : {}), q: +r.q, price: r.cost == null ? null : +r.cost });
  });
  return [...groups.entries()].map(([supplierId, items]) => ({ supplierId, items: items.map((l, k) => ({ ...l, ln: k })) }))
    .sort((a, b) => (a.supplierId == null) - (b.supplierId == null) || b.items.length - a.items.length);
}
/* The supplier a variant was last bought from (newest posted purchase with it), or null */
export function lastSupplierOf(vid, purchases){
  let best = null;
  (purchases || []).forEach(p => { if(p && p.status !== "cancelled" && p.supplierId && (p.lines || []).some(l => l.v === vid) && (!best || p.t > best.t)) best = p; });
  return best ? best.supplierId : null;
}

/* ---------- PO vs goods received vs supplier bill ---------- */
/* bill: { no, date, lines: [{ v, name, q, price (before GST), gst }] } (the supplier's invoice, typed or read from the file;
   it never adds stock). → [{ key, kind, v, name, expected, actual, text }] where kind is one of
   qty_received (received ≠ ordered), qty_billed (billed ≠ received), price (bill price ≠ agreed price), tax (GST % differs),
   missing (ordered, nothing received and not billed), unexpected (received or billed but not ordered) */
export function discrepancies(po, purchases, bill){
  const out = [], P = poProgress(po, purchases), B = bill && Array.isArray(bill.lines) ? bill.lines : null;
  const billBy = new Map((B || []).map(l => [l.v, l]));
  const money = n => toRupees(toPaise(n));
  P.lines.forEach(l => {
    const b = billBy.get(l.v), name = l.name + (l.vl ? " · " + l.vl : "");
    if(l.received > 0 && l.received !== l.ordered && (po.status === "closed" || l.received > l.ordered))
      out.push({ key: `qr:${l.v}`, kind: "qty_received", v: l.v, name, expected: l.ordered, actual: l.received, text: `Ordered ${l.ordered}, received ${l.received}` });
    if(!l.received && !b && (po.status === "closed" || P.status === "received" || P.status === "partial") && P.received > 0)
      out.push({ key: `ms:${l.v}`, kind: "missing", v: l.v, name, expected: l.ordered, actual: 0, text: `Ordered ${l.ordered}, nothing received yet` });
    if(!b) return;
    if(+b.q !== l.received && l.received > 0) out.push({ key: `qb:${l.v}`, kind: "qty_billed", v: l.v, name, expected: l.received, actual: +b.q, text: `Received ${l.received}, billed ${+b.q}` });
    if(!l.received && +b.q > 0) out.push({ key: `qb:${l.v}`, kind: "qty_billed", v: l.v, name, expected: 0, actual: +b.q, text: `Billed ${+b.q}, nothing received` });
    if(l.price != null && l.price !== "" && b.price != null && toPaise(b.price) !== toPaise(l.price))
      out.push({ key: `pr:${l.v}`, kind: "price", v: l.v, name, expected: money(l.price), actual: money(b.price), text: `Expected ₹${money(l.price)}, bill ₹${money(b.price)}` });
    if(l.gst != null && l.gst !== "" && b.gst != null && b.gst !== "" && +b.gst !== +l.gst)
      out.push({ key: `tx:${l.v}`, kind: "tax", v: l.v, name, expected: +l.gst, actual: +b.gst, text: `GST ${+l.gst}% on the order, ${+b.gst}% on the bill` });
  });
  const ordered = new Set(P.lines.map(l => l.v));
  P.extras.forEach(e => out.push({ key: `ux:${e.v}`, kind: "unexpected", v: e.v, name: (billBy.get(e.v) || {}).name || e.v, expected: 0, actual: e.q, text: `Received ${e.q}, not on the order` }));
  (B || []).forEach(b => { if(b.v && !ordered.has(b.v) && !P.extras.some(e => e.v === b.v)) out.push({ key: `ub:${b.v}`, kind: "unexpected", v: b.v, name: b.name || b.v, expected: 0, actual: +b.q, text: `Billed ${+b.q}, not on the order` }); });
  return out;
}
/* What still needs a look: the differences nobody accepted yet (review: [{ key, action: "accepted" | "note", note, t, by }]) */
export const openDiscrepancies = (list, review) => (list || []).filter(d => !(review || []).some(r => r.key === d.key && r.action === "accepted"));
/* A bill as typed on the PO screen: lines for variants of the catalog with a quantity and a price → { error } or { bill } */
export function checkPOBill(bill){
  const b = bill || {}, lines = [];
  for(const [i, l] of (b.lines || []).entries()){
    if(!l || !l.v) continue;
    const q = +l.q, price = +l.price;
    if(!(Number.isFinite(q) && q >= 0)) return { error: `Bill line ${i + 1}: enter the quantity billed.` };
    if(!(Number.isFinite(price) && price >= 0) || tooPrecise(price)) return { error: `Bill line ${i + 1}: enter the price on the bill (₹0 or more).` };
    lines.push({ v: l.v, name: clean(l.name, 120), q, price, ...(l.gst != null && l.gst !== "" ? { gst: +l.gst } : {}) });
  }
  if(!lines.length) return { error: "Enter at least one line of the supplier's bill." };
  return { bill: { no: clean(b.no, 40), date: DAY_RE.test(b.date || "") ? b.date : "", lines } };
}
