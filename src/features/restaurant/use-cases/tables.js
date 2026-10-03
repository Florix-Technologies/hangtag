// Restaurant use cases: set up tables (and their QR codes), seat guests (a session), take orders for a table (orders of
// kind "table", sent to the kitchen), move them through the kitchen, and bill a table through the ordinary bill — the
// bill's discounts, GST, payments and receipt are the shop's usual ones; paying it closes the table's session, so the
// table is free again. Nothing here changes stock: only the bill does. Rules: domain/restaurant/tables.js.
// Permissions (the database checks them too): table setup manage_settings; seating and taking orders create_order /
// manage_tables (a server only while the shop has server ordering); the kitchen manage_kitchen; billing create_sale.
import { store } from '../../../shared/state/store.js';
import { checkTable, kitchenMoveOk, sessionBillLines, tokenFromBytes } from '../../../domain/restaurant/tables.js';
import { checkOrder } from '../../../domain/orders/orders.js';
import { legacyCS, optionSnapshot } from '../../../domain/catalog/options.js';
import { vCost, vLabel } from '../../../domain/catalog/variants.js';
import { tableRepository } from '../repositories/table-repository.js';
import { orderRepository } from '../../orders/repositories/order-repository.js';
import { nextOrderNo, orderLine } from '../../orders/use-cases/orders.js';
import { cartTable, kitchenOn, liveSessions, mayTakeTableOrder, mayWorkTables, ordersOfSessions, tableById, tableQrOn, tablesList, tablesOn } from '../services/restaurant-state.js';
import { vRec } from '../../inventory/services/ledger.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { okColor } from '../../../shared/utils/colors.js';
import { uid } from '../../../shared/utils/ids.js';
import { canAny, denied, notAllowedText, userId } from '../../shop/services/access.js';

const upload = () => { renderSync(); flushSbQueue(); };
const off = () => ({ error: "This shop doesn't use tables. Switch on Table ordering in Settings → Capabilities." });
const qrOff = () => ({ error: "This shop doesn't use table QR codes. Switch on Table QR in Settings → Capabilities." });
const kitchenOff = () => ({ error: "This shop doesn't use the kitchen screen. Switch on Kitchen in Settings → Capabilities." });
/* A new QR token for a table: 32 random bytes (the QR identifies the shop's table and nothing else) */
export function newTableToken(){ const b = new Uint8Array(32); crypto.getRandomValues(b); return tokenFromBytes(b); }

/* ---------- setting up tables ---------- */
/* input: { id?, name, area, seats, sort } → { table } or { error, field } */
export function saveTable(input){
  const no = denied("manage_settings", "set up tables"); if(no) return no;
  if(!tablesOn()) return off();
  const r = checkTable(input, tablesList(true)); if(r.error) return r;
  const prev = input && input.id ? tableById(input.id) : null;
  const t = { ...r.table, id: prev ? prev.id : "tb" + uid(), qr: prev && prev.qr || newTableToken(), t: prev ? prev.t : Date.now(), active: prev ? prev.active !== false : true };
  tableRepository().saveTable(t); upload();
  return { table: t };
}
/* Takes a table out of use (its QR stops working; its history stays). Never while guests are seated at it. */
export function archiveTable(id){
  const no = denied("manage_settings", "set up tables"); if(no) return no;
  if(!tablesOn()) return off();
  const t = tableById(id); if(!t) return { error: "That table wasn't found." };
  if(liveSessions(id).length) return { error: `Guests are seated at ${t.name}: bill them first.` };
  tableRepository().saveTable({ ...t, active: false }); upload();
  return { table: t };
}
export function restoreTable(id){
  const no = denied("manage_settings", "set up tables"); if(no) return no;
  if(!tablesOn()) return off();
  const t = tableById(id); if(!t) return { error: "That table wasn't found." };
  const r = checkTable({ ...t, active: true }, tablesList(true)); if(r.error) return r;
  tableRepository().saveTable({ ...t, active: true }); upload();
  return { table: t };
}
/* A new QR code for a table (the old one stops working: e.g. a printed card was taken away) */
export function resetTableQr(id){
  const no = denied("manage_settings", "set up tables"); if(no) return no;
  if(!tablesOn()) return off();
  if(!tableQrOn()) return qrOff();
  const t = tableById(id); if(!t) return { error: "That table wasn't found." };
  const next = { ...t, qr: newTableToken() };
  tableRepository().saveTable(next); upload();
  return { table: next };
}

/* ---------- guests at a table ---------- */
/* Seats guests at a table (a session), unless some are there already → { session } */
export function seatTable(tableId, { guests } = {}){
  if(!tablesOn()) return off();
  if(!mayWorkTables() || !canAny(["manage_tables", "create_order", "create_sale"])) return { error: notAllowedText("seat guests") };
  const t = tableById(tableId); if(!t || t.active === false) return { error: "That table isn't in use." };
  const cur = liveSessions(tableId)[0]; if(cur) return { session: cur };
  const n = guests == null || guests === "" ? null : Math.round(+guests);
  const s = { id: "ts" + uid(), table: tableId, status: "open", t: Date.now(), guests: Number.isFinite(n) && n > 0 && n < 100 ? n : null, user: userId(), dev: store.dev };
  tableRepository().saveSession(s); upload();
  return { session: s };
}
/* An order for a table: lines [{ v, q, note? }] at today's prices, sent to the kitchen (status "new"); the table's session
   is the one going on, or a new one. → { order, session } or { error } */
