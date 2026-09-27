// Unit tests for infrastructure: the Supabase gateway (against a fake supabase-js client that records every call),
// the row mappers, and the local-first repositories. Run: npm run test:unit
import { createCloudGateway } from '../../src/infrastructure/supabase/cloud-gateway.js';
import { toAppError } from '../../src/infrastructure/supabase/errors.js';
import { AppError, ERROR_CODES as C } from '../../src/shared/errors/app-error.js';
import { rowToCustomer, rowToProduct, rowToReturn, rowToReturnItem, rowToSale, rowToVariant, saleItemRows, saleRow } from '../../src/infrastructure/supabase/mappers.js';
import { createLocalFirstProductRepository } from '../../src/infrastructure/repositories/local-first-product-repository.js';
import { createLocalFirstStockRepository } from '../../src/infrastructure/repositories/local-first-stock-repository.js';
import { store } from '../../src/shared/state/store.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}

// A fake supabase-js client: every query chain is recorded as { t: table, ops: [[method, args]] } and resolves to answer(q)
function fakeClient(answer = () => ({ data: [], error: null })) {
  const calls = [];
  const from = (t) => {
    const q = { t, ops: [] };
    const p = new Proxy(function () {}, {
      get(_, k) {
        if (k === 'then') { calls.push(q); const r = Promise.resolve(answer(q)); return r.then.bind(r); }
        return (...a) => { q.ops.push([k, a]); return p; };
      },
    });
    return p;
  };
  return { calls, from, auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) }, rpc: async (n, a) => ({ data: [n, a], error: null }) };
}
const opNames = (q) => q.ops.map((o) => o[0]).join('.');

// ---------- gateway: uploads ----------
let client = fakeClient();
const gw = createCloudGateway({ getClient: () => client, url: 'https://x.supabase.co/', key: 'pk', storageKey: 'k' });
const sale = { id: 's1', t: 1000, items: [{ ln: 0, v: 'v1', p: 'p1', n: 'Tee', c: 'Black', s: 'M', q: 2, price: 599, cost: 300 }], sub: 1198, disc: 0, total: 1198, pay: 'upi', dev: 'd1' };
await gw.saveSale(sale);
check('saveSale: bill row (not cancelled), then its lines keyed by owner/sale/line', client.calls.map((q) => q.t + ':' + opNames(q)).join(' | ') === 'hangtag_sales:upsert | hangtag_sale_items:upsert'
  && client.calls[0].ops[0][1][0].is_void === false && client.calls[1].ops[0][1][1].onConflict === 'owner_id,sale_id,line_no', client.calls);
client = fakeClient();   // a different client: the gateway must use whichever is current
await gw.setSaleVoid('s1', true);
check('the gateway reads the current client on every call', client.calls.length === 1 && opNames(client.calls[0]) === 'update.eq' && client.calls[0].ops[0][1][0].is_void === true);
client = fakeClient((q) => (q.t === 'hangtag_sales' ? { error: { message: 'boom' } } : { data: [], error: null }));
let err = null; try { await gw.saveSale(sale); } catch (e) { err = e; }
check('an upload error is thrown as an AppError (plain message, original kept as cause) and nothing after it is sent', err instanceof AppError && err.code === C.UNKNOWN && err.cause.message === 'boom' && !/boom/.test(err.message) && client.calls.length === 1, err);
client = fakeClient();
await gw.saveProduct({ id: 'p1', name: 'Tee', price: 599, color: '#000000', variants: [{ id: 'v1', c: 'Black', s: 'M', active: true }] }, 3);
check('saveProduct: product row with its sort order, then its variants', client.calls.map((q) => q.t).join() === 'hangtag_products,hangtag_variants' && client.calls[0].ops[0][1][0].sort_order === 3);
client = fakeClient();
await gw.saveImage('p1', ''); await gw.saveImage('p1', 'data:x');
check('saveImage: empty removes the photo, a data URL stores it', opNames(client.calls[0]) === 'delete.eq' && opNames(client.calls[1]) === 'upsert' && client.calls[1].ops[0][1][0].image_data === 'data:x');
// a refused return: lines refused → the return header is removed again when it has no lines
client = fakeClient((q) => (q.t === 'hangtag_return_items' && q.ops[0][0] === 'upsert' ? { error: { code: '23514', message: "Can't return 1 piece(s): 2 bought, 2 already returned" } } : { data: [], error: null }));
err = null; try { await gw.saveReturn({ id: 'r1', sale: 's1', t: 1, items: [{ ln: 0, q: 1, p: 'p1', n: 'Tee' }] }); } catch (e) { err = e; }
check("saveReturn refused: header removed (no lines left behind), the database rule's own message kept", err && err.code === C.VALIDATION && err.message === "Can't return 1 piece(s): 2 bought, 2 already returned"
  && client.calls.map((q) => q.t + ':' + opNames(q)).join(' | ') === 'hangtag_returns:upsert | hangtag_return_items:upsert | hangtag_return_items:select.eq.limit | hangtag_returns:delete.eq', client.calls.map((q) => q.t + ':' + opNames(q)));
