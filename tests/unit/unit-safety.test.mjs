// Unit safety (PLAN.md I1): a product's unit is pinned once it has history, and a quantity with more decimals than its unit
// keeps is refused, never rounded — so no count is silently changed (12.5 kg switched to pieces wrote +0.5 before).
// Run: node tests/unit/unit-safety.test.mjs
import { store } from '../../src/shared/state/store.js';
import { override, resetPorts } from '../../src/shared/di/services.js';
import { saveProduct } from '../../src/features/products/use-cases/save-product.js';
import { unitLock } from '../../src/features/products/services/unit-lock.js';
import { recordStockOperation, recordTrackedStockOperation } from '../../src/features/inventory/use-cases/record-stock-operation.js';
import { buildStockMoves, buildTrackedMoves } from '../../src/domain/inventory/stock-operation.js';
import { qtyPlacesError } from '../../src/domain/catalog/units.js';
import { DEFAULT_SETTINGS } from '../../src/domain/shop/settings.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const clone = (x) => JSON.parse(JSON.stringify(x));

// A shop with rice (kg, 12.5 in stock), a rug (sq ft? no: metres, nothing ever recorded) and a tee (pieces, 12.5 from before
// units were checked: legacy data a count must not "correct")
function seed(over = {}) {
  Object.assign(store, {
    dev: 'dev1', _d: null, imgs: {}, returnsMap: {}, localDays: {}, remoteDays: {}, sbOfflineQueue: [], cart: [], editor: null, orders: {}, biz: {},
    settings: Object.assign({}, DEFAULT_SETTINGS),
    catalog: { version: 2, example: false, products: [
      { id: 'rice', name: 'Rice', price: 60, unit: 'kg', opts: [], variants: [{ id: 'rice:', o: [], active: true }] },
      { id: 'rug', name: 'Rug', price: 120, unit: 'm', opts: [], variants: [{ id: 'rug:', o: [], active: true }, { id: 'rug:old', o: [], active: false }] },
      { id: 'tee', name: 'Tee', price: 599, opts: [], variants: [{ id: 'tee:', o: [], active: true }] }] },
    moves: {
      'open:rice': { id: 'open:rice', v: 'rice:', p: 'rice', type: 'OPENING', q: 12.5, t: 1, dev: 'dev1' },
      'open:tee': { id: 'open:tee', v: 'tee:', p: 'tee', type: 'OPENING', q: 12.5, t: 1, dev: 'dev1' } },
  }, over);
}
function fakeProducts() {
  const calls = [];
  return { calls, list: () => store.catalog.products, get: (id) => store.catalog.products.find((p) => p.id === id), save: (a) => { calls.push(clone(a)); } };
}
const draft = (id, over) => {
  const p = store.catalog.products.find((x) => x.id === id), v = p.variants[0];
  return Object.assign({ id, name: p.name, cat: '', brand: '', desc: '', price: String(p.price), cost: '', color: '#1B1E24', archived: false, hsn: '', gst: '',
    unit: p.unit || 'pcs', tracking: 'none', hasOpts: false, opts: [], codesOn: false, code: 'barcode', img: undefined,
    cells: { '': { id: v.id, o: [], sku: '', bc: '', price: '', cost: '', stock: '', active: true, exists: true } } }, over);
};
const cellStock = (d, stock) => { d.cells[''].stock = stock; return d; };

console.log('=== the unit is pinned once a product has history ===');
seed(); let repo = fakeProducts(); let restore = override({ productRepository: repo });
let r = saveProduct({ draft: draft('rice', { unit: 'pcs' }) });
check('rice (12.5 kg in stock) can\'t switch to pieces: refused, nothing saved, no stock record',
  r.field === 'unit' && /Rice has stock records, so it stays sold by kg/.test(r.error || '') && /Repack/.test(r.error) && repo.calls.length === 0, r);
