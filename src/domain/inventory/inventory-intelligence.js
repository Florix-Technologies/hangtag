// Deterministic inventory intelligence over the existing product catalog and stock ledger.
// It never changes inventory or creates a purchase. A future recommender may explain or reprioritise these signals,
// but quantities and money here always come from this pure calculation.
import { vCost, vLabel, vPrice, variantsOf } from '../catalog/variants.js';
import { decimalsOf, roundQty, sumQty } from '../catalog/units.js';

const DAY = 864e5;
const SALE_TYPES = new Set(['SALE', 'EXCHANGE_OUT']);
const RETURN_TYPES = new Set(['RETURN', 'EXCHANGE_IN', 'NOT_FOR_RESALE']);

export const DEFAULT_INTELLIGENCE_CONFIG = Object.freeze({
  velocityDays: 30,
  trendDays: 14,
  leadDays: 7,
  safetyDays: 3,
  targetCoverDays: 21,
  slowDays: 30,
  deadDays: 90,
  slowCoverDays: 60,
  minFastUnits: 5,
});

const finite = (n, fallback = 0) => Number.isFinite(+n) ? +n : fallback;
const money = n => Math.round(finite(n) * 100) / 100;
const r1 = n => Math.round(finite(n) * 10) / 10;
const elapsedDays = (now, t) => t == null ? null : r1(Math.max(0, now - t) / DAY);
const validDays = (value, fallback, min = 1) => Math.max(min, Math.round(finite(value, fallback)));
const ceilUnitQty = (q, unit) => { const dp = decimalsOf(unit), f = 10 ** dp; return roundQty(Math.ceil(finite(q) * f - 1e-9) / f, dp); };

function settings(config){
  const c = Object.assign({}, DEFAULT_INTELLIGENCE_CONFIG, config || {});
  c.velocityDays = validDays(c.velocityDays, DEFAULT_INTELLIGENCE_CONFIG.velocityDays);
  c.trendDays = validDays(c.trendDays, DEFAULT_INTELLIGENCE_CONFIG.trendDays);
  c.leadDays = validDays(c.leadDays, DEFAULT_INTELLIGENCE_CONFIG.leadDays, 0);
  c.safetyDays = validDays(c.safetyDays, DEFAULT_INTELLIGENCE_CONFIG.safetyDays, 0);
  c.targetCoverDays = Math.max(c.leadDays + c.safetyDays, validDays(c.targetCoverDays, DEFAULT_INTELLIGENCE_CONFIG.targetCoverDays));
  c.slowDays = validDays(c.slowDays, DEFAULT_INTELLIGENCE_CONFIG.slowDays);
  c.deadDays = Math.max(c.slowDays, validDays(c.deadDays, DEFAULT_INTELLIGENCE_CONFIG.deadDays));
  c.slowCoverDays = validDays(c.slowCoverDays, DEFAULT_INTELLIGENCE_CONFIG.slowCoverDays);
  c.minFastUnits = Math.max(0, finite(c.minFastUnits, DEFAULT_INTELLIGENCE_CONFIG.minFastUnits));
  return c;
}

/* Gross sale pieces less returned pieces in a period. A not-for-resale return still reverses demand even though it did not
   add stock. Clamping prevents an old sale returned inside this window from creating negative demand. */
function demand(entries, from, to){
  let sold = 0, returned = 0;
  (entries || []).forEach(e => {
    const t = finite(e && e.t, -Infinity);
    if(t < from || t > to) return;
    const pieces = Math.abs(finite(e.pieces, e.q));
    if(SALE_TYPES.has(e.type)) sold += pieces;
    else if(RETURN_TYPES.has(e.type)) returned += pieces;
  });
  return { sold: roundQty(sold), returned: roundQty(returned), net: roundQty(Math.max(0, sold - returned)) };
}

/* Age only what is still on the shelf. Outgoing entries consume the oldest positive lots first. If historical records
   briefly went below zero, later incoming stock first settles that deficit instead of pretending it is a fresh lot. */