export function sendTableOrder(tableId, lines, note){
  if(!tablesOn()) return off();
  if(!mayTakeTableOrder()) return { error: notAllowedText("take table orders") };
  const t = tableById(tableId); if(!t || t.active === false) return { error: "That table isn't in use." };
  const items = [];
  for(const l of lines || []){
    if(!(+l.q > 0)) continue;
    const x = orderLine(l.v, l.q); if(!x) return { error: "An item on the order isn't in the catalog any more." };
    items.push({ ...x, ln: items.length, ...(String(l.note || "").trim() ? { note: String(l.note).trim().slice(0, 200) } : {}) });
  }
  const seat = seatTable(tableId); if(seat.error) return seat;
  const now = Date.now();
  const order = { id: "o" + uid(), kind: "table", no: nextOrderNo("table", now), status: "new", cust: null, billDisc: null, notes: String(note || "").trim().slice(0, 500),
    validUntil: "", source: "staff", convertedTo: null, saleIds: [], version: 0, t: now, updatedT: now, dev: store.dev, tableId, sessionId: seat.session.id, items,
    ...(userId() ? { user: userId() } : {}) };
  const bad = checkOrder(order); if(bad) return bad;
  orderRepository().save(order); upload();
  return { order, session: seat.session };
}
/* The kitchen moves an order along (accepted, preparing, ready), a server marks it served, or it is cancelled */
export function setTableOrderStatus(id, status){
  if(!tablesOn()) return off();
  const o = orderRepository().get(id); if(!o || o.kind !== "table") return { error: "That order isn't on this device." };
  const kitchen = ["accepted", "preparing", "ready"].includes(status);
  if(kitchen && !kitchenOn()) return kitchenOff();
  if(kitchen ? !canAny(["manage_kitchen", "create_order"]) : !canAny(["manage_kitchen", "create_order", "send_to_kitchen"])) return { error: notAllowedText("change table orders") };
  if(!kitchenMoveOk(o.status, status)) return { error: `A ${o.status} order can't become ${status}.` };
  if(o.status === status) return { order: o };
  const next = orderRepository().setStatus(id, status, Date.now()); upload();
  return { order: next };
}

/* ---------- billing a table: the ordinary bill ---------- */
/* Everything ordered at the table (not cancelled) goes on the bill, at the orders' prices; the table shows "Billing" until
   the bill is paid (then its session closes and the table is free) or taken off the screen. → { lines } or { error } */
export function billTable(tableId){
  const no = denied("create_sale", "bill tables"); if(no) return no;
  if(!tablesOn()) return off();
  const t = tableById(tableId); if(!t) return { error: "That table wasn't found." };
  const sessions = liveSessions(tableId); if(!sessions.length) return { error: `Nobody is seated at ${t.name}.` };
  if(store.cart.length) return { error: "Finish, hold or clear the bill on the screen first." };
  const lines = sessionBillLines(ordersOfSessions(sessions.map(s => s.id))).filter(l => vRec(l.v));
  if(!lines.length) return { error: `Nothing has been ordered at ${t.name} yet.` };
  store.cart = lines.map(l => { const r = vRec(l.v);
    return { v: l.v, p: r.p.id, name: l.name || r.p.name, ...legacyCS(r.p.opts, r.v.o), vl: l.vl || vLabel(r.v), ov: optionSnapshot(r.p, r.v), sku: r.v.sku || "", q: l.q, price: l.price,
      cost: vCost(r.p, r.v), color: okColor(r.p.color), ...(l.disc ? { disc: l.disc } : {}), ...(l.u && l.u !== "pcs" ? { u: l.u } : {}), ...(l.gst != null ? { gst: l.gst } : {}) }; });
  store.disc = null; store.cartCust = null; store.cartOrder = null;
  store.cartTable = { table: tableId, name: t.name, sessions: sessions.map(s => s.id) };
  sessions.forEach(s => { if(s.status !== "billing") tableRepository().saveSession({ ...s, status: "billing" }); });
  saveCart(); upload();
  return { lines };
}
/* The bill paid: the table's sessions close with it (the table is free), and orders the kitchen hadn't marked served are */
export function closeTableForSale(sale, ct){
  const c = ct || cartTable(); if(!c || !sale) return;
  const now = Date.now();
  (c.sessions || []).forEach(id => { const s = tableRepository().session(id); if(s && s.status !== "closed") tableRepository().saveSession({ ...s, status: "closed", closedT: now, sale: sale.id }); });
  orderRepository().closeSessionOrders(c.sessions || [], now);
  store.cartTable = null; saveCart(); upload();
}
/* The table's bill taken off the screen without being paid: the table goes back to its orders */
export function releaseTableBill(){
  const c = cartTable(); if(!c) return;
  (c.sessions || []).forEach(id => { const s = tableRepository().session(id); if(s && s.status === "billing") tableRepository().saveSession({ ...s, status: "open" }); });
  store.cartTable = null; saveCart(); upload();
}