check('…the lock gives the reason', unitLock(store.catalog.products[0]) === 'has stock records');
restore();

seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
r = saveProduct({ draft: draft('rug', { unit: 'pcs' }) });
check('a product with no history can change unit (rug: metres → pieces)', !r.error && repo.calls.length === 1 && repo.calls[0].product.unit === undefined
  && repo.calls[0].newMoves.length === 0, { r, saved: repo.calls[0] && repo.calls[0].product });
restore();

seed({ moves: { 'adj:old': { id: 'adj:old', v: 'rug:old', p: 'rug', type: 'ADJUST', q: 2, t: 1, dev: 'dev1' } } });
check('a variant off sale with a stock record locks it too', unitLock(store.catalog.products[1]) === 'has stock records');

seed({ moves: {}, remoteDays: { d: { sales: [{ id: 's1', t: 1, items: [{ v: 'rug:', p: 'rug', n: 'Rug', q: 1.5, price: 120 }] }], voids: [] } } });
check('a product on a bill is locked', unitLock(store.catalog.products[1]) === 'is on bills');

seed({ moves: {}, orders: { o1: { id: 'o1', kind: 'sales', status: 'confirmed', items: [{ p: 'rug', v: 'rug:', q: 2 }] } } });
repo = fakeProducts(); restore = override({ productRepository: repo });
r = saveProduct({ draft: draft('rug', { unit: 'pcs' }) });
check('an open sales order naming it locks the unit', /Rug is on an open order/.test(r.error || '') && repo.calls.length === 0, r);
store.orders.o1.status = 'cancelled'; store._d = null;
check('…a cancelled one doesn\'t', unitLock(store.catalog.products[1]) === '');
restore();

seed({ moves: {}, biz: { po: { po1: { id: 'po1', status: 'sent', items: [{ p: 'rug', v: 'rug:', q: 10 }] } } } });
check('an open purchase order naming it locks the unit', unitLock(store.catalog.products[1]) === 'is on an open purchase order');
store.biz.po.po1.status = 'closed';
check('…a closed one doesn\'t', unitLock(store.catalog.products[1]) === '');

console.log('=== quantities are refused, not rounded ===');
seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
r = saveProduct({ draft: cellStock(draft('tee', { name: 'Plain tee' }), '12.5') });
check('tee holding 12.5 pieces from before: renaming it leaves its count alone (no +0.5 adjustment)', !r.error && repo.calls.length === 1 && repo.calls[0].newMoves.length === 0, repo.calls[0]);
repo.calls.length = 0;
r = saveProduct({ draft: cellStock(draft('tee'), '11.5') });
check('…typing 11.5 for pieces is refused, not saved as 12', /Use whole numbers for pieces/.test(r.error || '') && repo.calls.length === 0, r);
r = saveProduct({ draft: cellStock(draft('tee'), '13') });
check('…typing 13 records +0.5 (a whole count)', !r.error && repo.calls[0].newMoves.length === 1 && repo.calls[0].newMoves[0].q === 0.5, repo.calls[0] && repo.calls[0].newMoves);
restore();

seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
r = saveProduct({ draft: { id: 'pNew', name: 'Mug', cat: '', brand: '', desc: '', price: '250', cost: '', color: '#1B1E24', archived: false, hsn: '', gst: '', unit: 'pcs', tracking: 'none',
  hasOpts: false, opts: [], codesOn: false, code: 'barcode', img: undefined, cells: { '': { id: null, o: [], sku: '', bc: '', price: '', cost: '', stock: '2.5', active: true, exists: false } } } });
check('a new product\'s opening stock of 2.5 pieces is refused', /Use whole numbers for pieces/.test(r.error || '') && repo.calls.length === 0, r);
restore();

