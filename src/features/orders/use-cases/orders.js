// Quotations and sales orders (the orders engine; table orders come with the restaurant batch). An order is saved on this
// device first and uploaded as a whole (RPC hangtag_save_order: refused when another device changed it meanwhile — the
// sync review shows it). Orders never change stock. A quotation becomes a sales order (its lines copied), and either goes
// on the bill (what is left to deliver, at the order's prices) → the existing checkout → the bill keeps the order's id and
// the order counts what was delivered (partly delivered / completed). The rules are in domain/orders/orders.js.
import { FIRST_STATUS, KIND_LABELS, STATUS_LABELS, canMove, cartBlock, checkOrder, convertQuote, fulfil, isFinal, orderCartLines, orderCheckout, orderNo,
  soldFromOrder } from '../../../domain/orders/orders.js';
import { legacyCS, optionSnapshot } from '../../../domain/catalog/options.js';
import { vCost, vLabel, vPrice } from '../../../domain/catalog/variants.js';
import { normalizeDiscount } from '../../../domain/sales/discounts.js';
import { store } from '../../../shared/state/store.js';
import { orderRepository } from '../repositories/order-repository.js';
import { vRec } from '../../inventory/services/ledger.js';
import { stockOf } from '../../inventory/services/stock.js';
import { gstContext, rateOf } from '../../sales/services/totals.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { addDays, dayKey } from '../../../shared/formatting/dates.js';
import { okColor } from '../../../shared/utils/colors.js';
import { uid } from '../../../shared/utils/ids.js';
import { can, denied, notAllowedText } from '../../shop/services/access.js';

export const QUOTE_VALID_DAYS = 15;
const upload = () => { renderSync(); flushSbQueue(); };
export const todayKey = () => dayKey(Date.now());
/* Orders of a kind, newest first */
export const ordersOf = kind => orderRepository().list().filter(o => o.kind === kind).sort((a, b) => b.t - a.t);
export const orderById = id => orderRepository().get(id);
/* This device's next number of a kind that day (QT-/SO- + date + device code + running number) */
export function nextOrderNo(kind, t){
  const k = dayKey(t), seq = orderRepository().list().filter(o => o.kind === kind && o.dev === store.dev && dayKey(o.t) === k).length + 1;
  return orderNo(kind, t, seq, store.dev);
}
/* An order's figures: the one bill calculation, with the GST of its customer's place of supply */
export function orderTotals(o){
  const g = gstContext(o && o.cust || null);
  return orderCheckout(o || {}, { mode: g.mode, inclusive: !!store.settings.taxIncl });
}
/* A line for a catalog variant, at its price today (or the one given) and with the GST rate a bill would charge */
export function orderLine(vid, q, price){
  const r = vRec(vid); if(!r) return null;
  return { p: r.p.id, v: vid, name: r.p.name, vl: vLabel(r.v), q: +q || 1, price: price == null ? vPrice(r.p, r.v) : +price, gst: rateOf({ p: r.p.id }), fq: 0 };
}
/* A new order, not saved yet: from the bill on the screen (its lines, discounts and customer) or empty */
export function newOrderDraft(kind, { cart, disc, cust } = {}){
  const t = Date.now();
  return { id: "o" + uid(), kind, no: "", status: FIRST_STATUS[kind], cust: cust && cust.id ? { id: cust.id, name: cust.name, phone: cust.phone || "" } : null,
    billDisc: normalizeDiscount(disc) || null, notes: "", validUntil: kind === "quote" ? addDays(dayKey(t), QUOTE_VALID_DAYS) : "", source: "staff", convertedTo: null,
    saleIds: [], version: 0, t, updatedT: t, dev: store.dev,
    items: (cart || []).map((c, k) => ({ ln: k, p: c.p, v: c.v, name: c.name, vl: c.vl || "", q: c.q, price: c.price, ...(normalizeDiscount(c.disc) ? { disc: normalizeDiscount(c.disc) } : {}),
      gst: rateOf(c), fq: 0 })) };
}
const discountsOf = o => JSON.stringify([normalizeDiscount(o && o.billDisc) || null, ...((o && o.items) || []).map(l => normalizeDiscount(l.disc) || null)]);
/* Saves a new or changed order → { order } or { error, field?, line? } (nothing changes).
   The shop's rules: create_order (the database checks it too); discounts need apply_discount unless they are as saved;
   a final order doesn't change; a status moves only as ORDER_NEXT allows; delivered quantities stay. */
