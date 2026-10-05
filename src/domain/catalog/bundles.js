// Kits (bundles): a product sold as one item that is really a few others ("Phone starter kit" = phone ×1 + case ×1 +
// charger ×1). The kit is an ordinary product with one variant (its own price, SKU and barcode, so it scans like
// anything else) and a list of components (product.bundle = [{ v: variant id, q: per kit }]). It has no stock of its own:
// how many kits can be sold is worked out from the components' stock. On the bill the kit is one line; when the bill is
// saved that line becomes one line per component (each with its share of the kit price, as a line discount), so the one
// stock ledger takes the components out, a return puts back exactly the components returned, and GST, cost and reports
// stay per item. The component lines remember their kit (kit: { v, p, name, n }) for the receipt and returns.
// Not manufacturing: no production orders, raw materials or work centres. Pure.
import { allocate, discountPaise, normalizeDiscount } from '../sales/discounts.js';
import { linePaise, sumP, toPaise, toRupees, tooPrecise } from '../sales/paise.js';
import { decimalsOf, roundQty } from './units.js';
import { inr, inrx } from '../../shared/formatting/money.js';

export const MAX_COMPONENTS = 20;
export const isKit = p => !!p && Array.isArray(p.bundle) && p.bundle.length > 0;
/* The components as kept: [{ v, q }] with a positive quantity, each variant once */
export function cleanBundle(list){
  const out = [], seen = new Set();
  (Array.isArray(list) ? list : []).forEach(c => {
    const v = c && String(c.v || ""), q = roundQty(+(c && c.q));
    if(!v || seen.has(v) || !(q > 0)) return;
    seen.add(v); out.push({ v, q });
  });
  return out;
}
/* The first problem with a kit before it is saved → { error, field, line? } or null.
   lookup(variant id) → { p, v } of the catalog or null · trackingOf(product) → "none" | "serial" | "batch" */
export function checkBundle(kit, lookup, trackingOf){
  const comps = kit && kit.bundle || [];
  if(!String(kit && kit.name || "").trim()) return { error: "Give the kit a name.", field: "name" };
  const price = +(kit && kit.price);
  if(!(Number.isFinite(price) && price > 0) || tooPrecise(price)) return { error: `Enter the kit's price (more than ${inr(0)}).`, field: "price" };
  if(!comps.length) return { error: "Add the items in the kit: scan them or search for them.", field: "bundle" };
  if(comps.length > MAX_COMPONENTS) return { error: `A kit can have up to ${MAX_COMPONENTS} items.`, field: "bundle" };
  const seen = new Set();
  for(const [i, c] of comps.entries()){
    const r = lookup ? lookup(c.v) : null;
    if(!r) return { error: `Item ${i + 1} of the kit isn't in the catalog any more.`, field: "bundle", line: i };
    const name = r.p.name;
    if(r.p.id === kit.id) return { error: "A kit can't contain itself.", field: "bundle", line: i };
    if(isKit(r.p)) return { error: `${name} is a kit itself. Add its items instead.`, field: "bundle", line: i };
    if(trackingOf && trackingOf(r.p) === "serial") return { error: `${name} is tracked by serial number. Sell it on its own, not in a kit.`, field: "bundle", line: i };
    if(seen.has(c.v)) return { error: `${name} is in the kit twice. Change its quantity instead.`, field: "bundle", line: i };
    seen.add(c.v);
    const q = +c.q, dp = decimalsOf(r.p.unit);
    if(!(Number.isFinite(q) && q > 0)) return { error: `${name}: enter how many go in one kit.`, field: "bundle", line: i };
    if(Math.abs(q * 10 ** dp - Math.round(q * 10 ** dp)) > 1e-6) return { error: dp ? `${name}: use at most ${dp} decimal places.` : `${name}: a kit holds whole pieces.`, field: "bundle", line: i };
  }
  return null;
}
/* How many kits can be sold now: the smallest number the components' stock allows (whole kits).
   availOf(variant id) → what can be sold of it now */