seed(); let stockCalls = []; restore = override({ stockRepository: { record: (a) => stockCalls.push(clone(a)) } });
r = recordStockOperation({ kind: 'in', productId: 'tee', values: { 'tee:': '2.5' }, costRaw: '', setCost: false, reason: '', note: '' });
check('Stock in of 2.5 pieces is refused and nothing is recorded', r.error === 'Use whole numbers for pieces.' && stockCalls.length === 0, r);
r = recordStockOperation({ kind: 'in', productId: 'tee', values: { 'tee:': '0.4' }, costRaw: '', setCost: false, reason: '', note: '' });
check('…0.4 pieces too (it used to round to 0 and say "Enter at least one quantity")', r.error === 'Use whole numbers for pieces.', r);
r = recordStockOperation({ kind: 'adjust', productId: 'tee', values: { 'tee:': '12.5' }, costRaw: '', setCost: false, reason: 'Physical count correction', note: '' });
check('Adjust with the 12.5 from before left as it is: nothing changed (no +0.5)', r.error === 'Nothing changed.' && stockCalls.length === 0, r);
r = recordStockOperation({ kind: 'adjust', productId: 'tee', values: { 'tee:': '12' }, costRaw: '', setCost: false, reason: 'Physical count correction', note: '' });
check('…counted 12: −0.5 recorded', !r.error && stockCalls.length === 1 && stockCalls[0].moves[0].q === -0.5, r);
stockCalls = []; store._d = null;
r = recordStockOperation({ kind: 'in', productId: 'rice', values: { 'rice:': '2.555' }, costRaw: '', setCost: false, reason: '', note: '' });
check('2.555 kg of rice is taken in (kg keeps 3 decimals)', !r.error && stockCalls[0].moves[0].q === 2.555, r);
r = recordStockOperation({ kind: 'in', productId: 'rice', values: { 'rice:': '2.5555' }, costRaw: '', setCost: false, reason: '', note: '' });
check('…2.5555 kg is refused', r.error === 'Use at most 3 decimal places for kg.', r);
restore();

console.log('=== batches ===');
const newId = (() => { let n = 0; return () => 'm' + (++n); })();
const op = { kind: 'in', productId: 'tee', tracking: 'batch', expiry: false, unit: 'pcs', cost: null, reason: '', note: '', now: 1, deviceId: 'd', today: '2026-10-12' };
let b = buildTrackedMoves(op, { 'tee:': { q: '0.4', b: 'B1' } }, { serialState: () => null, batchOf: () => null }, newId);
check('a batch of 0.4 pieces is refused (it used to be dropped without a word)', b.error === 'Use whole numbers for pieces.', b);
b = buildTrackedMoves({ ...op, kind: 'adjust' }, { 'tee:|B1': '7.5' }, { serialState: () => null, batchOf: () => ({ b: 'B1', qty: 7.5 }) }, newId);
check('a batch count left as it is (7.5 from before) is no change', b.error === 'Nothing changed.', b);
b = buildTrackedMoves({ ...op, kind: 'adjust' }, { 'tee:|B1': '6.5' }, { serialState: () => null, batchOf: () => ({ b: 'B1', qty: 7.5 }) }, newId);
check('…a batch count of 6.5 pieces is refused', /^Batch B1: Use whole numbers for pieces\.$/.test(b.error || ''), b);
const m = buildStockMoves({ kind: 'adjust', productId: 'rice', values: { a: '1.25', b: '3' }, unit: 'kg', now: 1, deviceId: 'd' }, (v) => (v === 'a' ? 1 : 3), newId);
check('the domain records only the changed count, unrounded (1 → 1.25 kg)', !m.error && m.moves.length === 1 && m.moves[0].q === 0.25, m);
check('qtyPlacesError: 12.5 pcs, 2.555 m refused; 0.1 + 0.2 kg and "1,25" kg fine',
  !!qtyPlacesError('12.5', 'pcs') && !!qtyPlacesError('2.555', 'm') && qtyPlacesError(0.1 + 0.2, 'kg') === '' && qtyPlacesError('1,25', 'kg') === '');

resetPorts();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
