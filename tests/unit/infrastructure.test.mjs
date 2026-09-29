// Unit tests for infrastructure: the Supabase gateway (against a fake supabase-js client that records every call),
// the row mappers, and the local-first repositories. Run: npm run test:unit
import { createCloudGateway } from '../../src/infrastructure/supabase/cloud-gateway.js';
import { toAppError } from '../../src/infrastructure/supabase/errors.js';
import { AppError, ERROR_CODES as C } from '../../src/shared/errors/app-error.js';
import { billArgs, paymentRows, rowToCustomer, rowToItem, rowToPayment, rowToProduct, rowToReturn, rowToReturnItem, rowToSale, rowToVariant, saleItemRows, saleRow } from '../../src/infrastructure/supabase/mappers.js';
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
  // RPC calls are recorded too, as { t: 'rpc:<name>', ops: [['rpc', [args]]] }
  const rpc = async (n, a) => { const q = { t: 'rpc:' + n, ops: [['rpc', [a]]] }; calls.push(q); const r = answer(q); return r && r.error ? r : { data: [n, a], error: null }; };
  return { calls, from, auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) }, rpc };
}
const opNames = (q) => q.ops.map((o) => o[0]).join('.');

// ---------- gateway: uploads ----------
let client = fakeClient();
const gw = createCloudGateway({ getClient: () => client, url: 'https://x.supabase.co/', key: 'pk', storageKey: 'k' });
const sale = { id: 's1', t: 1000, items: [{ ln: 0, v: 'v1', p: 'p1', n: 'Tee', c: 'Black', s: 'M', q: 2, price: 599, cost: 300 }], sub: 1198, disc: 0, total: 1198, pay: 'upi', dev: 'd1' };
await gw.saveSale(sale);
const arg = (q) => q.ops[0][1][0];
check('saveSale: one call saves the bill (not cancelled) with its lines and its payment, all or nothing', client.calls.map((q) => q.t).join() === 'rpc:hangtag_save_sales'
  && arg(client.calls[0]).p_bills.length === 1 && arg(client.calls[0]).p_bills[0].sale.is_void === false && arg(client.calls[0]).p_bills[0].items[0].line_no === 0
  && JSON.stringify(arg(client.calls[0]).p_bills[0].payments) === JSON.stringify([{ id: 's1:upi', sale_id: 's1', method: 'upi', amount: 1198, tendered: null, change_given: 0, reference: null, t: 1000, device_id: 'd1', verification: 'recorded', via: null, intent_id: null, provider_payment_id: null, card_last4: null }]), client.calls);
client = fakeClient();   // a different client: the gateway must use whichever is current
await gw.setSaleVoid('s1', true);
check('the gateway reads the current client on every call (a cancel asks for the changed bill back; none: is it still there?)', client.calls.length === 2 && opNames(client.calls[0]) === 'update.eq.select'
  && client.calls[0].ops[0][1][0].is_void === true && opNames(client.calls[1]) === 'select.eq.limit');