export function kitsAvailable(bundle, availOf){
  const comps = cleanBundle(bundle);
  if(!comps.length) return 0;
  return Math.max(0, Math.min(...comps.map(c => Math.floor(roundQty((+availOf(c.v) || 0) / c.q) + 1e-9))));
}
/* What bill lines need of each variant, kits counted as their components: { [variant id]: qty } */
export function demandOf(lines){
  const out = {};
  const add = (v, q) => { out[v] = roundQty((out[v] || 0) + q); };
  (lines || []).forEach(l => {
    if(Array.isArray(l.kit) && l.kit.length) l.kit.forEach(c => add(c.v, roundQty((+l.q || 0) * (+c.q || 0))));
    else if(l.v) add(l.v, +l.q || 0);
  });
  return out;
}
/* The components a kit line carries on the bill (a copy taken when it is added: a bill never changes when the catalog
   does). lookup(variant id) → { p, v, price (its selling price now), cost, unit, sku, vl, … } or null
   → { kit: [{ v, p, name, vl, q, price, cost, u?, sku }] } or { error } */
export function kitSnapshot(bundle, lookup){
  const out = [];
  for(const c of cleanBundle(bundle)){
    const r = lookup(c.v);
    if(!r) return { error: "An item of this kit isn't in the catalog any more. Edit the kit first." };
    out.push({ v: c.v, p: r.p, name: r.name, vl: r.vl || "", q: c.q, price: +r.price || 0, cost: r.cost == null ? null : +r.cost, ...(r.u && r.u !== "pcs" ? { u: r.u } : {}), sku: r.sku || "",
      ...(r.c ? { c: r.c } : {}), ...(r.s ? { s: r.s } : {}), ...(Array.isArray(r.ov) ? { ov: r.ov } : {}) });
  }
  return out.length ? { kit: out } : { error: "This kit has no items." };
}
/* Is a kit's price at most its items bought separately? (the kit's price is shared over them as a discount) */
export function kitPriceError(kitPrice, kit){
  const base = sumP((kit || []).map(c => linePaise(c.q, c.price)));
  return toPaise(kitPrice) > base ? `The kit costs more than its items bought separately (${inrx(toRupees(base))}). Lower the kit price or the items' prices.` : null;
}
/* Bill lines with every kit line turned into its component lines. A component line: the component's own price, the
   quantity for all kits on the line, and a fixed discount that is its share (by value) of what the kit saves — so the
   component lines together come to exactly what the kit line came to. A discount on the kit line is shared the same way.
   The kit is taxed at its own GST rate (one supply): rateOf(kit line) gives it, and every component line carries it.
   → { lines } or { error, line } */
export function explodeKits(lines,rateOf){
  const out = [];
  for(const [i, l] of (lines || []).entries()){
    if(!(Array.isArray(l.kit) && l.kit.length)){ out.push(l); continue; }
    const kits = +l.q || 0;
    const gross = linePaise(kits, l.price), kitNet = gross - discountPaise(l.disc, gross);
    const compGross = l.kit.map(c => linePaise(roundQty(kits * c.q), c.price)), base = sumP(compGross);
    if(kitNet > base) return { error: `${l.name}: ${kitPriceError(l.price, l.kit)}`, line: i };
    const off = allocate(base - kitNet, compGross);
    const meta = { v: l.v, p: l.p, name: l.name, n: kits }, rate = rateOf ? rateOf(l) : l.gst;
    l.kit.forEach((c, k) => {
      const d = off[k] > 0 ? { type: "fixed", value: toRupees(off[k]) } : null;
      out.push({ v: c.v, p: c.p, name: c.name, vl: c.vl || "", sku: c.sku || "", q: roundQty(kits * c.q), price: c.price, cost: c.cost == null ? null : c.cost,
        ...(c.u ? { u: c.u } : {}), ...(c.c ? { c: c.c } : {}), ...(c.s ? { s: c.s } : {}), ...(c.ov ? { ov: c.ov } : {}), ...(rate != null ? { gst: +rate } : {}),
        ...(normalizeDiscount(d) ? { disc: d } : {}), ...(l.ord ? { ord: l.ord, oln: l.oln } : {}), kit: meta });
    });
  }
  return { lines: out };
}
/* Bill lines grouped back into their kits for showing (receipt, bill view, returns):
   → [{ kit: { v, p, name, n } | null, lines: [line] }] in bill order */
export function groupByKit(items){
  const out = [];
  (items || []).forEach(it => {
    const k = it && it.kit && typeof it.kit === "object" && !Array.isArray(it.kit) ? it.kit : null;
    const last = out[out.length - 1];
    if(k && last && last.kit && last.kit.v === k.v && last.kit.n === k.n && last.lines.every(x => x.kit.v === k.v)) last.lines.push(it);
    else out.push({ kit: k, lines: [it] });
  });
  return out;
}
