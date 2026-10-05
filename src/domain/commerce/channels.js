// Unified commerce: one shop selling through several channels — the counter, the online store (customers ordering from
// their phone), sales orders taken by staff, dine-in tables (guests' QR orders included) and events / pop-ups — on one
// catalog, one stock and one set of books. A bill's channel comes from what it already records (its table, its order and
// where that order came from, its event): nothing new is stored. Stock that online-store customers ordered and that isn't
// billed yet is reserved for them — exactly as the database counts it (hangtag_mobile_reserved), which refuses a counter
// bill that would take it — so the till doesn't sell it first. Pure.
import { isFinal, remaining } from '../orders/orders.js';

export const CHANNELS = Object.freeze([
  Object.freeze({ key: "counter", label: "Counter" }),
  Object.freeze({ key: "online", label: "Online store" }),
  Object.freeze({ key: "orders", label: "Sales orders" }),
  Object.freeze({ key: "dinein", label: "Dine-in" }),
  Object.freeze({ key: "event", label: "Events & pop-ups" }),
]);
export const channelLabel = k => (CHANNELS.find(c => c.key === k) || CHANNELS[0]).label;

/* orderOf(id) → the order (or null when it isn't on this device: then a staff order is assumed) */
export function channelOf(sale, orderOf = () => null){
  if(!sale) return "counter";
  if(sale.table) return "dinein";
  if(sale.order){ const o = orderOf(sale.order); return o && o.kind === "table" ? "dinein" : o && o.source === "customer" ? "online" : "orders"; }
  if(sale.event) return "event";
  return "counter";
}
/* The period's bills and returns by channel → [{ key, label, ...summarize(live, rets) }] for the channels that sold,
   in CHANNELS order. A return goes to its bill's channel (saleOf finds a bill from before the period). */
export function byChannel(live, rets, { orderOf = () => null, saleOf = () => null, summarize }){
  const groups = new Map(), of = new Map();
  const g = k => groups.get(k) || (groups.set(k, { live: [], rets: [] }), groups.get(k));
  (live || []).forEach(s => { const k = channelOf(s, orderOf); of.set(s.id, k); g(k).live.push(s); });
  (rets || []).forEach(r => { const k = of.get(r.sale) || channelOf(saleOf(r.sale), orderOf); g(k).rets.push(r); });
  return CHANNELS.filter(c => groups.has(c.key)).map(c => ({ key: c.key, label: c.label, ...summarize(groups.get(c.key).live, groups.get(c.key).rets) }));
}
/* Pieces online-store customers ordered (open orders) and not billed yet, by variant: Map(variantId → qty).
   except: the order being billed now (its own lines may take its reservation) */
export const isOnlineOrder = o => !!o && o.kind === "sales" && o.source === "customer";
export function reservedByOrders(orders, { except = null } = {}){
  const m = new Map();
  (orders || []).forEach(o => {
    if(!isOnlineOrder(o) || isFinal(o) || (except && o.id === except)) return;
    (o.items || []).forEach(l => { const q = remaining(l); if(l.v && q > 0) m.set(l.v, Math.round(((m.get(l.v) || 0) + q) * 1000) / 1000); });
  });
  return m;
}