client = fakeClient();
await gw.saveAllSales(Array.from({ length: 501 }, (_, i) => Object.assign({}, sale, { id: 's' + i, void: i === 0 })));
check('saveAllSales: bills in chunks of 500, cancelled flag kept, then lines', client.calls.filter((q) => q.t === 'hangtag_sales').length === 2 && client.calls[0].ops[0][1][0][0].is_void === true);

// ---------- gateway: downloads ----------
const rows = {
  hangtag_sales: [{ id: 's1', timestamp: 5, subtotal: 10, discount: 0, total: 10, payment_method: 'cash', device_id: 'd1', is_void: true }],
  hangtag_sale_items: [{ sale_id: 's1', line_no: 0, product_id: 'p1', product_name: 'Tee', size: 'M', quantity: 1, unit_price: 10 }],
  hangtag_returns: [{ id: 'r1', sale_id: 's1', t: '7', refund_amount: 5 }],
  hangtag_return_items: [{ return_id: 'r1', sale_line_no: 0, product_id: 'p1', product_name: 'Tee', size: 'M', quantity: 1, unit_price: 10 }],
};
client = fakeClient((q) => ({ data: rows[q.t] || [], error: null }));
const sales = await gw.fetchSales();
check('fetchSales: bills with their lines as app records', sales.length === 1 && sales[0].void === true && sales[0].t === 5 && sales[0].items.length === 1 && sales[0].items[0].q === 1);
const rets = await gw.fetchReturns();
check('fetchReturns: returns with their lines as app records', rets[0].t === 7 && rets[0].refund === 5 && rets[0].pay === 'cash' && rets[0].items[0].ln === 0);
client = fakeClient((q) => (q.t === 'hangtag_images' ? { data: null, error: { message: 'x' } } : { data: [], error: null }));
check('fetchImages: unreadable photos give null, never an exception', (await gw.fetchImages()) === null);
client = fakeClient((q) => ({ data: { value: { lowStock: 2 } }, error: null }));
check('fetchSettings: the saved settings object', (await gw.fetchSettings()).lowStock === 2);
client = fakeClient();
check('signInMethods calls the sign-in methods RPC with the email', JSON.stringify((await gw.signInMethods('a@b.co')).data) === JSON.stringify(['hangtag_sign_in_methods', { p_email: 'a@b.co' }]));

// ---------- mappers ----------
const back = rowToSale(Object.assign(saleRow(sale), { is_void: false }), saleItemRows(sale).map((r) => ({ ...r })).map((r) => ({ product_id: r.product_id, variant_id: r.variant_id, product_name: r.product_name, color: r.color, size: r.size, sku: r.sku, quantity: r.quantity, unit_price: r.unit_price, cost_price: r.cost_price, line_no: r.line_no })));
check('a bill survives the trip to database rows and back', back.id === 's1' && back.total === 1198 && back.pay === 'upi' && back.dev === 'd1');
check('product rows without options keep no lists, so the v3 upgrade derives them from the variants', (() => { const r = rowToProduct({ id: 'p', name: 'N', price: 1, options: null }); return r.colors === undefined && r.sizes === undefined && r.opts === undefined && r.hsn === '' && r.gst === null && r.code === ''; })());
check('product rows with options map to opts, and HSN/GST/code come back', JSON.stringify(rowToProduct({ id: 'p', name: 'N', price: 1, hsn: '6204', gst_rate: '5.00', code_type: 'qr', options: { opts: [{ name: 'Storage', values: ['64 GB'] }] } }).opts) === '[{"n":"Storage","v":["64 GB"]}]'
  && rowToProduct({ id: 'p', name: 'N', price: 1, gst_rate: '5.00', code_type: 'qr', options: {} }).gst === 5);
