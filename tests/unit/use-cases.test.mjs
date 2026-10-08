// Unit tests for the application layer: use cases run against fake ports (no browser, no Supabase).
// The state store is seeded directly; repositories/cloud are fakes that record what they were asked to do.
// Run: npm run test:unit
import { store } from '../../src/shared/state/store.js';
import { override, resetPorts } from '../../src/shared/di/services.js';
import { saveProduct } from '../../src/features/products/use-cases/save-product.js';
import { archiveProduct, productHasSales, removeProduct } from '../../src/features/products/use-cases/product-lifecycle.js';
import { recordStockOperation } from '../../src/features/inventory/use-cases/record-stock-operation.js';
import { saveBillingSettings } from '../../src/features/shop/use-cases/save-billing-settings.js';
import { saveShopProfile } from '../../src/features/shop/use-cases/save-shop-profile.js';
import { DEFAULT_SETTINGS } from '../../src/domain/shop/settings.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A fresh shop: one product (Tee, Black M/L), 10 Black/M in stock, one bill that sold 2 Black/M
function seed() {
  Object.assign(store, {
    dev: 'dev1', _d: null, imgs: {}, returnsMap: {}, localDays: {}, sbOfflineQueue: [], cart: [], editor: null,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    catalog: { version: 2, example: false, products: [
      { id: 'p1', name: 'Tee', cat: '', brand: '', desc: '', price: 599, cost: 300, color: '#1B1E24', archived: false, colors: ['Black'], sizes: ['M', 'L'],
        variants: [{ id: 'v1', c: 'Black', s: 'M', sku: 'TEE-BM', bc: '', price: null, cost: null, active: true },
                   { id: 'v2', c: 'Black', s: 'L', sku: '', bc: '', price: null, cost: null, active: true }] },
      { id: 'p2', name: 'Cap', cat: '', brand: '', desc: '', price: 199, cost: null, color: '#1B1E24', archived: false, colors: [], sizes: [],
        variants: [{ id: 'c1', c: '', s: '', sku: 'CAP', bc: '', price: null, cost: null, active: true }] }] },
    moves: { 'open:v1': { id: 'open:v1', v: 'v1', p: 'p1', type: 'OPENING', q: 10, cost: null, note: '', t: 1, dev: 'dev1' } },
    remoteDays: { d: { sales: [{ id: 's1', t: Date.now(), items: [{ v: 'v1', p: 'p1', n: 'Tee', c: 'Black', s: 'M', q: 2, price: 599 }] }], voids: [] } },
  });
}
// Fake product repository: keeps its own copy and records calls
function fakeProducts() {
  const calls = [];
  const repo = {
    calls,
    list: () => store.catalog.products,
    get: (id) => store.catalog.products.find((p) => p.id === id),
    save: (a) => { calls.push(['save', clone(a)]); },
    setArchived: (id, on) => { calls.push(['setArchived', id, on]); const p = repo.get(id); if (p) p.archived = on; return p || null; },
    remove: (id) => { calls.push(['remove', id]); return repo.get(id) || null; },
  };
  return repo;
}
const K = (...o) => o.map((x) => x.toLowerCase()).join('\u0001');
const cell = (o, c) => Object.assign({ o, price: '', cost: '', bc: '', active: true, exists: true }, c);
const editorDraft = (over) => Object.assign({ id: 'p1', name: 'Tee', cat: ' Tops ', brand: '', desc: '', price: '599', cost: '300', color: '#1B1E24', archived: false,
  hsn: '', gst: '', hasOpts: true, opts: [{ n: 'Colour', v: ['Black'] }, { n: 'Size', v: ['M', 'L'] }], codesOn: false, code: 'barcode', img: undefined,
  cells: { [K('Black', 'M')]: cell(['Black', 'M'], { id: 'v1', sku: 'TEE-BM', stock: '8' }),
           [K('Black', 'L')]: cell(['Black', 'L'], { id: 'v2', sku: '', stock: '0' }) } }, over);