export function saveOrder(draft){
  const no = denied("create_order", "save quotations and orders"); if(no) return no;
  const prev = draft && draft.id ? orderRepository().get(draft.id) : null;
  if(!can("apply_discount") && discountsOf(draft) !== discountsOf(prev || { items: [] }) && JSON.parse(discountsOf(draft)).some(Boolean))
    return { error: notAllowedText("give discounts") + " Remove the discount first.", field: "disc" };
  // a line keeps its number; new lines get numbers after every one the order ever used (a removed line's number isn't reused)
  const known = new Set(((prev && prev.items) || []).map(l => l.ln));
  let next = Math.max(-1, ...known) + 1;
  const items = (draft.items || []).map((l, k) => ({ ...l, ln: !prev ? k : known.has(l.ln) ? l.ln : next++ }));
  const o = { ...draft, items, notes: String(draft.notes || "").trim(), validUntil: draft.kind === "quote" ? draft.validUntil || "" : "" };
  const bad = checkOrder(o); if(bad) return bad;
  if(prev){
    if(isFinal(prev)) return { error: `This ${KIND_LABELS[prev.kind].toLowerCase()} is ${STATUS_LABELS[prev.status].toLowerCase()} and can't be changed.` };
    if(!canMove(prev.kind, prev.status, o.status)) return { error: `A ${STATUS_LABELS[prev.status].toLowerCase()} ${KIND_LABELS[prev.kind].toLowerCase()} can't become ${STATUS_LABELS[o.status].toLowerCase()}.`, field: "status" };
    const gone = prev.items.find(l => +l.fq > 0 && !o.items.some(x => x.ln === l.ln && +x.q >= +l.fq));
    if(gone) return { error: `${gone.name}: ${gone.fq} already delivered, so it stays on the order.`, field: "items" };
  }
  const t = Date.now();
  const saved = { ...o, no: o.no || (prev && prev.no) || nextOrderNo(o.kind, t), t: prev ? prev.t : o.t || t, updatedT: t, version: prev ? prev.version : 0, dev: prev ? prev.dev : store.dev,
    items: o.items.map(l => ({ ...l, fq: prev ? +((prev.items.find(x => x.ln === l.ln) || {}).fq || 0) : 0 })) };
  orderRepository().save(saved); upload();
  return { order: saved };
}
/* Moves an order to another status (sent, accepted, confirmed, cancelled …) → { order } or { error } */
export function setOrderStatus(id, status){
  const o = orderRepository().get(id); if(!o) return { error: "That order isn't on this device." };
  return saveOrder({ ...o, status });
}
/* A quotation becomes a sales order (confirmed; the quotation is "converted") → { order } or { error } */
export function convertToSalesOrder(id){
  const no = denied("create_order", "make sales orders"); if(no) return no;
  const q = orderRepository().get(id), t = Date.now();
  const r = convertQuote(q, { id: "o" + uid(), no: nextOrderNo("sales", t), t, dev: store.dev }, todayKey());
  if(r.error) return r;
  orderRepository().save(r.order); orderRepository().save(r.quote); upload();
  return { order: r.order, quote: r.quote };
}
/* What is left to deliver goes on the bill (only onto an empty bill), at the order's prices and discounts, for its
   customer; the bill then goes through the usual checkout. → { lines, skipped } or { error } */
export function orderToCart(id){
  const no = denied("create_sale", "bill orders") || denied("create_order", "bill orders"); if(no) return no;
  const o = orderRepository().get(id), why = cartBlock(o, todayKey());
  if(why) return { error: why };
  if(store.cart.length) return { error: "Finish, hold or clear the bill on the screen first." };
  const { lines, skipped } = orderCartLines(o, vid => vRec(vid) ? stockOf(vid) : null);
  if(!lines.length) return { error: "Nothing on this order can go on a bill now: " + skipped.map(s => `${s.name} (${s.why})`).join(", ") + "." };
  store.cart = lines.map(l => { const r = vRec(l.v);
    return { v: l.v, p: r.p.id, name: l.name || r.p.name, ...legacyCS(r.p.opts, r.v.o), vl: l.vl || vLabel(r.v), ov: optionSnapshot(r.p, r.v), sku: r.v.sku || "", q: l.q, price: l.price,
      cost: vCost(r.p, r.v), color: okColor(r.p.color), ...(l.disc ? { disc: l.disc } : {}), ord: o.id, oln: l.oln }; });
  store.disc = normalizeDiscount(o.billDisc) || null;
  store.cartCust = o.cust && o.cust.id ? { id: o.cust.id, name: o.cust.name, phone: o.cust.phone || "" } : null;
  store.cartOrder = { id: o.id, no: o.no, kind: o.kind };
  saveCart();
  return { lines, skipped };
}
/* After a bill made from an order was recorded: the order counts what the bill delivered (the order's bill list, partly
   delivered / completed; a quotation billed straight away is converted). → the order, or null */
export function fulfilFromSale(sale){
  if(!sale || !sale.order) return null;
  const o = orderRepository().get(sale.order); if(!o) return null;
  const sold = soldFromOrder(sale, o.id); if(!Object.keys(sold).length) return null;
  const next = fulfil(o, sold, sale.id, Date.now());
  orderRepository().save(next); upload();
  return next;
}
/* The bill on the screen no longer comes from its order (its lines stay, as ordinary lines) */
export function detachCartOrder(){
  store.cartOrder = null; store.cart = store.cart.map(c => { const x = { ...c }; delete x.ord; delete x.oln; return x; }); saveCart();
}