// row security skips a row a team member may see but not change: nothing written back, the row still there → PERMISSION
client = fakeClient((q) => ({ data: opNames(q).startsWith('select') ? [{ id: 's1' }] : [], error: null }));
let err = null; try { await gw.setSaleVoid('s1', true, 'Wrong'); } catch (e) { err = e; }
check('a cancel the database quietly skipped (row security) is refused, not taken as done', err instanceof AppError && err.code === C.PERMISSION, err && err.code);
client = fakeClient((q) => ({ data: opNames(q).startsWith('update') ? [{ id: 's1' }] : [], error: null }));
err = null; try { await gw.setSaleVoid('s1', true, 'Wrong'); } catch (e) { err = e; }
check('…while a cancel that reached its bill is done in one call', !err && client.calls.length === 1);
client = fakeClient();
err = null; try { await gw.deleteEvent('gone'); } catch (e) { err = e; }
check('…and removing something already gone is nothing to do', !err);
client = fakeClient((q) => (q.t === 'rpc:hangtag_save_sales' ? { error: { message: 'boom' } } : { data: [], error: null }));
err = null; try { await gw.saveSale(sale); } catch (e) { err = e; }
check('an upload error is thrown as an AppError (plain message, original kept as cause) and nothing after it is sent', err instanceof AppError && err.code === C.UNKNOWN && err.cause.message === 'boom' && !/boom/.test(err.message) && client.calls.length === 1, err);
client = fakeClient();
await gw.saveProduct({ id: 'p1', name: 'Tee', price: 599, color: '#000000', variants: [{ id: 'v1', c: 'Black', s: 'M', active: true }] }, 3);
check('saveProduct: product row with its sort order, then its variants', client.calls.map((q) => q.t).join() === 'hangtag_products,hangtag_variants' && client.calls[0].ops[0][1][0].sort_order === 3);
client = fakeClient();
await gw.saveImage('p1', ''); await gw.saveImage('p1', 'data:x');
check('saveImage: empty removes the photo, a data URL stores it', opNames(client.calls[0]) === 'delete.eq.select' && opNames(client.calls[2]) === 'upsert' && client.calls[2].ops[0][1][0].image_data === 'data:x');
// a return: one RPC with the return and its lines (all or nothing); a refusal keeps the database rule's own message
client = fakeClient();
const ret = { id: 'r1', no: 'CN-260928-001', sale: 's1', t: 1, kind: 'return', refund: 524.5, pay: 'cash', value: 524.5, ro: 0, dev: 'd1',
  items: [{ ln: 0, q: 1, p: 'p1', n: 'Tee', price: 524.5, value: 524.5, restock: false, tx: 499.52, cgst: 12.49, sgst: 12.49, igst: 0, gst: 5, hsn: '6109' }] };
await gw.saveReturn(ret);
check('saveReturn: one call (RPC hangtag_save_return) with the credit note, paise, GST reversed and "not for resale"', client.calls.map((q) => q.t).join() === 'rpc:hangtag_save_return'
  && arg(client.calls[0]).p_return.credit_no === 'CN-260928-001' && arg(client.calls[0]).p_return.refund_amount === 524.5 && arg(client.calls[0]).p_return.round_off === 0
  && arg(client.calls[0]).p_items[0].restock === false && arg(client.calls[0]).p_items[0].taxable_value === 499.52 && arg(client.calls[0]).p_items[0].cgst_amount === 12.49 && arg(client.calls[0]).p_items[0].hsn === '6109', arg(client.calls[0]));
client = fakeClient((q) => (q.t === 'rpc:hangtag_save_return' ? { error: { code: '23514', message: "Can't return 1 piece(s): 2 bought, 2 already returned" } } : { data: [], error: null }));
err = null; try { await gw.saveReturn({ id: 'r1', sale: 's1', t: 1, items: [{ ln: 0, q: 1, p: 'p1', n: 'Tee' }] }); } catch (e) { err = e; }
check("saveReturn refused: nothing else is written, the database rule's own message kept", err && err.code === C.VALIDATION && err.message === "Can't return 1 piece(s): 2 bought, 2 already returned" && client.calls.length === 1);
client = fakeClient();
await gw.saveEvent({ id: 'e1', name: 'Diwali pop-up', start: '2026-10-20', end: '2026-10-22', place: 'Pune', status: 'active', t: 5 });
await gw.deleteEvent('e1');
check('saveEvent / deleteEvent: hangtag_events row (dates, place, status), then a delete by id', client.calls.map((q) => q.t + ':' + opNames(q)).slice(0, 2).join(' | ') === 'hangtag_events:upsert | hangtag_events:delete.eq.select'
  && client.calls[0].ops[0][1][0].start_date === '2026-10-20' && client.calls[0].ops[0][1][0].location === 'Pune' && client.calls[0].ops[0][1][0].status === 'active', client.calls.map((q) => q.ops));
