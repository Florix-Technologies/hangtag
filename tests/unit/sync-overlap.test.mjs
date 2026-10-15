// A download and an upload (or a live change from another device) at the same time (src/features/sync/services/
// sync-ledger.js, pull.js): a download reads the cloud at one moment; what lands after that moment — this device's upload,
// another device's bill or stock move brought by realtime — must not be lost here when the download replaces this
// device's copy, and a download that began earlier must never replace what a later one brought. Then: no stock moved
// twice or lost, no bill or return missing or doubled, no deleted record back; and a download that didn't get everything
// is never counted as up to date (the next look asks again).
// Each case holds the download open just after the fake cloud took its snapshot, does the upload or applies the live
// change, then lets the download finish.
// Run: node tests/unit/sync-overlap.test.mjs
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';
import { createLocalFirstBizRepository } from '../../src/infrastructure/repositories/local-first-biz-repository.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info).slice(0, 600) : '')); };

installFakeDom();
memStorage();
const copy = (x) => JSON.parse(JSON.stringify(x));
// the cloud: tables in memory; a fetch takes its snapshot when it is called, then waits for its gate (if one is set)
const db = { moves: {}, returns: {}, sales: {}, biz: { pl: {} }, products: [] };
const gates = {};   // fetch name → [promise, …] taken in order by successive calls
const gate = (name) => { let open; const p = new Promise((r) => { open = r; }); (gates[name] = gates[name] || []).push(p); return open; };
const snap = async (name, value) => { const g = (gates[name] || []).shift(); if (g) await g; return value; };
let failProducts = 0;
let marks = { catalog: 'c1', images: 'i1', moves: 'm1', returns: 'r1', customers: 'u1', events: 'e1', cash: 'k1', settings: 's1', sales: '0|t|0', sales_count: 0, sales_since: null, sales_voids: '0' };
const asked = [];
const cloud = new Proxy({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'owner' } } } }) },
  records: {
    toMove: (r) => ({ id: r.id, v: r.variant_id, q: r.qty, t: 1 }),
    toSale: (s) => ({ id: s.id, t: 1, dev: 'd2', items: [{ ln: 0, v: 'v1', p: 'p1', q: 1, price: 100 }], total: 100, void: !!s.is_void }),
  },
  shopChanges: async () => ({ ...marks }),
  purchaseChanges: async () => 'p1',
  fetchMoves: async () => snap('fetchMoves', Object.values(copy(db.moves))),
  saveMove: async (m) => { db.moves[m.id] = copy(m); },
  fetchReturns: async () => snap('fetchReturns', Object.values(copy(db.returns))),
  saveReturn: async (r) => { db.returns[r.id] = copy(r); },
  fetchSales: async () => snap('fetchSales', Object.values(copy(db.sales))),
  saveSale: async (s) => { db.sales[s.id] = copy(s); },
  setSaleVoid: async (id, v) => { if (db.sales[id]) db.sales[id].void = !!v; },
  fetchBiz: async () => snap('fetchBiz', { pl: Object.values(copy(db.biz.pl)) }),
  saveBiz: async (kind, r) => { db.biz[kind][r.id] = copy(r); return { version: 1 }; },
  deleteBiz: async (kind, id) => { delete db.biz[kind][id]; },
  fetchProducts: async () => { asked.push('products'); if (failProducts > 0) { failProducts--; throw Object.assign(new Error('Failed to fetch'), { code: 'NETWORK' }); } return copy(db.products); },
  fetchVariants: async () => [],
}, { get: (o, k) => (k in o ? o[k] : async () => (k === 'fetchSettings' ? null : k === 'fetchLogo' ? '' : [])) });
override({ cloud });

const { enqueue, dropQueued, flushSbQueue } = await import('../../src/features/sync/services/outbox.js');
const { invalidate, D } = await import('../../src/features/inventory/services/ledger.js');
override({ bizRepository: createLocalFirstBizRepository({ store, persist: { saveBiz() {}, saveMoves() {} }, outbox: { enqueue, dropQueued }, invalidate }) });
const { pullMoves, pullReturns, pullSales, pullBiz, pullFromSupabase, pullShopChanges, forgetShopChanges } = await import('../../src/features/sync/services/pull.js');
const { onRemoteMoveEvent, onRemoteSaleEvent } = await import('../../src/features/sync/services/remote-events.js');
const { bizRepository } = await import('../../src/features/commerce/repositories/biz-repository.js');