function remainingLots(entries){
  const lots = [];
  let deficit = 0;
  [...(entries || [])].sort((a, b) => finite(a.t) - finite(b.t) || String(a.id || '').localeCompare(String(b.id || ''))).forEach(e => {
    let q = roundQty(e && e.q);
    if(q > 0){
      if(deficit){ const used = Math.min(deficit, q); deficit = roundQty(deficit - used); q = roundQty(q - used); }
      if(q > 0) lots.push({ q, t: finite(e.t) });
      return;
    }
    let need = -q;
    while(need > 0 && lots.length){
      const lot = lots[0], used = Math.min(lot.q, need);
      lot.q = roundQty(lot.q - used); need = roundQty(need - used);
      if(lot.q <= 0) lots.shift();
    }
    if(need > 0) deficit = roundQty(deficit + need);
  });
  return lots;
}

function ageOf(entries, now){
  const lots = remainingLots(entries), qty = sumQty(lots.map(l => l.q));
  if(qty <= 0) return { stockAgeDays: null, oldestStockAgeDays: null };
  const weighted = lots.reduce((n, l) => n + l.q * Math.max(0, now - l.t) / DAY, 0) / qty;
  const oldest = lots.reduce((n, l) => Math.max(n, Math.max(0, now - l.t) / DAY), 0);
  return { stockAgeDays: r1(weighted), oldestStockAgeDays: r1(oldest) };
}

function trendOf(recent, prior){
  if(recent <= 0 && prior <= 0) return { trend: 'none', trendPercent: null };
  if(prior <= 0) return { trend: 'new', trendPercent: null };
  const pct = r1((recent - prior) / prior * 100);
  return { trend: pct > 20 ? 'rising' : pct < -20 ? 'falling' : 'steady', trendPercent: pct };
}

function reasonFor(row){
  if(row.shouldReorder){
    if(row.currentStock <= 0) return row.trend === 'rising' || row.trend === 'new' ? 'Sold out with growing demand' : 'Sold out with recent sales';
    const left = row.daysRemaining == null ? '' : `${row.daysRemaining} day${row.daysRemaining === 1 ? '' : 's'} left`;
    if(row.trend === 'rising') return `${left} · demand up ${Math.max(0, row.trendPercent || 0)}%`;
    if(row.trend === 'new') return `${left} · new demand`;
    return `${left} at recent sales velocity`;
  }
  if(row.deadStock) return row.lastSale == null ? `No sale recorded; stock is ${row.oldestStockAgeDays} days old` : `No sale for ${row.daysSinceLastSale} days`;
  if(row.slowMoving) return row.salesVelocity > 0 ? `${row.daysRemaining} days of stock at current velocity` : `No sale in the last ${row.config.velocityDays} days`;
  if(row.fastMoving) return row.trend === 'rising' ? 'Fast-moving and demand is rising' : 'Among the fastest-moving products';
  return 'Stock is within the calculated range';
}

function variantSignal(p, v, entries, now, c){
  const stock = roundQty(entries.reduce((n, e) => n + finite(e.q), 0));
  const currentStock = stock;
  const recent = demand(entries, now - c.velocityDays * DAY, now);
  const trendRecent = demand(entries, now - c.trendDays * DAY, now).net;
  const trendPrior = demand(entries, now - c.trendDays * 2 * DAY, now - c.trendDays * DAY - 1).net;
  const salesVelocity = roundQty(recent.net / c.velocityDays);
  const lastSale = entries.reduce((t, e) => SALE_TYPES.has(e.type) ? Math.max(t || 0, finite(e.t)) : t, null);
  const ages = ageOf(entries, now), currentPositive = Math.max(0, currentStock);
  const daysRemaining = salesVelocity > 0 ? r1(currentPositive / salesVelocity) : null;
  const reorderPoint = salesVelocity > 0 ? ceilUnitQty(salesVelocity * (c.leadDays + c.safetyDays), p.unit) : 0;
  const shouldReorder = salesVelocity > 0 && currentStock <= reorderPoint;
  const suggestedReorderQty = shouldReorder ? ceilUnitQty(Math.max(0, salesVelocity * c.targetCoverDays - currentStock), p.unit) : 0;
  const daysSinceLastSale = elapsedDays(now, lastSale), price = vPrice(p, v), cost = vCost(p, v);
  const deadStock = currentPositive > 0 && ((lastSale == null && ages.oldestStockAgeDays != null && ages.oldestStockAgeDays >= c.deadDays) || (daysSinceLastSale != null && daysSinceLastSale >= c.deadDays));
  const slowMoving = !deadStock && currentPositive > 0 && ((salesVelocity <= 0 && ages.oldestStockAgeDays != null && ages.oldestStockAgeDays >= c.slowDays) || (daysRemaining != null && daysRemaining > c.slowCoverDays));
  return {
    id: v.id,
    productId: p.id,
    label: vLabel(v) || (variantsOf(p).length > 1 ? 'One size' : ''),
    sku: v.sku || '',
    currentStock,
    soldUnits: recent.sold,
    returnedUnits: recent.returned,
    netUnitsSold: recent.net,
    salesVelocity,
    trendRecentUnits: trendRecent,
    trendPriorUnits: trendPrior,
    ...trendOf(trendRecent, trendPrior),
    lastSale,
    daysSinceLastSale,
    ...ages,
    daysRemaining,
    reorderPoint,
    shouldReorder,
    suggestedReorderQty,
    slowMoving,
    deadStock,
    fastMoving: false,
    price,
    cost,
    inventoryValue: money(currentPositive * price),
    inventoryCost: cost == null ? null : money(currentPositive * cost),
    marginOpportunity: cost == null ? null : money(currentPositive * (price - cost)),
    reorderCost: cost == null ? null : money(suggestedReorderQty * cost),
    reorderMarginOpportunity: cost == null ? null : money(suggestedReorderQty * (price - cost)),
    config: c,
  };
}