client = fakeClient();
await gw.saveAllSales(Array.from({ length: 501 }, (_, i) => Object.assign({}, sale, { id: 's' + i, void: i === 0 })));
check('saveAllSales: bills (with lines and payments) in calls of 100, cancelled flag kept', client.calls.length === 6 && client.calls.every((q) => q.t === 'rpc:hangtag_save_sales')
  && arg(client.calls[0]).p_bills.length === 100 && arg(client.calls[5]).p_bills.length === 1 && arg(client.calls[0]).p_bills[0].sale.is_void === true && arg(client.calls[0]).p_bills[1].sale.is_void === false
  && arg(client.calls[0]).p_bills[0].items.length === 1 && arg(client.calls[0]).p_bills[0].payments.length === 1);

// ---------- gateway: downloads ----------
const rows = {
  hangtag_sales: [{ id: 's1', timestamp: 5, subtotal: 10, discount: 0, total: 10, payment_method: 'cash', device_id: 'd1', is_void: true }],
  hangtag_sale_items: [{ sale_id: 's1', line_no: 0, product_id: 'p1', product_name: 'Tee', size: 'M', quantity: 1, unit_price: 10 }],
  hangtag_payments: [{ id: 's1:cash', sale_id: 's1', method: 'cash', amount: '6.00', tendered: '10.00', change_given: '4.00' }, { id: 's1:upi', sale_id: 's1', method: 'upi', amount: '4.00', tendered: null, change_given: '0', reference: 'U1' }],
  hangtag_returns: [{ id: 'r1', sale_id: 's1', t: '7', refund_amount: 5 }],
  hangtag_return_items: [{ return_id: 'r1', sale_line_no: 0, product_id: 'p1', product_name: 'Tee', size: 'M', quantity: 1, unit_price: 10 }],
};
client = fakeClient((q) => ({ data: rows[q.t] || [], error: null }));
const sales = await gw.fetchSales();
check('fetchSales: bills with their lines as app records', sales.length === 1 && sales[0].void === true && sales[0].t === 5 && sales[0].items.length === 1 && sales[0].items[0].q === 1);
check('fetchSales: each bill with its payments (numbers from NUMERIC columns, cash change, UPI reference)', JSON.stringify(sales[0].payments) === JSON.stringify([{ id: 's1:cash', method: 'cash', amount: 6, received: 10, change: 4 }, { id: 's1:upi', method: 'upi', amount: 4, ref: 'U1' }]), sales[0].payments);
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
// a bill with discounts, GST (CGST + SGST), round off and a split payment
const gstSale = { id: 's9', no: 'INV-1', t: 9, dev: 'd1', kind: 'sale', credit: 0, sub: 2248, disc: 249.8, itemDisc: 199.8, billDisc: { type: 'fixed', value: 50 }, billDiscAmt: 50,
  taxable: 1998.2, tax: 99.92, cgst: 49.96, sgst: 49.96, igst: 0, taxRate: 5, taxIncl: false, gst: { mode: 'intra', pos: '27' }, roundOff: -0.12, total: 2098, pay: 'split',
  cust: { id: 'c1', name: 'Shah Traders', phone: '', gstin: '27ABCDE1234F1Z5', type: 'business' },
  items: [{ ln: 0, p: 'p1', v: 'v1', n: 'Tee', c: '', s: 'M', q: 2, price: 999, cost: null, disc: { type: 'percent', value: 10 }, dAmt: 199.8, bdAmt: 43.9, gst: 5, hsn: '6109', tx: 1754.3, cgst: 43.86, sgst: 43.86, igst: 0, lt: 1842.02 }],
  payments: [{ id: 's9:cash', method: 'cash', amount: 500, received: 600, change: 100 }, { id: 's9:upi', method: 'upi', amount: 1598, ref: 'UTR1' }] };
