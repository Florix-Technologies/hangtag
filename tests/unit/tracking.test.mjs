// Serial numbers, batches and expiry (Wave 2, schema.sql section 3n): parsing serials, a serial's state and history from
// stock records, bills and returns (sold, cancelled bill, returned, not for resale, written off, purchase cancelled),
// batch stock (purchase, first-to-expire sales, returns back into their batches, adjustments), expiry states, purchases
// and stock operations with serials / batches, the stock count by batch, the mappers and the upload order. Run: npm run test:unit
import { allocateBatches, batchStates, checkBatchNo, checkExpiry, expiryState, incomingSerialError, lineSerialError, parseSerials, plusDays, returnBatchAlloc, serialAvailable, serialStates } from '../../src/domain/inventory/tracking.js';
import { buildPurchase, cancelPurchaseMoves } from '../../src/domain/inventory/purchase.js';
import { buildTrackedMoves } from '../../src/domain/inventory/stock-operation.js';
import { countDiffs, countMoves } from '../../src/domain/inventory/stock-count.js';
import { ledgerEntries, onHand } from '../../src/domain/inventory/stock-ledger.js';
import { productFieldsFor, trackingChoiceOf, trackingChoices, trackingFromChoice, capsFor } from '../../src/domain/shop/capabilities.js';
import { checkExpirySettings } from '../../src/domain/shop/settings-validation.js';
import { dependsOn, isBlocked, providesKeys, waitingKeys } from '../../src/domain/sync/queue-rules.js';
import { moveRow, productRow, returnItemRows, rowToItem, rowToMove, rowToProduct, rowToReturnItem, saleItemRows } from '../../src/infrastructure/supabase/mappers.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('--- serial numbers typed ---');
check('one per line, spaces, commas, semicolons; kept in capitals', eq(parseSerials(' sn1\nsn2, SN3;sn4  ').serials, ['SN1', 'SN2', 'SN3', 'SN4']));
check('a range SN001..SN003 (the width kept)', eq(parseSerials('SN008..SN011').serials, ['SN008', 'SN009', 'SN010', 'SN011']));
check('twice, a bad one, a range counting down: refused', /twice/.test(parseSerials('A1 a1').error) && /isn't a serial/.test(parseSerials('A1 *x').error) && /counts down/.test(parseSerials('A5..A1').error));
check('batch numbers: capitals, trimmed; empty or bad refused', checkBatchNo('  b-12 x ').b === 'B-12 X' && !!checkBatchNo('').error && !!checkBatchNo('$$').error);

console.log('--- expiry ---');
const T = '2026-09-30';
check('expired the day after its date; soon within the warning days; fresh after; none without a date',
  expiryState('2026-09-29', T, 30) === 'expired' && expiryState('2026-09-30', T, 30) === 'soon' && expiryState(plusDays(T, 30), T, 30) === 'soon'
  && expiryState(plusDays(T, 31), T, 30) === 'fresh' && expiryState(null, T, 30) === null);
check('the warning period follows the setting (7 days)', expiryState(plusDays(T, 10), T, 7) === 'fresh' && expiryState(plusDays(T, 7), T, 7) === 'soon');
check('expiry typed: required when the product keeps them; a past date refused; a batch keeps its first date',
  /Enter the expiry/.test(checkExpiry('', { required: true }).error) && /has passed/.test(checkExpiry('2026-01-01', { today: T }).error)
  && /already has the expiry date 2027-01-01/.test(checkExpiry('2027-02-01', { known: '2027-01-01' }).error) && checkExpiry('', { required: true, known: '2027-01-01' }).exp === '2027-01-01');
check('expiry settings: 0-365 whole days', checkExpirySettings({ expiryDays: '14', sellExpired: true }).patch.expiryDays === 14 && !!checkExpirySettings({ expiryDays: '-1' }).error && !!checkExpirySettings({ expiryDays: '2.5' }).error);

console.log('--- a serial through the flow: purchase, sale, cancel, restore, return ---');
const moves = { m1: { id: 'm1', v: 'ph:', p: 'ph', type: 'RESTOCK', q: 3, t: 1, sn: ['SN001', 'SN002', 'SN003'], imp: 'pur1' } };
const sale = { id: 's1', no: 'INV-1', t: 2, items: [{ ln: 0, v: 'ph:', p: 'ph', n: 'Phone', q: 1, sn: ['SN002'] }], cust: { id: 'c1', name: 'Asha', phone: '9876543210' } };
let S = serialStates({ moves, sales: [sale], returns: [] });
check('3 serials in; SN002 sold on INV-1 to Asha', S.size === 3 && S.get('SN001').status === 'IN_STOCK' && S.get('SN002').status === 'SOLD' && S.get('SN002').saleId === 's1'
  && S.get('SN002').cust.name === 'Asha' && S.get('SN001').imp === 'pur1', [...S.values()]);
check('its history: purchased, then sold', eq(S.get('SN002').history.map((h) => h.what), ['Purchased', 'Sold']));
check('a sold serial can\'t go on another bill; one in stock can', /already sold/.test(lineSerialError({ v: 'ph:', q: 1, sn: ['SN002'] }, (x) => S.get(x))) && lineSerialError({ v: 'ph:', q: 1, sn: ['sn001'] }, (x) => S.get(x)) === null);
check('serial lines: one per piece, of the variant, chosen at all', /Choose the serial/.test(lineSerialError({ v: 'ph:', q: 1, sn: [] }, (x) => S.get(x)))
  && /2 pieces but 1/.test(lineSerialError({ v: 'ph:', q: 2, sn: ['SN001'] }, (x) => S.get(x))) && /isn't in stock for/.test(lineSerialError({ v: 'other', q: 1, sn: ['SN001'] }, (x) => S.get(x))));
S = serialStates({ moves, sales: [{ ...sale, void: true }], returns: [] });
check('the bill cancelled: SN002 is in stock again (history keeps it)', S.get('SN002').status === 'IN_STOCK' && S.get('SN002').history.some((h) => /cancelled/.test(h.what)));
const ret = { id: 'r1', no: 'CN-1', sale: 's1', t: 3, items: [{ ln: 0, v: 'ph:', p: 'ph', q: 1, sn: ['SN002'] }] };
S = serialStates({ moves, sales: [sale], returns: [ret] });
check('returned: back on the shelf (RETURNED, ready to sell)', S.get('SN002').status === 'RETURNED' && serialAvailable(S.get('SN002')) && S.get('SN002').returnId === 'r1');
S = serialStates({ moves, sales: [sale], returns: [{ ...ret, items: [{ ...ret.items[0], restock: false }] }] });
check('returned not for resale: written off (DAMAGED)', S.get('SN002').status === 'DAMAGED' && !serialAvailable(S.get('SN002')));
S = serialStates({ moves: { ...moves, w: { id: 'w', v: 'ph:', p: 'ph', type: 'ADJUST', q: -1, t: 4, sn: ['SN003'] }, x: { id: 'pcx:m9', v: 'ph:', type: 'ADJUST', q: -1, t: 5, sn: ['SN001'] } }, sales: [], returns: [] });
check('an adjustment writes a serial off; a purchase cancel cancels it', S.get('SN003').status === 'DAMAGED' && S.get('SN001').status === 'CANCELLED');
check('stock-in of a serial in stock or sold refused; written off / cancelled may come back', /already in stock/.test(incomingSerialError(['SN002'], () => ({ status: 'IN_STOCK' })))
  && /Take it back with a return/.test(incomingSerialError(['SN002'], () => ({ status: 'SOLD' }))) && incomingSerialError(['SN001'], () => ({ status: 'CANCELLED' })) === null);
const L = onHand(ledgerEntries({ moves, sales: [sale], returns: [] }));
check('stock stays the ledger: 3 in − 1 sold = 2, the same as the serials ready to sell', L['ph:'] === 2 && [...serialStates({ moves, sales: [sale], returns: [] }).values()].filter(serialAvailable).length === 2);
check('ledger entries carry the serials (for the history)', eq(ledgerEntries({ moves, sales: [sale], returns: [] }).find((e) => e.type === 'SALE').sn, ['SN002']));

console.log('--- batches: purchase, first to expire, returns, adjustments ---');
const bm = { a: { id: 'a', v: 'rice:', p: 'rice', type: 'RESTOCK', q: 10, t: 1, b: 'B1', exp: '2026-12-31', cost: 50, imp: 'pur1' },
  b: { id: 'b', v: 'rice:', p: 'rice', type: 'RESTOCK', q: 5.5, t: 2, b: 'B2', exp: '2026-11-30' } };
let Bs = batchStates({ moves: bm, sales: [], returns: [] });
check('two batches with their stock, expiry, cost and purchase', Bs.byVid['rice:'].B1.qty === 10 && Bs.byVid['rice:'].B2.qty === 5.5 && Bs.byVid['rice:'].B1.cost === 50 && Bs.byVid['rice:'].B1.imp === 'pur1');
const list = Object.values(Bs.byVid['rice:']);
check('first to expire goes first (B2 before B1), across batches', eq(allocateBatches(list, 7.25).alloc, [{ b: 'B2', q: 5.5 }, { b: 'B1', q: 1.75 }]));
check('a chosen batch first', eq(allocateBatches(list, 2, { prefer: 'B1' }).alloc, [{ b: 'B1', q: 2 }]));
check('expired batches skipped when the shop doesn\'t sell expired stock; what is missing is told', eq(allocateBatches(list, 12, { today: '2026-12-01', blockExpired: true }), { alloc: [{ b: 'B1', q: 10 }], short: 2 }));
check('what other lines of the bill took is counted', eq(allocateBatches(list, 1, { taken: { B2: 5.5 } }).alloc, [{ b: 'B1', q: 1 }]));
const bsale = { id: 's2', no: 'INV-2', t: 3, items: [{ ln: 0, v: 'rice:', p: 'rice', q: 7.25, u: 'kg', bt: [{ b: 'B2', q: 5.5 }, { b: 'B1', q: 1.75 }] }] };
Bs = batchStates({ moves: bm, sales: [bsale], returns: [] });
check('a sale takes from its batches: B2 0, B1 8.25', Bs.byVid['rice:'].B2.qty === 0 && Bs.byVid['rice:'].B1.qty === 8.25);
check('a return goes back where the line came from, in its order', eq(returnBatchAlloc(bsale.items[0].bt, [], 6), [{ b: 'B2', q: 5.5 }, { b: 'B1', q: 0.5 }])
  && eq(returnBatchAlloc(bsale.items[0].bt, [{ b: 'B2', q: 5.5 }], 1), [{ b: 'B1', q: 1 }]));
const bret = { id: 'r2', sale: 's2', t: 4, items: [{ ln: 0, v: 'rice:', p: 'rice', q: 2, bt: [{ b: 'B2', q: 2 }] }] };
Bs = batchStates({ moves: bm, sales: [bsale], returns: [bret] });
check('returned 2 kg: B2 back to 2', Bs.byVid['rice:'].B2.qty === 2);
Bs = batchStates({ moves: bm, sales: [{ ...bsale, void: true }], returns: [] });
check('the bill cancelled: both batches whole again', Bs.byVid['rice:'].B2.qty === 5.5 && Bs.byVid['rice:'].B1.qty === 10);
Bs = batchStates({ moves: bm, sales: [{ id: 'old', t: 3, items: [{ ln: 0, v: 'rice:', q: 6 }] }], returns: [{ id: 'r3', sale: 'old', t: 4, items: [{ ln: 0, v: 'rice:', q: 1 }] }], batchTracked: (v) => v === 'rice:' });
check('a line saved without batches (an older app) takes first to expire; its return goes back the same way', Bs.byVid['rice:'].B2.qty === 1 && Bs.byVid['rice:'].B1.qty === 9.5 && eq(Bs.lineAlloc['old|0'], [{ b: 'B2', q: 5.5 }, { b: 'B1', q: 0.5 }]));
check('each batch keeps its history', eq(batchStates({ moves: bm, sales: [bsale], returns: [bret] }).byVid['rice:'].B2.history.map((h) => [h.what, h.q]), [['Stock in', 5.5], ['Sold', -5.5], ['Returned', 2]]));

console.log('--- purchases with serials and batches ---');
const trk = { 'ph:': { tracking: 'serial' }, 'rice:': { tracking: 'batch', expiry: true } };
const pin = (lines, extra = {}) => buildPurchase({ id: 'pu9', supplierId: 's1', supplierName: 'Ravi', invoiceNo: 'I-9', t: 10, dev: 'd1', lines, paid: '', ...extra },
  { today: T, trackingOf: (l) => trk[l.v] || null, serialState: (x) => (x === 'OLD1' ? { status: 'IN_STOCK' } : null), batchOf: () => null, moveId: (i) => 'pm' + i, allowDuplicate: true });
let pu = pin([{ p: 'ph', v: 'ph:', n: 'Phone', q: '3', cost: '9000', serials: ['a1', 'A2', 'A3'] }, { p: 'rice', v: 'rice:', n: 'Rice', q: '12.5', dec: 3, cost: '48', batch: { no: 'b7', exp: '2027-03-31' } }]);
check('a purchase: 3 phones with serials, 12.5 kg of rice in batch B7 (its expiry kept)', !pu.error && eq(pu.moves[0].sn, ['A1', 'A2', 'A3']) && pu.moves[1].b === 'B7' && pu.moves[1].exp === '2027-03-31'
  && pu.moves[1].q === 12.5 && eq(pu.purchase.lines[0].serials, ['A1', 'A2', 'A3']) && pu.purchase.lines[1].batch.no === 'B7', pu);
check('serials: one per piece, each once, not already in stock', /3 pieces but 2/.test(pin([{ p: 'ph', v: 'ph:', q: '3', cost: '1', serials: ['A1', 'A2'] }]).error)
  && /twice/.test(pin([{ p: 'ph', v: 'ph:', q: '1', cost: '1', serials: ['A1'] }, { p: 'ph', v: 'ph:', q: '1', cost: '1', serials: ['a1'] }]).error)
  && /already in stock/.test(pin([{ p: 'ph', v: 'ph:', q: '1', cost: '1', serials: ['OLD1'] }]).error));
check('a batch needs its number, and its expiry when the product keeps them', /batch number/.test(pin([{ p: 'rice', v: 'rice:', q: '1', cost: '1', batch: { no: '' } }]).error)
  && /expiry date/.test(pin([{ p: 'rice', v: 'rice:', q: '1', cost: '1', batch: { no: 'B1' } }]).error));
check('whole pieces for serial products (decimal quantities still fine for kg)', /whole number/.test(pin([{ p: 'ph', v: 'ph:', q: '1.5', cost: '1', serials: ['A1'] }]).error));
const cx = cancelPurchaseMoves({ id: 'pu9', kind: 'purchase', status: 'posted' }, pu.moves.map((m) => ({ ...m, imp: 'pu9' })), { reason: 'Wrong supplier', t: 11, dev: 'd1' });
check('cancelling it takes the same serials and batch back out', eq(cx.moves[0].sn, ['A1', 'A2', 'A3']) && cx.moves[0].q === -3 && cx.moves[1].b === 'B7' && cx.moves[1].q === -12.5 && cx.moves[0].id === 'pcx:pm0');

console.log('--- stock in / adjust of tracked products, stock count by batch ---');
let id = 0; const nid = () => 'x' + (++id);
const sctx = { serialState: (x) => ({ S1: { vid: 'ph:', status: 'IN_STOCK' }, S9: { vid: 'ph:', status: 'SOLD' } })[x] || null, batchOf: (v, b) => (b === 'B1' ? { qty: 10, exp: '2026-12-31' } : null) };
const op = (o) => ({ productId: 'ph', now: 5, deviceId: 'd1', today: T, reason: 'Damaged', ...o });
let tm = buildTrackedMoves(op({ kind: 'in', tracking: 'serial' }), { 'ph:': 'N1..N3' }, sctx, nid);
check('serial stock in: one RESTOCK with 3 serials', tm.moves.length === 1 && tm.moves[0].q === 3 && eq(tm.moves[0].sn, ['N1', 'N2', 'N3']) && tm.moves[0].type === 'RESTOCK');
tm = buildTrackedMoves(op({ kind: 'adjust', tracking: 'serial' }), { 'ph:': { out: ['S1'], add: '' } }, sctx, nid);
check('serial adjust: S1 written off (−1 with its serial)', tm.moves.length === 1 && tm.moves[0].q === -1 && eq(tm.moves[0].sn, ['S1']));
check('a sold serial can\'t be written off', /isn't in stock/.test(buildTrackedMoves(op({ kind: 'adjust', tracking: 'serial' }), { 'ph:': { out: ['S9'] } }, sctx, nid).error));
tm = buildTrackedMoves(op({ kind: 'in', tracking: 'batch', expiry: true, unit: 'kg', productId: 'rice' }), { 'rice:': { q: '2.5', b: 'b2', exp: '2027-01-15' } }, sctx, nid);
check('batch stock in: 2.5 kg into B2 with its expiry', tm.moves[0].q === 2.5 && tm.moves[0].b === 'B2' && tm.moves[0].exp === '2027-01-15');
tm = buildTrackedMoves(op({ kind: 'adjust', tracking: 'batch', unit: 'kg', productId: 'rice' }), { 'rice:|B1': '7.5' }, sctx, nid);
check('batch adjust: counted 7.5 of 10 → −2.5 on B1', tm.moves[0].q === -2.5 && tm.moves[0].b === 'B1' && tm.moves[0].type === 'ADJUST');
const cd = countDiffs([{ vid: 'rice:', pid: 'rice', system: 10, dec: 3, key: 'rice:|B1', b: 'B1' }, { vid: 'tee:', pid: 'tee', system: 4 }], { 'rice:|B1': '9', 'tee:': '4' });
const cm = countMoves(cd.changed, { reason: 'Expired', now: 1, dev: 'd', newId: nid, currentStock: (v, b) => (b ? 10 : 4) });
check('stock count: a batch counted on its own row → ADJUST of that batch', cd.changed.length === 1 && cm.moves[0].b === 'B1' && cm.moves[0].q === -1 && /Stock count: Expired/.test(cm.moves[0].note));

console.log('--- the product form, mappers, upload order ---');
const fx = productFieldsFor(capsFor('grocery'), {});
check('grocery: Track stock by None / Batch / Batch with expiry date', eq(trackingChoices(fx).map((c) => c.key), ['none', 'batch', 'expiry']));
check('electronics: None / Serial number', eq(trackingChoices(productFieldsFor(capsFor('electronics'), {})).map((c) => c.key), ['none', 'serial']));
check('retail: none of it unless switched on', !productFieldsFor(capsFor('retail'), {}).tracking && productFieldsFor(capsFor('retail', { uses_serials: true }), {}).tracking);
check('the choice and back: batch + expiry dates', eq(trackingFromChoice('expiry'), { tracking: 'batch', expiry: true }) && trackingChoiceOf({ tracking: 'batch', expiry: true }) === 'expiry' && trackingChoiceOf({ tracking: 'serial' }) === 'serial');
const pr = productRow({ id: 'rice', name: 'Rice', price: 60, tracking: 'batch', expiry: true, opts: [], variants: [] }, 0);
check('product: tracks_expiry saved and read back', pr.tracks_expiry === true && rowToProduct({ ...pr, options: { opts: [] } }).expiry === true && productRow({ id: 'x', name: 'x', price: 1, opts: [], variants: [] }, 0).tracks_expiry === false);
const mr = moveRow({ id: 'm', v: 'rice:', p: 'rice', type: 'RESTOCK', q: 2.5, t: 1, b: 'b1', exp: '2027-01-01' });
check('stock record: batch and expiry out, and back', mr.batch_no === 'B1' && mr.expiry === '2027-01-01' && mr.serials === null && rowToMove(mr).b === 'B1' && rowToMove(mr).exp === '2027-01-01');
check('stock record: serials out (capitals) and back', eq(moveRow({ id: 'm', v: 'ph:', type: 'RESTOCK', q: 1, t: 1, sn: ['a1'] }).serials, ['A1']) && eq(rowToMove({ id: 'm', variant_id: 'ph:', qty: '1.000', serials: ['A1'], t: 1 }).sn, ['A1']));
const it = saleItemRows({ id: 's', items: [{ ln: 0, v: 'rice:', p: 'rice', n: 'Rice', q: 7.25, price: 60, bt: [{ b: 'B2', q: 5.5 }, { b: 'B1', q: 1.75 }] }, { ln: 1, v: 'ph:', p: 'ph', n: 'Phone', q: 1, price: 9000, sn: ['A2'] }] });
check('bill lines: batches and serials out, and back', eq(it[0].batches, [{ b: 'B2', q: 5.5 }, { b: 'B1', q: 1.75 }]) && eq(it[1].serials, ['A2']) && it[0].serials === null
  && eq(rowToItem({ ...it[0], quantity: '7.250' }).bt, [{ b: 'B2', q: 5.5 }, { b: 'B1', q: 1.75 }]) && eq(rowToItem(it[1]).sn, ['A2']));
const ri = returnItemRows({ id: 'r', sale: 's', items: [{ ln: 1, v: 'ph:', p: 'ph', n: 'Phone', q: 1, price: 9000, sn: ['A2'] }] });
check('return lines: serials out, and back', eq(ri[0].serials, ['A2']) && eq(rowToReturnItem(ri[0]).sn, ['A2']));
const purchaseItem = { type: 'purchase', id: 'pu9', purchase: pu.purchase, moves: pu.moves };
const saleItem = { type: 'sale', sale: { id: 's5', items: [{ v: 'ph:', q: 1, sn: ['A2'] }, { v: 'rice:', q: 1, bt: [{ b: 'B7', q: 1 }] }] } };
check('a purchase brings its serials and batches in (upload keys)', eq(providesKeys(purchaseItem), ['sn:A1', 'sn:A2', 'sn:A3', 'bt:rice:|B7']));
check('a bill with those serials / batches waits while the purchase is still on its way', eq(dependsOn(saleItem), ['sn:A2', 'bt:rice:|B7']) && isBlocked(saleItem, waitingKeys([purchaseItem, saleItem]))
  && !isBlocked(saleItem, waitingKeys([saleItem])));
check('a write-off waits for the stock-in of its serial; a stock-in doesn\'t wait for itself', dependsOn({ type: 'move', move: { id: 'w', p: 'ph', v: 'ph:', q: -1, sn: ['N1'] } }).includes('sn:N1')
  && !dependsOn({ type: 'move', move: { id: 'i', p: 'ph', v: 'ph:', q: 1, sn: ['N1'] } }).includes('sn:N1'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