const withSizes = (sizes, over) => editorDraft(Object.assign({ opts: [{ n: 'Colour', v: ['Black'] }, { n: 'Size', v: sizes }] }, over));

// ---------- SaveProduct ----------
seed(); let repo = fakeProducts(); let restore = override({ productRepository: repo });
let d = editorDraft();
let r = saveProduct({ draft: d });
let saved = repo.calls[0] && repo.calls[0][1];
check('edit: stock typed as the counted number becomes an ADJUST move for the difference (8 on hand → 8: none; L 0 → 0: none)', r.created === false && saved && saved.newMoves.length === 0, saved && saved.newMoves);
check('edit: product saved with trimmed fields and its variants', saved.product.cat === 'Tops' && saved.product.variants.length === 2 && saved.isNew === false && saved.renamed === false);
restore();

seed(); Object.assign(store.catalog.products[0], { low: 3, repack: [{ f: 'v1', t: 'v2', per: 2 }] }); repo = fakeProducts(); restore = override({ productRepository: repo });
r = saveProduct({ draft: editorDraft({ price: '649' }) });
saved = repo.calls[0] && repo.calls[0][1];
check('edit: what the editor doesn\'t show stays — the product\'s own low-stock alert (from an import) and its repack conversions', !!saved && saved.product.price === 649
  && saved.product.low === 3 && JSON.stringify(saved.product.repack) === '[{"f":"v1","t":"v2","per":2}]', saved && saved.product);
restore();

seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
d = editorDraft({ name: 'Boxy Tee', cells: { [K('Black', 'M')]: cell(['Black', 'M'], { id: 'v1', sku: 'TEE-BM', stock: '5' }),
  [K('Black', 'L')]: cell(['Black', 'L'], { id: 'v2', sku: '', stock: '4' }) } });
r = saveProduct({ draft: d });
saved = repo.calls[0][1];
check('edit: lowering Black/M from 8 to 5 records −3; raising Black/L from 0 to 4 records +4', saved.newMoves.map((m) => m.v + ':' + m.q + ':' + m.type).join(',') === 'v1:-3:ADJUST,v2:4:ADJUST', saved.newMoves);
check('edit: a rename is reported (the example flag is cleared by the repository)', saved.renamed === true);
restore();

seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
d = withSizes(['M']);   // Black/L removed: it has no history, so it is deleted for good
r = saveProduct({ draft: d });
saved = repo.calls[0][1];
check('removing a variant with no history deletes it (deletedVariantIds)', saved.deletedVariantIds.join() === 'v2' && saved.product.variants.length === 1, saved.deletedVariantIds);
restore();

seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
d = withSizes(['L']);   // Black/M removed: it has sales and stock, so it is kept hidden and its stock zeroed
r = saveProduct({ draft: d });
saved = repo.calls[0][1];
const hidden = saved.product.variants.find((v) => v.id === 'v1');
check('removing a variant with history keeps it hidden (inactive) and zeroes its stock', hidden && hidden.active === false && saved.newMoves.some((m) => m.v === 'v1' && m.q === -8 && m.note === 'Variant removed in the product editor'), saved);
check('…and the message counts only the variants still on sale', r.activeCount === 1 && r.variantCount === 2);
restore();

seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
d = { id: 'p9', name: 'Scarf', cat: '', brand: '', desc: '', price: '250', cost: '', color: '#ffffff', archived: false, hsn: '6117', gst: '5', hasOpts: false, opts: [], codesOn: true, code: 'qr',
  img: 'data:image/jpeg;base64,x', cells: { '': { id: null, o: [], sku: 'SC-1', bc: 'SCARF-QR', price: '', cost: '', stock: '6', active: true, exists: false } } };
r = saveProduct({ draft: d });
saved = repo.calls[0][1];
check('new product: OPENING move for its stock, new variant id, photo passed on', r.created === true && saved.isNew === true && saved.newMoves.length === 1 && saved.newMoves[0].type === 'OPENING' && saved.newMoves[0].q === 6 && saved.newMoves[0].id === 'open:' + saved.product.variants[0].id && saved.image === 'data:image/jpeg;base64,x' && /^v/.test(saved.product.variants[0].id));
restore();

seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
d = editorDraft({ cells: { 'Black\u0001M': { id: 'v1', sku: 'cap', bc: '', price: '', cost: '', stock: '8', exists: true }, 'Black\u0001L': { id: 'v2', sku: '', bc: '', price: '', cost: '', stock: '0', exists: true } } });
r = saveProduct({ draft: d });
check('a SKU used by another product stops the save: nothing is written', r.error === 'SKU cap is already used by Cap.' && repo.calls.length === 0, r);
restore();

// ---------- Archive / remove ----------
seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
check('archiving goes through the repository and returns the product', archiveProduct('p1', true).name === 'Tee' && repo.calls[0][0] === 'setArchived');
check('a product with sales has sales; one without has none', productHasSales('p1') === true && productHasSales('p2') === false);
check('a product with sales is never removed', removeProduct('p1') === null && !repo.calls.some((c) => c[0] === 'remove'));
check('a product without sales is removed through the repository', removeProduct('p2').name === 'Cap' && repo.calls.some((c) => c[0] === 'remove' && c[1] === 'p2'));
restore();

// ---------- RecordStockOperation ----------
seed(); let stockCalls = []; restore = override({ stockRepository: { record: (a) => stockCalls.push(clone(a)) } });
r = recordStockOperation({ kind: 'in', productId: 'p1', values: { v1: '5' }, costRaw: '320', setCost: true, reason: '', note: 'Invoice 42' });
check('stock in: records the move and, when the cost is new, the product too', r.pieces === 5 && stockCalls[0].moves.length === 1 && stockCalls[0].moves[0].type === 'RESTOCK' && stockCalls[0].changedProductId === 'p1');
check('…uploaded as just the variant whose cost changed (another till\'s edit of the product stays)',JSON.stringify(stockCalls[0].changedVariantIds) === '["v1"]');
check('…and the variant now carries that cost', store.catalog.products[0].variants[0].cost === 320);
stockCalls = []; store._d = null;
r = recordStockOperation({ kind: 'in', productId: 'p1', values: { v1: '1' }, costRaw: '320', setCost: true, reason: '', note: '' });
check('stock in at the same cost: the product is not re-saved', stockCalls[0].changedProductId === null);
stockCalls = []; store._d = null;
r = recordStockOperation({ kind: 'adjust', productId: 'p1', values: { v1: '7' }, costRaw: '', setCost: false, reason: 'Physical count correction', note: '' });
check('adjustment: counted 7 where the ledger says 8 records −1', r.pieces === -1 && stockCalls[0].moves[0].q === -1 && stockCalls[0].moves[0].type === 'ADJUST', { r, stockCalls });
stockCalls = [];
r = recordStockOperation({ kind: 'in', productId: 'p1', values: { v1: '' }, costRaw: '', setCost: false, reason: '', note: '' });
check('nothing entered: refused and nothing recorded', r.error === 'Enter at least one quantity.' && stockCalls.length === 0);
restore();

// ---------- SaveBillingSettings (writes the settings and queues the upload) ----------
seed(); const kv = new Map();
restore = override({ storage: { get: (k, d) => (kv.has(k) ? JSON.parse(kv.get(k)) : d), set: (k, v) => { kv.set(k, JSON.stringify(v)); return true; } } });
r = saveBillingSettings({ lowStock: '5', taxOn: 'on', taxRate: '5', taxIncl: 'on', prefix: 'HT-', paper: '80mm', footer: 'Thanks' });
check('billing settings saved to the store, this device and the upload queue', r.ok && store.settings.lowStock === 5 && store.settings.prefix === 'HT-' && JSON.parse(kv.get('rc_settings')).taxOn === true && store.sbOfflineQueue.some((q) => q.type === 'settings'));
r = saveBillingSettings({ lowStock: '-1' });
check('invalid billing settings are refused and not saved', r.error === 'Low-stock alert must be 0 or more.' && store.settings.lowStock === 5);
restore();