const sr = saleRow(gstSale), ir = saleItemRows(gstSale)[0], pr = paymentRows(gstSale);
check('saleRow: discounts, GST split, round off, place of supply and the customer GSTIN go to their columns',
  sr.item_discount === 199.8 && sr.bill_discount === 50 && sr.bill_discount_type === 'fixed' && sr.bill_discount_value === 50 && sr.taxable_amount === 1998.2 && sr.cgst_amount === 49.96
  && sr.igst_amount === 0 && sr.round_off === -0.12 && sr.gst_mode === 'intra' && sr.place_of_supply === '27' && sr.customer_gstin === '27ABCDE1234F1Z5' && sr.customer_type === 'business' && sr.payment_method === 'split', sr);
check('saleItemRows: the line discount, its bill-discount share and its GST', ir.discount_type === 'percent' && ir.discount_value === 10 && ir.discount_amount === 199.8 && ir.bill_discount_share === 43.9 && ir.gst_rate === 5 && ir.line_total === 1842.02 && ir.hsn === '6109', ir);
check('paymentRows: one row per method; cash keeps what was handed over and the change', JSON.stringify(pr.map((x) => [x.id, x.method, x.amount, x.tendered, x.change_given, x.reference])) === JSON.stringify([['s9:cash', 'cash', 500, 600, 100, null], ['s9:upi', 'upi', 1598, null, 0, 'UTR1']]));
const back2 = rowToSale({ ...sr, is_void: false, discount: '249.80', tax_amount: '99.92', item_discount: '199.80', cgst_amount: '49.96', sgst_amount: '49.96', igst_amount: '0.00', round_off: '-0.12', taxable_amount: '1998.20' },
  [rowToItem({ ...ir, discount_value: '10.00', discount_amount: '199.80', line_total: '1842.02' })], pr.map(rowToPayment));
check('a bill with discounts, GST and payments survives the trip to rows and back', back2.disc === 249.8 && back2.tax === 99.92 && back2.cgst === 49.96 && back2.roundOff === -0.12 && back2.gst.mode === 'intra'
  && back2.billDisc.type === 'fixed' && back2.items[0].disc.value === 10 && back2.items[0].lt === 1842.02 && back2.cust.gstin === '27ABCDE1234F1Z5' && back2.payments.length === 2 && back2.payments[0].change === 100, back2);
const legacyRow = saleRow({ id: 'o1', t: 1, sub: 1050, disc: 50, tax: 48, taxRate: 5, taxIncl: true, total: 1000, pay: 'cash', dev: 'd', items: [] });
check('a bill saved before the GST split (tax only) uploads as CGST + SGST halves with its discount on the whole bill', legacyRow.gst_mode === 'intra' && legacyRow.cgst_amount === 24 && legacyRow.sgst_amount === 24 && legacyRow.bill_discount === 50 && legacyRow.item_discount === 0 && legacyRow.taxable_amount === 952, legacyRow);
check('...and its one payment is what was due, by its method', JSON.stringify(billArgs({ id: 'o1', t: 1, total: 1000, credit: 200, pay: 'cash', dev: 'd', items: [] }).payments) === JSON.stringify([{ id: 'o1:cash', sale_id: 'o1', method: 'cash', amount: 800, tendered: 800, change_given: 0, reference: null, t: 1, device_id: 'd', verification: 'recorded', via: null, intent_id: null, provider_payment_id: null, card_last4: null }]));
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
check('checkSchema: a current database reports no error (it looks for the events table, the newest)', (await gw.checkSchema()).error === null && client.calls[0].t === 'hangtag_events');
check('a missing database function (the bill RPC before schema.sql) becomes OUTDATED_DATABASE', m({ code: 'PGRST202', message: 'Could not find the function public.hangtag_save_sales' }).code === C.OUTDATED_DATABASE);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
