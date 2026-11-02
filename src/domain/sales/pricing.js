// Price lists: ONE resolver for every place that puts a price on a line (the till, quotations, sales orders, the mobile
// store and the assisted cart; the database repeats it in hangtag_list_price, supabase/schema.sql section 3r).
// A price list is a named set of prices ("Retail", "Wholesale", "Distributor" …): a price for a whole product, or for one
// variant (a variant's price wins over its product's). One list may be the shop's default. A list can be switched off, and
// can have a first and a last day. A customer can have their own list.
// Which price a line gets, in this order — the first list that is in use today AND has a price for the item:
//   1. the customer's own list   2. the list chosen on the bill   3. the shop's default list   4. the item's own selling price
// Never ₹0 by accident: a list without a price for the item falls through to the next step, and a stored price is always
// above 0. A bill keeps the price it was sold at: changing a list later never changes a saved bill.
// Pure; rupees in and out.
import { tooPrecise } from './paise.js';
import { inr, numberText } from '../../shared/formatting/money.js';

export const PRICE_LIST_SUGGESTIONS = ["Retail", "Wholesale", "Distributor", "Special"];
export const MAX_LISTS = 20;
export const MAX_PRICES = 5000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/* Keys of the prices map: "p:<product id>" for a whole product, "v:<variant id>" for one variant */
export const productKey = id => "p:" + id;
export const variantKey = id => "v:" + id;

/* A list as kept: { id, name, isDefault, active, from ("yyyy-mm-dd" | ""), to, prices: { "p:…"|"v:…": rupees }, version, t } */
export function normalizeList(l){
  const prices = {};
  Object.entries(l && l.prices && typeof l.prices === "object" ? l.prices : {}).forEach(([k, v]) => {
    const n = +v;
    if(/^[pv]:.{1,64}$/.test(k) && Number.isFinite(n) && n > 0) prices[k] = Math.round(n * 100) / 100;
  });
  return { id: String(l && l.id || ""), name: String(l && l.name || "").trim().replace(/\s+/g, " "), isDefault: !!(l && l.isDefault), active: !(l && l.active === false),
    from: DAY_RE.test(l && l.from || "") ? l.from : "", to: DAY_RE.test(l && l.to || "") ? l.to : "", prices, version: +(l && l.version) || 0, t: +(l && l.t) || 0 };
}
/* The first problem with a list before it is saved → { error, field, key? } or null. others: the shop's other lists */
export function checkPriceList(l, others){
  const name = String(l && l.name || "").trim();
  if(!name) return { error: "Give the price list a name, like Wholesale.", field: "name" };
  if(name.length > 40) return { error: "Keep the name to 40 characters.", field: "name" };
  const rest = (others || []).filter(o => o.id !== l.id);
  if(rest.some(o => o.name.trim().toLowerCase() === name.toLowerCase())) return { error: `There is already a price list called ${name}.`, field: "name" };
  if(!l.id && rest.length >= MAX_LISTS) return { error: `A shop can have up to ${MAX_LISTS} price lists.`, field: "name" };
  if(l.from && !DAY_RE.test(l.from)) return { error: "Enter the first day as a date.", field: "from" };
  if(l.to && !DAY_RE.test(l.to)) return { error: "Enter the last day as a date.", field: "to" };
  if(l.from && l.to && l.to < l.from) return { error: "The last day is before the first day.", field: "to" };
  if(l.isDefault && l.active === false) return { error: "The default price list must be in use. Choose another default first.", field: "active" };
  const entries = Object.entries(l.prices || {});
  if(entries.length > MAX_PRICES) return { error: `A price list can have up to ${numberText(MAX_PRICES)} prices.`, field: "prices" };
  for(const [k, v] of entries){
    const n = +v;
    if(!/^[pv]:/.test(k)) return { error: "A price is for a product or a variant.", field: "prices", key: k };
    if(!(Number.isFinite(n) && n > 0)) return { error: `Every price on a list must be more than ${inr(0)}. Remove the item to use its normal price.`, field: "prices", key: k };
    if(tooPrecise(n)) return { error: "Use at most 2 decimal places in a price.", field: "prices", key: k };
    if(n > 10000000) return { error: "That price is too large.", field: "prices", key: k };
  }
  return null;
}
/* Is the list in use on this day ("yyyy-mm-dd")? */
export const listLive = (l, day) => !!l && l.active !== false && (!l.from || !day || day >= l.from) && (!l.to || !day || day <= l.to);
/* The shop's default list (the one marked, if it is in use) */
export const defaultList = (lists, day) => (lists || []).find(l => l.isDefault && listLive(l, day)) || null;
/* A list's own price for a variant (its variant price, else its product price), or null */
export function listPriceOf(l, productId, variantId){
  if(!l || !l.prices) return null;
  const v = variantId != null ? +l.prices[variantKey(variantId)] : NaN;
  if(Number.isFinite(v) && v > 0) return v;
  const p = productId != null ? +l.prices[productKey(productId)] : NaN;
  return Number.isFinite(p) && p > 0 ? p : null;
}
/* The price of one item.
   ctx: { lists, customerListId, selectedListId, day ("yyyy-mm-dd") } · base: the item's own selling price (rupees)
   → { price, base, listId, listName, source: "customer" | "selected" | "default" | "product" } */
export function resolvePrice(productId, variantId, base, ctx){
  const c = ctx || {}, lists = c.lists || [], day = c.day || "";
  const byId = id => id ? lists.find(l => l.id === id) || null : null;
  const steps = [["customer", byId(c.customerListId)], ["selected", byId(c.selectedListId)], ["default", defaultList(lists, day)]];
  const seen = new Set();
  for(const [source, l] of steps){
    if(!l || seen.has(l.id) || !listLive(l, day)) continue;
    seen.add(l.id);
    const p = listPriceOf(l, productId, variantId);
    if(p != null) return { price: p, base: +base || 0, listId: l.id, listName: l.name, source };
  }
  return { price: +base || 0, base: +base || 0, listId: null, listName: "", source: "product" };
}
/* The list that decides prices on a bill right now (what the till shows): the customer's own list, else the one chosen,
   else the default → { list, locked (the customer's list: it can't be changed while that customer is on the bill) } */
export function activeList(ctx){
  const c = ctx || {}, lists = c.lists || [], day = c.day || "";
  const live = id => { const l = id ? lists.find(x => x.id === id) : null; return listLive(l, day) ? l : null; };
  const cust = live(c.customerListId);
  if(cust) return { list: cust, locked: true };
  return { list: live(c.selectedListId) || defaultList(lists, day), locked: false };
}
/* Lists a person can choose on a bill (in use today), the default first */
export const choosableLists = (lists, day) => (lists || []).filter(l => listLive(l, day)).sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name));
/* A list with one product/variant price set (price > 0) or removed (price empty / null) → the new list (a copy) */
export function setListPrice(l, key, price){
  const prices = { ...(l.prices || {}) };
  if(price == null || String(price).trim() === "") delete prices[key];
  else prices[key] = Math.round(+price * 100) / 100;
  return { ...l, prices };
}
/* Lists after one of them becomes the default: at most one default per shop → [lists] (copies of those that changed) */
export const withDefault = (lists, id) => (lists || []).map(l => (l.id === id) === !!l.isDefault ? l : { ...l, isDefault: l.id === id });