function combineProduct(p, variants, c, now){
  const currentStock = sumQty(variants.map(v => v.currentStock));
  const availableStock = sumQty(variants.map(v => Math.max(0, v.currentStock)));
  const netUnitsSold = sumQty(variants.map(v => v.netUnitsSold));
  const salesVelocity = roundQty(netUnitsSold / c.velocityDays);
  const recent = sumQty(variants.map(v => v.trendRecentUnits)), prior = sumQty(variants.map(v => v.trendPriorUnits));
  const lastSale = variants.reduce((t, v) => v.lastSale == null ? t : Math.max(t || 0, v.lastSale), null);
  const stockWeight = variants.reduce((n, v) => n + Math.max(0, v.currentStock), 0);
  const weightedAge = key => stockWeight ? r1(variants.reduce((n, v) => n + (v[key] == null ? 0 : v[key] * Math.max(0, v.currentStock)), 0) / stockWeight) : null;
  const oldestStockAgeDays = variants.reduce((n, v) => v.oldestStockAgeDays == null ? n : Math.max(n == null ? 0 : n, v.oldestStockAgeDays), null);
  const daysRemaining = salesVelocity > 0 ? r1(availableStock / salesVelocity) : null;
  const covers = variants.filter(v => v.daysRemaining != null).map(v => v.daysRemaining);
  const inventoryValue = money(variants.reduce((n, v) => n + v.inventoryValue, 0));
  const knownValue = money(variants.reduce((n, v) => n + (v.inventoryCost == null ? 0 : v.inventoryValue), 0));
  const missingCost = variants.some(v => v.currentStock > 0 && v.inventoryCost == null);
  const stocked = variants.filter(v => v.currentStock > 0), slow = stocked.filter(v => v.slowMoving), dead = stocked.filter(v => v.deadStock);
  const row = {
    id: p.id,
    name: p.name || 'Unnamed product',
    category: p.cat || '',
    unit: p.unit || 'pcs',
    variants,
    currentStock,
    availableStock,
    soldUnits: sumQty(variants.map(v => v.soldUnits)),
    returnedUnits: sumQty(variants.map(v => v.returnedUnits)),
    netUnitsSold,
    salesVelocity,
    trendRecentUnits: recent,
    trendPriorUnits: prior,
    ...trendOf(recent, prior),
    lastSale,
    daysSinceLastSale: elapsedDays(now, lastSale),
    stockAgeDays: weightedAge('stockAgeDays'),
    oldestStockAgeDays,
    daysRemaining,
    lowestDaysRemaining: covers.length ? Math.min(...covers) : null,
    reorderPoint: sumQty(variants.map(v => v.reorderPoint)),
    shouldReorder: variants.some(v => v.shouldReorder),
    suggestedReorderQty: sumQty(variants.map(v => v.suggestedReorderQty)),
    slowMoving: slow.length > 0 && !variants.some(v => v.shouldReorder),
    hasSlowStock: slow.length > 0,
    slowStockVariants: slow.length,
    deadStock: stocked.length > 0 && stocked.every(v => v.deadStock),
    hasDeadStock: dead.length > 0,
    deadStockVariants: dead.length,
    deadStockValue: money(dead.reduce((n, v) => n + v.inventoryValue, 0)),
    fastMoving: false,
    inventoryValue,
    inventoryCost: money(variants.reduce((n, v) => n + (v.inventoryCost || 0), 0)),
    marginOpportunity: money(variants.reduce((n, v) => n + (v.marginOpportunity || 0), 0)),
    marginComplete: !missingCost,
    marginCoverage: inventoryValue > 0 ? r1(knownValue / inventoryValue * 100) : 100,
    reorderCost: money(variants.reduce((n, v) => n + (v.reorderCost || 0), 0)),
    reorderCostComplete: !variants.some(v => v.suggestedReorderQty > 0 && v.reorderCost == null),
    reorderMarginOpportunity: money(variants.reduce((n, v) => n + (v.reorderMarginOpportunity || 0), 0)),
    config: c,
  };
  return row;
}

