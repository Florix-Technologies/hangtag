// Smart Reorder: deterministic signals over the existing catalog and ledger, and a provider seam that cannot mutate stock.
import { analyzeInventory } from '../../src/domain/inventory/inventory-intelligence.js';
import { createInventoryRecommender, inventoryIntelligence } from '../../src/features/inventory/services/inventory-intelligence.js';
import { renderSmartReorder } from '../../src/features/inventory/pages/smart-reorder-page.js';
import { store } from '../../src/shared/state/store.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if(ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const DAY = 864e5, now = 1800000000000;
const ago = n => now - n * DAY;
const product = (id, name, price, cost, extra = {}) => ({ id, name, price, cost, unit: 'pcs', variants: [{ id: id + ':', o: [], active: true }], ...extra });
const move = (id, vid, q, days, type = 'OPENING', pieces = Math.abs(q)) => ({ id, vid, q, pieces, t: ago(days), type });

const products = [
  product('cable', 'USB Cable', 500, 200),
  product('slow', 'Slow Case', 300, null),
  product('dead', 'Old Charger', 100, 60),
  product('aged', 'Mixed-age Stock', 250, 100),
  product('fresh', 'Fresh Stock', 150, 75),
  product('hidden', 'Archived', 999, 100, { archived: true }),
];
const entries = [
  move('c0', 'cable:', 98, 100),
  move('c1', 'cable:', -30, 20, 'SALE'),
  move('c2', 'cable:', -60, 5, 'SALE'),
  move('s0', 'slow:', 20, 50),
  move('s1', 'slow:', -1, 25, 'SALE'),
  move('d0', 'dead:', 10, 130),
  move('d1', 'dead:', -1, 100, 'SALE'),
  move('a0', 'aged:', 10, 100),
  move('a1', 'aged:', -7, 80, 'SALE'),
  move('a2', 'aged:', 5, 10, 'RESTOCK'),
  move('f0', 'fresh:', 4, 5),
  move('h0', 'hidden:', 2, 2),
];
const result = analyzeInventory({ products, entries, now });
const cable = result.products.find(r => r.id === 'cable');
const slow = result.products.find(r => r.id === 'slow');
const dead = result.products.find(r => r.id === 'dead');
const aged = result.products.find(r => r.id === 'aged');
const fresh = result.products.find(r => r.id === 'fresh');

check('current stock and 30-day velocity use the existing ledger', cable.currentStock === 8 && cable.netUnitsSold === 90 && cable.salesVelocity === 3, cable);
check('recent-vs-prior trend is deterministic', cable.trend === 'rising' && cable.trendPercent === 100 && cable.daysSinceLastSale === 5, cable);
check('days remaining, reorder point and suggested quantity use configured cover', cable.daysRemaining === 2.7 && cable.reorderPoint === 30 && cable.suggestedReorderQty === 55 && cable.shouldReorder, cable);
check('recommendation explains the calculated signals', cable.reason === '2.7 days left · demand up 100%', cable.reason);
check('fast mover is the qualifying top-quartile velocity, not every item that sold', cable.fastMoving && !slow.fastMoving, result.products.map(r => [r.id, r.fastMoving]));
check('slow stock is separate from dead stock', slow.slowMoving && !slow.deadStock && !dead.slowMoving && dead.deadStock, { slow, dead });
check('fresh stock with no sale is not prematurely called slow or dead', !fresh.slowMoving && !fresh.deadStock && fresh.salesVelocity === 0, fresh);
check('FIFO ageing measures only stock still on hand', aged.currentStock === 8 && aged.stockAgeDays === 43.8 && aged.oldestStockAgeDays === 100, aged);
check('inventory value and known-cost margin are explicit', cable.inventoryValue === 4000 && cable.inventoryCost === 1600 && cable.marginOpportunity === 2400 && cable.reorderMarginOpportunity === 16500, cable);
check('missing costs reduce margin coverage instead of inventing margin', slow.inventoryCost === 0 && !slow.marginComplete && slow.marginCoverage === 0 && result.summary.marginCoverage > 0 && result.summary.marginCoverage < 100, result.summary);
check('summary highlights reorder and dead-stock value', result.summary.reorderProducts === 1 && result.summary.reorderVariants === 1 && result.summary.deadStock === 1 && result.summary.deadStockValue === 900, result.summary);
check('archived catalog records are excluded', result.products.length === 5 && !result.products.some(r => r.id === 'hidden'), result.products.map(r => r.id));

