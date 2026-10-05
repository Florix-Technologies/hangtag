// A purchase plan within a budget, from Smart reorder's suggestion (pure; nothing is ordered here). Which lines to buy
// first when the money doesn't stretch to everything:
//   1. what is sold out or runs out soonest (days of stock left, at the forecast rate when there is one)
//   2. then the better margin for each rupee spent
// A line that doesn't fit whole is bought in part (as many units as the money left buys); one that doesn't fit at all
// waits (skipped). Lines without a cost price can't be priced, so they are listed apart — never guessed.
// lines: [{ v, p, name, vl, u?, q, price (cost each, or null), days (stock left, or null), sell (selling price, or null),
//          supplierId, supplier }]
import { decimalsOf, roundQty } from '../catalog/units.js';

const money = n => Math.round((+n || 0) * 100) / 100;
const marginRate = l => l.sell > 0 && l.price > 0 ? (l.sell - l.price) / l.price : 0;
const urgency = l => l.days == null ? Infinity : Math.max(0, +l.days);

/* → { budget, lines (to buy, in priority order, with cost; partial ones keep wanted), total, left, skipped, unknownCost } */
export function purchasePlan(lines, budget = null){
  const known = (lines || []).filter(l => l && +l.q > 0 && l.price != null && +l.price > 0);
  const unknownCost = (lines || []).filter(l => l && +l.q > 0 && !(l.price != null && +l.price > 0));
  known.sort((a, b) => urgency(a) - urgency(b) || marginRate(b) - marginRate(a) || String(a.name).localeCompare(String(b.name)));
  const cap = budget == null || budget === "" ? Infinity : Math.max(0, +budget || 0);
  let left = cap;
  const take = [], skipped = [];
  for(const l of known){
    const cost = money(l.q * l.price);
    if(cost <= left + 1e-9){ take.push({ ...l, cost }); left = money(left - cost); continue; }
    const f = 10 ** decimalsOf(l.u || "pcs"), q = roundQty(Math.floor(left / l.price * f + 1e-9) / f);
    if(q > 0){ const c = money(q * l.price); take.push({ ...l, q, wanted: l.q, partial: true, cost: c }); left = money(left - c); }
    else skipped.push(l);
  }
  const total = money(take.reduce((n, l) => n + l.cost, 0));
  return { budget: cap === Infinity ? null : cap, lines: take, total, left: cap === Infinity ? null : money(left), skipped, unknownCost };
}
/* The plan's lines by supplier (those with a supplier can become draft purchase orders): [{ supplierId, supplier, items, total }] */
export function planBySupplier(plan){
  const m = new Map();
  plan.lines.forEach(l => { const k = l.supplierId || ""; const g = m.get(k) || { supplierId: l.supplierId || null, supplier: l.supplier || "", items: [], total: 0 }; g.items.push(l); g.total = money(g.total + l.cost); m.set(k, g); });
  return [...m.values()].sort((a, b) => (a.supplierId == null) - (b.supplierId == null) || b.total - a.total);
}