function fastThreshold(rows, c){
  const eligible = rows.filter(r => r.netUnitsSold >= c.minFastUnits && r.salesVelocity > 0).map(r => r.salesVelocity).sort((a, b) => a - b);
  if(!eligible.length) return Infinity;
  return eligible[Math.max(0, Math.ceil(eligible.length * .75) - 1)];
}

function summaryOf(rows){
  const stocked = rows.filter(r => r.inventoryValue > 0), knownValue = stocked.reduce((n, r) => n + r.inventoryValue * r.marginCoverage / 100, 0);
  const inventoryValue = money(rows.reduce((n, r) => n + r.inventoryValue, 0));
  return {
    products: rows.length,
    reorderProducts: rows.filter(r => r.shouldReorder).length,
    reorderVariants: rows.reduce((n, r) => n + r.variants.filter(v => v.shouldReorder).length, 0),
    fastMoving: rows.filter(r => r.fastMoving).length,
    slowMoving: rows.filter(r => r.hasSlowStock).length,
    slowStockVariants: rows.reduce((n, r) => n + r.slowStockVariants, 0),
    deadStock: rows.filter(r => r.hasDeadStock).length,
    deadStockVariants: rows.reduce((n, r) => n + r.deadStockVariants, 0),
    inventoryValue,
    inventoryCost: money(rows.reduce((n, r) => n + r.inventoryCost, 0)),
    marginOpportunity: money(rows.reduce((n, r) => n + r.marginOpportunity, 0)),
    marginCoverage: inventoryValue > 0 ? r1(knownValue / inventoryValue * 100) : 100,
    deadStockValue: money(rows.reduce((n, r) => n + r.deadStockValue, 0)),
    reorderCost: money(rows.reduce((n, r) => n + r.reorderCost, 0)),
    reorderCostComplete: rows.every(r => r.reorderCostComplete),
  };
}

/* Public read-only API. Entries are the existing stock ledger; products are the existing catalog. */
export function analyzeInventory({ products = [], entries = [], now = Date.now(), config } = {}){
  const c = settings(config), byVariant = new Map();
  (entries || []).forEach(e => { if(e && e.vid){ const list = byVariant.get(e.vid) || []; list.push(e); byVariant.set(e.vid, list); } });
  const rows = (products || []).filter(p => p && !p.archived).map(p => combineProduct(p, variantsOf(p).map(v => variantSignal(p, v, byVariant.get(v.id) || [], now, c)), c, now));
  const threshold = fastThreshold(rows, c);
  rows.forEach(row => {
    row.fastMoving = row.salesVelocity >= threshold;
    row.variants.forEach(v => { v.fastMoving = row.fastMoving && v.salesVelocity > 0; v.reason = reasonFor(v); delete v.config; });
    const urgent = row.variants.filter(v => v.shouldReorder).sort((a, b) => (a.daysRemaining == null ? Infinity : a.daysRemaining) - (b.daysRemaining == null ? Infinity : b.daysRemaining))[0];
    row.reason = urgent ? `${urgent.label ? urgent.label + ': ' : ''}${urgent.reason}` : reasonFor(row);
    delete row.config;
  });
  rows.sort((a, b) => Number(b.shouldReorder) - Number(a.shouldReorder) || (a.daysRemaining == null ? Infinity : a.daysRemaining) - (b.daysRemaining == null ? Infinity : b.daysRemaining) || b.salesVelocity - a.salesVelocity || a.name.localeCompare(b.name));
  return { generatedAt: now, config: c, products: rows, summary: summaryOf(rows) };
}