// ---------- SaveShopProfile (through the cloud port) ----------
seed(); store.authUser = { id: 'u1', email: 'a@shop.in' }; store.profile = null;
let upserts = []; kv.clear();
restore = override({ storage: { get: (k, d) => d, set: (k, v) => { kv.set(k, JSON.stringify(v)); return true; } },
  cloud: { saveProfile: async (row) => { upserts.push(row); return { error: null }; } } });
await saveShopProfile({ full_name: 'Asha', shop_name: 'Asha Styles' });
check('shop profile: saved with the account id and email, marked onboarded the first time, kept on this device',
  upserts[0].id === 'u1' && upserts[0].email === 'a@shop.in' && !!upserts[0].onboarded_at && store.profile.shop_name === 'Asha Styles' && kv.has('hangtag_profile'));
restore();
restore = override({ cloud: { saveProfile: async () => ({ error: { message: 'column "gstin" does not exist' } }) } });
let msg = null; try { await saveShopProfile({ full_name: 'A' }); } catch (e) { msg = e.message; }
check('shop profile: an old database gives a plain message, never the raw database error', msg === 'The database needs the latest update (schema.sql) before profiles can be saved.', msg);
restore();

// ---------- a team member: the use case refuses what its role can't do, before anything changes ----------
{
  const member = (perms) => { store.access = { userId: 'm1', shopId: 'shop1', role: 'custom', perms, overrides: {} }; };
  seed(); repo = fakeProducts(); restore = override({ productRepository: repo });
  const cat0 = clone(store.catalog), moves0 = clone(store.moves);
  member(['view_products', 'manage_products']);   // may edit products, not stock
  r = saveProduct({ draft: editorDraft({ cells: { [K('Black', 'M')]: cell(['Black', 'M'], { id: 'v1', sku: 'TEE-BM', stock: '9' }), [K('Black', 'L')]: cell(['Black', 'L'], { id: 'v2', sku: '', stock: '0' }) } }) });
  check('a role with products but no stock permission: a save that changes stock is refused, nothing saved or queued',
    /can't set stock/.test(r.error || '') && repo.calls.length === 0 && eq(store.catalog, cat0) && eq(store.moves, moves0) && store.sbOfflineQueue.length === 0, r);
  r = saveProduct({ draft: editorDraft() });
  check('…the same product saved without a stock change goes through', !r.error && repo.calls.length === 1 && repo.calls[0][0] === 'save', r);
  member(['view_products', 'create_sale']);
  repo.calls.length = 0;
  r = saveProduct({ draft: editorDraft() });
  const a = archiveProduct('p2', true), rm = removeProduct('p2');
  check('a cashier can\'t save, archive or delete a product (refused in the use case; the repository is never asked)',
    /can't add or edit products/.test(r.error || '') && /can't change products/.test(a.error || '') && /can't delete products/.test(rm.error || '') && repo.calls.length === 0 && !store.catalog.products[1].archived, { r, a, rm });
  const stockRepo = { calls: [], record: (x) => stockRepo.calls.push(x) };
  restore(); restore = override({ productRepository: repo, stockRepository: stockRepo });
  r = recordStockOperation({ kind: 'in', productId: 'p1', values: { v1: '3' }, costRaw: '', setCost: false, reason: '', note: '' });
  check('a cashier can\'t add stock', /can't add or adjust stock/.test(r.error || '') && stockRepo.calls.length === 0, r);
  member(['view_products', 'manage_inventory']);
  r = recordStockOperation({ kind: 'in', productId: 'p1', values: { v1: '3' }, costRaw: '250', setCost: true, reason: '', note: '' });
  check('stock in may not change cost prices without products permission', /can't change cost prices/.test(r.error || '') && stockRepo.calls.length === 0, r);
  r = recordStockOperation({ kind: 'in', productId: 'p1', values: { v1: '3' }, costRaw: '250', setCost: false, reason: '', note: '' });
  check('…stock in without touching the cost price is fine', !r.error && stockRepo.calls.length === 1, r);
  store.access = null;
  restore();
}
resetPorts();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