{
  const p = { id: 'mixed', name: 'Mixed variants', price: 100, cost: 50, unit: 'pcs', variants: [{ id: 'mixed:old', o: ['Old'], active: true }, { id: 'mixed:new', o: ['New'], active: true }, { id: 'mixed:neg', o: ['Negative'], active: true }] };
  const a = analyzeInventory({ products: [p], entries: [move('mx0', 'mixed:old', 5, 100), move('mx1', 'mixed:new', 20, 10), move('mx2', 'mixed:new', -5, 2, 'SALE'), move('mx3', 'mixed:neg', -2, 2, 'SALE')], now });
  const row = a.products[0];
  check('a dead variant is surfaced even when another variant still sells', row.hasDeadStock && !row.deadStock && row.deadStockVariants === 1 && row.deadStockValue === 500 && a.summary.deadStockVariants === 1, row);
  check('product availability does not let a negative variant cancel sellable stock', row.availableStock === 20 && row.currentStock === 18, row);
}

{
  const p = product('return', 'Returned Item', 100, 50);
  const a = analyzeInventory({ products: [p], entries: [move('r0', 'return:', 20, 40), move('r1', 'return:', -10, 4, 'SALE'), move('r2', 'return:', 0, 2, 'NOT_FOR_RESALE', 2)], now });
  const row = a.products[0];
  check('returns reduce net sales velocity even when not put back on shelf', row.currentStock === 10 && row.soldUnits === 10 && row.returnedUnits === 2 && row.netUnitsSold === 8, row);
}

{
  const custom = analyzeInventory({ products: [product('x', 'X', 10, 5)], entries: [move('x0', 'x:', 12, 10), move('x1', 'x:', -6, 1, 'SALE')], now,
    config: { velocityDays: 6, trendDays: 3, leadDays: 2, safetyDays: 1, targetCoverDays: 5 } });
  const row = custom.products[0];
  check('lead, safety and target cover are configurable', row.salesVelocity === 1 && row.reorderPoint === 3 && row.suggestedReorderQty === 0 && custom.config.targetCoverDays === 5, row);
}

{
  const p = product('oil', 'Oil', 200, 120, { unit: 'l' });
  const a = analyzeInventory({ products: [p], entries: [move('o0', 'oil:', 1.25, 8), move('o1', 'oil:', -.75, 1, 'SALE')], now,
    config: { velocityDays: 5, leadDays: 5, safetyDays: 2, targetCoverDays: 9 } });
  const row = a.products[0];
  check('measured products keep decimal reorder quantities', row.currentStock === .5 && row.salesVelocity === .15 && row.reorderPoint === 1.05 && row.suggestedReorderQty === .85, row);
}

{
  const p = product('live', 'Live Adapter', 100, 40);
  Object.assign(store, { catalog: { version: 3, products: [p] }, moves: { m: { id: 'm', v: 'live:', p: 'live', q: 6, type: 'OPENING', t: ago(20) } },
    localDays: { d: { sales: [{ id: 'sale', no: 'INV-1', t: ago(2), items: [{ v: 'live:', p: 'live', q: 2 }] }], voids: [] } }, remoteDays: {}, returnsMap: {}, _d: null });
  const live = inventoryIntelligence({ now });
  check('live adapter reads the existing catalog and ledger', live.products.length === 1 && live.products[0].currentStock === 4 && live.products[0].netUnitsSold === 2, live.products[0]);
  store.imgs = {}; store.access = null;
  const host = { innerHTML: '' }; renderSmartReorder(host);
  check('mobile screen renders from the live adapter and states that it is read-only', host.innerHTML.includes('Smart reorder') && host.innerHTML.includes('Suggestions are read-only') && host.innerHTML.includes('How this is calculated'));
}

{
  const snapshot = { products: [{ id: 'p', suggestedReorderQty: 3 }], summary: { reorderProducts: 1 } };
  const local = createInventoryRecommender({ calculate: () => snapshot });
  check('recommender exposes its deterministic baseline synchronously', local.baseline({}) === snapshot);
  const noProvider = await local.recommend({});
  check('no provider returns a clear deterministic result', noProvider.source === 'deterministic' && noProvider.analysis === snapshot && noProvider.advice === null, noProvider);
  const enhanced = await createInventoryRecommender({ calculate: () => snapshot, enhancer: async analysis => { analysis.products[0].suggestedReorderQty = 999; return { note: 'Order soon', suggestedReorderQty: 999 }; } }).recommend({});
  check('future enhancer advice cannot replace calculated facts', enhanced.source === 'enhanced' && enhanced.analysis.products[0].suggestedReorderQty === 3 && enhanced.advice.suggestedReorderQty === 999, enhanced);
  const fallback = await createInventoryRecommender({ calculate: () => snapshot, enhancer: async () => { throw new Error('offline'); } }).recommend({});
  check('provider failure keeps deterministic recommendations', fallback.source === 'deterministic' && fallback.analysis === snapshot && fallback.enhancerUnavailable, fallback);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