check('variant rows: empty SKU/barcode become "", missing price/cost stay null, active by default', JSON.stringify(rowToVariant({ id: 'v', color: null, size: 'M' })) === JSON.stringify({ id: 'v', o: [], c: '', s: 'M', sku: '', bc: '', price: null, cost: null, active: true }));
check('variant rows carry their option values', JSON.stringify(rowToVariant({ id: 'v', option_values: ['64 GB', 'Blue'] }).o) === '["64 GB","Blue"]');
check('return and customer rows', rowToReturn({ id: 'r', sale_id: 's', t: '3' }, [rowToReturnItem({ sale_line_no: 2, quantity: 1 })]).items[0].ln === 2 && rowToCustomer({ id: 'c', name: 'A', created_at: 'bad' }).t === 0);

// ---------- local-first repositories ----------
const log = [];
Object.assign(store, { catalog: { version: 2, example: true, products: [{ id: 'p1', name: 'Tee', variants: [{ id: 'v1' }] }] }, moves: { m0: { id: 'm0', v: 'v1', q: 3 } }, imgs: { p1: 'data:x' } });
const persist = { saveCatalog: () => log.push('catalog'), saveMoves: () => log.push('moves'), saveImgs: () => log.push('imgs'), saveSbQueue: () => log.push('queue') };
const outbox = { enqueue: (i) => log.push('enqueue:' + i.type), dropQueued: () => log.push('drop') };
const products = createLocalFirstProductRepository({ store, persist, outbox });
products.save({ product: { id: 'p1', name: 'Boxy Tee', variants: [{ id: 'v1' }] }, isNew: false, renamed: true, newMoves: [{ id: 'm1', v: 'v1', q: 1 }], deletedVariantIds: [], image: '' });
check('product save: catalog, moves, photo, then the uploads in order (photo, product, moves)', log.join() === 'catalog,moves,imgs,enqueue:img,enqueue:prod,enqueue:move' && store.catalog.products[0].name === 'Boxy Tee' && !store.imgs.p1 && store.catalog.example === false, log);
log.length = 0;
products.remove('p1');
check('product remove: catalog, its stock records, photo, queued work dropped, then the delete is queued', log.join() === 'catalog,moves,imgs,drop,enqueue:proddel' && !store.catalog.products.length && !store.moves.m0, log);
log.length = 0;
createLocalFirstStockRepository({ store, persist, outbox }).record({ moves: [{ id: 'm2', v: 'v1', q: 5 }], changedProductId: 'p1' });
check('stock record: moves saved, then the changed product, then the moves are queued', log.join() === 'moves,catalog,enqueue:prod,enqueue:move' && store.moves.m2.q === 5, log);

// ---------- error mapping ----------
const m = (e) => toAppError(e);
check('network failures become NETWORK with a plain message', m({ message: 'TypeError: Failed to fetch' }).code === C.NETWORK && m({ message: 'TypeError: Failed to fetch' }).message === 'No internet connection. It will try again.');
check('RLS refusals become PERMISSION', m({ code: '42501', message: 'new row violates row-level security policy for table "hangtag_sales"' }).code === C.PERMISSION);
const dup = m({ code: '23505', message: 'duplicate key value violates unique constraint "uq_hangtag_variants_sku"' });
check('unique violations become CONFLICT without the constraint name', dup.code === C.CONFLICT && !/uq_/.test(dup.message));
check('expired sign-in becomes AUTH', m({ code: 'PGRST301', message: 'JWT expired' }).code === C.AUTH);
check('a missing table or column becomes OUTDATED_DATABASE', m({ code: 'PGRST205', message: "Could not find the table 'public.hangtag_x' in the schema cache" }).code === C.OUTDATED_DATABASE && m({ code: '42703', message: 'column x does not exist' }).code === C.OUTDATED_DATABASE);
check('rules from schema.sql keep their own (human) message', m({ code: '23514', message: "Can't return 2 piece(s): 1 bought, 0 already returned" }).message === "Can't return 2 piece(s): 1 bought, 0 already returned");
const odd = m({ code: 'XX000', message: 'internal error at pg_foo.c:123' });
check('anything else: a plain message, never the raw text', odd.code === C.UNKNOWN && !/pg_foo/.test(odd.message));
check('an AppError passes through unchanged', (() => { const a = new AppError(C.VALIDATION, 'x'); return toAppError(a) === a; })());
client = fakeClient(() => ({ error: { code: 'PGRST205', message: "Could not find the table 'public.hangtag_variants' in the schema cache" } }));
check('checkSchema: missing tables report OUTDATED_DATABASE (the app shows "Database update needed")', (await gw.checkSchema()).error.code === C.OUTDATED_DATABASE);
client = fakeClient(() => ({ error: null }));
check('checkSchema: a current database reports no error', (await gw.checkSchema()).error === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