Object.assign(store, { dev: 'd1', authUser: { id: 'owner' }, sbClient: {}, sbStatus: 'connected', sbOfflineQueue: [], syncReview: [], returnsMap: {}, remoteDays: {}, localDays: {},
  moves: {}, customers: {}, events: {}, imgs: {}, biz: {}, catalog: { version: 3, products: [] }, settings: {}, prefs: {}, _d: null, dirty: new Set(), lastSyncAt: 0 });
const stock = (v) => { invalidate(); const d = D(); return (d.moved[v] || 0) - (d.sold[v] || 0) + (d.returned[v] || 0); };
const billIds = () => { const ids = []; Object.values(store.remoteDays).forEach((doc) => doc.sales.forEach((s) => ids.push(s.id))); return ids.sort(); };

// 1. this device's stock move goes up while the moves come down
{
  const open = gate('fetchMoves');
  const pulling = pullMoves();                                  // the cloud is read now: no m1 yet
  store.moves.m1 = { id: 'm1', v: 'v1', q: 5, t: 1 };
  enqueue({ type: 'move', id: 'm1', move: store.moves.m1 });
  await flushSbQueue();                                         // m1 lands, and leaves the queue
  const landed = !!db.moves.m1 && store.sbOfflineQueue.length === 0;
  open(); await pulling;
  check('a stock move uploaded while the moves came down stays here (the download read the cloud before it landed): stock right', landed && !!store.moves.m1 && stock('v1') === 5, { landed, moves: store.moves, stock: stock('v1') });
  db.moves.m1.q = 6;                                            // later, the cloud's version differs (say, corrected)
  await pullMoves();
  check('…and the next download, begun after it landed, takes the cloud\'s version: nothing kept here for ever', store.moves.m1.q === 6 && stock('v1') === 6, store.moves.m1);
}
// 2. another device's stock move arrives live while the moves come down
{
  const open = gate('fetchMoves');
  const pulling = pullMoves();
  db.moves.m2 = { id: 'm2', v: 'v1', q: -2, t: 2 };
  onRemoteMoveEvent({ eventType: 'INSERT', new: { id: 'm2', variant_id: 'v1', qty: -2 } });
  open(); await pulling;
  check('another device\'s stock move brought by realtime while the moves came down stays: stock right', !!store.moves.m2 && stock('v1') === 4, { moves: Object.keys(store.moves), stock: stock('v1') });
}
// 3. two downloads of the moves at once; the one that began later finishes first
{
  const open = gate('fetchMoves');
  const first = pullMoves();                                    // reads the cloud before m3
  db.moves.m3 = { id: 'm3', v: 'v1', q: 10, t: 3 };             // another device's move (realtime missed it)
  await pullMoves();                                            // begins later, sees m3, finishes first
  const afterLater = !!store.moves.m3;
  open(); await first;
  check('two downloads at once: the one that began earlier never replaces what the later one brought', afterLater && !!store.moves.m3 && stock('v1') === 14, { afterLater, moves: Object.keys(store.moves) });
}
// 4. a return goes up while the returns come down
{
  const open = gate('fetchReturns');
  const pulling = pullReturns();
  store.returnsMap.r1 = { id: 'r1', sale: 's0', t: 4, items: [{ ln: 0, v: 'v1', p: 'p1', q: 1, price: 100 }] };
  enqueue({ type: 'return', id: 'r1', ret: store.returnsMap.r1 });
  await flushSbQueue();
  open(); await pulling;
  check('a return uploaded while the returns came down stays: the return there once, its stock back', !!store.returnsMap.r1 && Object.keys(store.returnsMap).length === 1 && stock('v1') === 15, { returns: Object.keys(store.returnsMap), stock: stock('v1') });
}
// 5. another device's bill, and a cancel, arrive live while every bill comes down
{
  db.sales.s1 = { id: 's1', t: 1, dev: 'd2', items: [{ ln: 0, v: 'v1', p: 'p1', q: 1, price: 100 }], total: 100 };
  await pullSales();
  const open = gate('fetchSales');
  const pulling = pullSales();                                  // reads the cloud: s1 only, not cancelled
  db.sales.s2 = { id: 's2', t: 2, dev: 'd2', items: [{ ln: 0, v: 'v1', p: 'p1', q: 1, price: 100 }], total: 100 };
  db.sales.s1.void = true;
  store._d = null;
  await onRemoteSaleEvent({ eventType: 'INSERT', new: { id: 's2', is_void: false } });
  await onRemoteSaleEvent({ eventType: 'UPDATE', new: { id: 's1', is_void: true } });
  open(); await pulling;
  invalidate();
  check('another device\'s bill brought by realtime while the bills came down stays, and so does a cancel: each bill once, stock right',
    JSON.stringify(billIds()) === '["s1","s2"]' && D().saleById.s1.void === true && stock('v1') === 14, { bills: billIds(), s1: D().saleById.s1 && D().saleById.s1.void, stock: stock('v1') });
  await pullSales();
  invalidate();
  check('…the next full download brings the same bills: none doubled', JSON.stringify(billIds()) === '["s1","s2"]' && D().saleById.s1.void === true && stock('v1') === 14, billIds());
}
// 5b. a cancelled bill restored here while offline, then a download of the cloud's (still cancelled) copy
{
  const { unvoid } = await import('../../src/features/sales/use-cases/checkout.js');
  store.sbStatus = 'error';                                     // offline: the restore waits in the queue
  await unvoid('s1');
  invalidate();
  const restored = D().saleById.s1.void === false && store.sbOfflineQueue.some((q) => q.type === 'void' && q.id === 's1');
  await pullSales();                                            // the cloud still says cancelled
  invalidate();
  check('a bill restored here and not uploaded yet stays restored when the bills come down (stock right)', restored && D().saleById.s1.void === false && stock('v1') === 13, { restored, s1: D().saleById.s1.void, stock: stock('v1') });
  store.sbStatus = 'connected'; await flushSbQueue();
  await pullSales(); invalidate();
  check('…once the restore has gone up, the cloud and this device agree: restored', db.sales.s1.void === false && D().saleById.s1.void === false && stock('v1') === 13, { cloud: db.sales.s1.void, here: D().saleById.s1.void });
}
// 6. a record deleted here while the commerce records come down
{
  db.biz.pl.x1 = { id: 'x1', name: 'Wholesale' }; db.biz.pl.x2 = { id: 'x2', name: 'Retail' };
  await pullBiz();
  const before = bizRepository().list('pl').length;
  store.sbStatus = 'error';                                     // offline: the delete waits in the queue
  bizRepository().remove('pl', 'x1');
  await pullBiz();
  check('a price list deleted here and not uploaded yet stays deleted when the records come down', before === 2 && !bizRepository().get('pl', 'x1') && !!bizRepository().get('pl', 'x2'), bizRepository().list('pl'));
  store.sbStatus = 'connected';
  bizRepository().remove('pl', 'x2');
  const open = gate('fetchBiz');
  const pulling = pullBiz();                                    // reads the cloud: x2 still there
  await flushSbQueue();                                         // both deletes land
  open(); await pulling;
  check('…and one whose delete lands while they come down stays deleted too', !bizRepository().get('pl', 'x2') && !bizRepository().get('pl', 'x1') && !db.biz.pl.x2, bizRepository().list('pl'));
}
// 7. a download that didn't get the products isn't up to date
{
  db.products = [{ id: 'p1', name: 'Tee', price: 100, opts: [], variants: [] }];
  forgetShopChanges(); failProducts = 1; asked.length = 0;
  const full = await pullFromSupabase(false);
  check('the full download whose products didn\'t come down says so (not counted as up to date)', full === false && asked.includes('products'), { full, asked });
  asked.length = 0;
  const parts = await pullShopChanges();
  check('…and the next look downloads the products again, though their fingerprint hasn\'t moved', JSON.stringify(parts) === '["catalog"]' && asked.includes('products') && store.catalog.products.length === 1, { parts, asked });
  marks = { ...marks, catalog: 'c2' }; failProducts = 1;
  let threw = null;
  try { await pullShopChanges(); } catch (e) { threw = e; }
  asked.length = 0;
  const again = await pullShopChanges();
  check('a change check whose products didn\'t come down fails (the catch-up tries again), and the next one asks for them again', !!threw && JSON.stringify(again) === '["catalog"]' && asked.includes('products'), { threw: threw && threw.message, again });
  asked.length = 0;
  const quiet = await pullShopChanges();
  check('…until they came: then nothing more to download', JSON.stringify(quiet) === '[]' && !asked.includes('products'), { quiet, asked });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
