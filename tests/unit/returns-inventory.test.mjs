// Phase 17 (returns and exchanges) and Phase 18 (the stock ledger): return values from the saved bill (discounts, GST,
// round off, to the paisa), the RecordReturn use case (stock, books, credit notes, exchanges, not-for-resale), and every
// stock change as one ledger. Run: npm run test:unit
import { exchangeSettlement, quoteReturn, returnedSoFar, savedLine } from '../../src/domain/returns/return-value.js';
import { filterEntries, ledgerEntries, movementTotals, onHand, withBalance } from '../../src/domain/inventory/stock-ledger.js';
import { financialTransactions, cashBook, bankBook } from '../../src/domain/finance/books.js';
import { eventRow, returnArgs, rowToEvent, rowToReturn, rowToReturnItem, rowToSale, saleRow } from '../../src/infrastructure/supabase/mappers.js';
import { createLocalFirstReturnRepository } from '../../src/infrastructure/repositories/local-first-return-repository.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const P = (r) => Math.round(r * 100);

// ---------- domain: what a return is worth ----------
{
  // a line of 2 whose saved total has an odd paisa; its tax and taxable value add up to it
  const sale = { id: 's', total: 1099, roundOff: 0.51, items: [{ ln: 0, n: 'Tee', q: 2, price: 499, lt: 1049.49, tx: 937.04, cgst: 56.22, sgst: 56.23, igst: 0, gst: 12, hsn: '6109' },
    { ln: 1, n: 'Cap', q: 1, price: 49, lt: 49, tx: 46.67, cgst: 1.16, sgst: 1.17, igst: 0, gst: 5 }] };
  const a = quoteReturn(sale, { 0: 1 }, []);
  check('one of two pieces: half the line total (after discounts, with GST), to the paisa', a.value === 524.75 && a.lines[0].unit === 524.75 && !a.whole && a.roundOff === 0, a);
  check('its GST reversed is its share, and taxable + GST = value', P(a.lines[0].tx) + P(a.lines[0].cgst) + P(a.lines[0].sgst) === P(a.value) && a.lines[0].cgst === 28.11 && a.lines[0].rate === 12, a.lines[0]);
  const prior = [{ items: [{ ln: 0, q: 1, value: a.lines[0].value, tx: a.lines[0].tx, cgst: a.lines[0].cgst, sgst: a.lines[0].sgst, igst: 0 }] }];
  const b = quoteReturn(sale, { 0: 1 }, prior);
  check('the piece that finishes the line gets what is left: both parts add up to the line exactly', P(a.value) + P(b.value) === P(1049.49) && P(a.lines[0].cgst) + P(b.lines[0].cgst) === P(56.22), [a.value, b.value]);
  check('the rest of the line can\'t be returned twice', quoteReturn(sale, { 0: 1 }, prior.concat([{ items: [{ ln: 0, q: 1, value: b.value }] }])).error === 'Only 0 of Tee can still be returned.');
  const w = quoteReturn(sale, { 0: 2, 1: 1 }, []);
  check('the whole bill: round off given back, so the refund is exactly the bill total', w.whole && w.roundOff === 0.51 && w.value === 1099, w);
  const last = quoteReturn(sale, { 1: 1 }, [{ items: [{ ln: 0, q: 2, value: 1049.49, tx: 937.04, cgst: 56.22, sgst: 56.23, igst: 0 }] }]);
  check('the return that finishes a bill brings its round off, earlier ones never do', last.whole && last.value === 49.51 && a.roundOff === 0);
  check('more than bought is refused', quoteReturn(sale, { 0: 3 }, []).error === 'Only 2 of Tee can still be returned.');
  // a bill from before line totals: its share of the bill total, GST split like the bill
  const old = { id: 'o', sub: 1000, total: 900, tax: 90, taxRate: 10, items: [{ n: 'Old', q: 2, price: 500 }] };
  const o = quoteReturn(old, { 0: 1 }, []);
  check('older bill: the piece\'s share of what the bill came to (₹450) and of its GST (CGST + SGST halves)', o.value === 450 && o.cgst === 22.5 && o.sgst === 22.5 && o.taxable === 405, o);
  check('saved figures are read, never recalculated', savedLine(sale, sale.items[0]).lt === 104949 && savedLine(sale, sale.items[0]).tx === 93704);
  const legacyPrior = returnedSoFar(sale, [{ items: [{ ln: 0, q: 1, value: 525 }] }]);
  check('older returns (whole rupees, no GST kept) count their GST as a share of the line', legacyPrior[0].q === 1 && legacyPrior[0].lt === 52500 && legacyPrior[0].cgst === 2811, legacyPrior);
  check('exchange settlement: even · customer pays · refund', eq(exchangeSettlement(599, 599), { credit: 599, refund: 0, collect: 0, roundOff: 0, value: 599 }) && eq(exchangeSettlement(599, 799), { credit: 599, refund: 0, collect: 200, roundOff: 0, value: 599 }));
  check('exchange settlement in whole rupees: the paise go to the credit note\'s round off', eq(exchangeSettlement(1006.99, 1007), { credit: 1007, refund: 0, collect: 0, roundOff: 0.01, value: 1007 })
    && eq(exchangeSettlement(599.5, 449), { credit: 449, refund: 150, collect: 0, roundOff: -0.5, value: 599 }) && eq(exchangeSettlement(598.7, 799), { credit: 599, refund: 0, collect: 200, roundOff: 0.3, value: 599 }));
}

// ---------- domain: the stock ledger ----------
{
  const moves = { m1: { id: 'm1', v: 'v1', p: 'p1', type: 'OPENING', q: 10, t: 1 }, m2: { id: 'm2', v: 'v2', p: 'p1', type: 'RESTOCK', q: 5, t: 2, cost: 200 }, m3: { id: 'm3', v: 'v1', p: 'p1', type: 'ADJUST', q: -1, t: 3, note: 'Damaged' } };
  const sales = [{ id: 's1', no: 'B1', t: 4, items: [{ ln: 0, v: 'v1', p: 'p1', q: 3 }] }, { id: 's2', no: 'B2', t: 5, void: true, items: [{ ln: 0, v: 'v1', p: 'p1', q: 4 }] },
    { id: 's3', no: 'B3', t: 7, kind: 'exchange', items: [{ ln: 0, v: 'v2', p: 'p1', q: 1 }] }];
  const returns = [{ id: 'r1', no: 'CN1', sale: 's1', t: 6, kind: 'exchange', items: [{ ln: 0, v: 'v1', p: 'p1', q: 1 }] }, { id: 'r2', sale: 's1', t: 8, items: [{ ln: 0, v: 'v1', p: 'p1', q: 1, restock: false }] },
    { id: 'r3', sale: 's2', t: 9, items: [{ ln: 0, v: 'v1', p: 'p1', q: 1 }] }];
  const L = ledgerEntries({ moves, sales, returns });
  check('every change in time order, one kind each (cancelled bills and their returns leave none)', eq(L.map((e) => e.type + ':' + e.q), ['OPENING:10', 'RESTOCK:5', 'ADJUST:-1', 'SALE:-3', 'EXCHANGE_IN:1', 'EXCHANGE_OUT:-1', 'NOT_FOR_RESALE:0']), L.map((e) => e.type + ':' + e.q));
  check('stock on hand is the sum of the ledger (not for resale adds nothing)', eq(onHand(L), { v1: 7, v2: 4 }));
  check('entries name their bill or credit note', L.find((e) => e.type === 'SALE').ref === 'B1' && L.find((e) => e.type === 'EXCHANGE_IN').ref === 'CN1');
  check('running balance per variant', eq(withBalance(L).filter((e) => e.vid === 'v1').map((e) => e.balance), [10, 9, 6, 7, 7]));
  const M = movementTotals(L, { from: 3, to: 8 });
  check('movement in a period by kind (pieces), in and out', M.byType.SALE.pieces === 3 && M.byType.ADJUST.pieces === -1 && M.byType.NOT_FOR_RESALE.pieces === 1 && M.inPieces === 1 && M.outPieces === 5 && !M.byType.OPENING, M);
  check('filter by product, variant and kind', filterEntries(L, { vid: 'v2' }).length === 2 && filterEntries(L, { type: 'SALE' }).length === 1 && filterEntries(L, { pid: 'p9' }).length === 0);
}

// ---------- the RecordReturn use case on this device ----------
installFakeDom();
const storage = memStorage();
const { saveReturns } = await import('../../src/shared/state/persistence.js');
const { enqueue } = await import('../../src/features/sync/services/outbox.js');
const { invalidate, D } = await import('../../src/features/inventory/services/ledger.js');
override({ returnRepository: createLocalFirstReturnRepository({ store, persist: { saveReturns }, outbox: { enqueue }, invalidate }) });
const { newSaleRecord, recordSale } = await import('../../src/features/sales/use-cases/checkout.js');
const { recordReturn } = await import('../../src/features/returns/use-cases/record-return.js');
const { stockOf } = await import('../../src/features/inventory/services/stock.js');
const { purchaseHistory } = await import('../../src/features/customers/services/purchase-history.js');
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: {}, dirty: new Set(), returnsMap: {}, _d: null, customers: { c1: { id: 'c1', name: 'Riya', phone: '9876543210', type: 'individual' } },
  cartCust: null, disc: null, sbOfflineQueue: [], syncReview: [], sbClient: null, sbStatus: 'disconnected', events: {}, prefs: { event: '' }, lastCheckout: 0,
  settings: { taxOn: true, taxRate: 5, taxIncl: false, prefix: 'INV-' }, profile: { gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' },
  moves: { o1: { id: 'o1', v: 'p1:M', p: 'p1', type: 'OPENING', q: 10, t: 1 }, o2: { id: 'o2', v: 'p1:L', p: 'p1', type: 'OPENING', q: 10, t: 1 }, o3: { id: 'o3', v: 'p2:', p: 'p2', type: 'OPENING', q: 5, t: 1 } },
  catalog: { version: 3, products: [{ id: 'p1', name: 'Tee', price: 999, gst: 12, hsn: '6109', opts: [{ n: 'Size', v: ['M', 'L'] }], variants: [{ id: 'p1:M', o: ['M'], active: true }, { id: 'p1:L', o: ['L'], active: true }] },
    { id: 'p2', name: 'Cap', price: 500, gst: null, opts: [], variants: [{ id: 'p2:', o: [], active: true }] }] } });
const line = (v, p, name, q, price) => ({ v, p, name, q, price });
// a bill: 2 Tee M + 1 Cap, 10% off the bill, GST added (12% / 5%), customer Riya, paid in cash
const s1 = newSaleRecord([line('p1:M', 'p1', 'Tee', 2, 999), line('p2:', 'p2', 'Cap', 1, 500)], { type: 'percent', value: 10 }, 'cash', { cust: { id: 'c1', name: 'Riya', phone: '9876543210' } });
recordSale(s1); store.sbOfflineQueue = [];
check('bill saved: 2 Tee M sold', stockOf('p1:M') === 8 && D().saleById[s1.id].total === s1.total);
let r = recordReturn({ sid: s1.id, picks: { 0: 1 }, mode: 'return', pay: 'cash', reason: 'Wrong size' });
const tee = s1.items[0];
check('partial return: refund is what one Tee was paid (its share after the 10% and with 12% GST)', !r.error && r.refund === Math.round(tee.lt / 2 * 100) / 100 && r.ret.value === r.refund, { r, lt: tee.lt });
check('credit note number in its own series', /^CN-\d{6}-001$/.test(r.ret.no), r.ret.no);
check('return line keeps the GST reversed at the bill\'s rate, the HSN, and goes back on the shelf', r.ret.items[0].gst === 12 && r.ret.items[0].hsn === '6109' && r.ret.items[0].restock === true && P(r.ret.items[0].tx) + P(r.ret.items[0].cgst) + P(r.ret.items[0].sgst) === P(r.ret.value));
check('stock +1 for the returned Tee', stockOf('p1:M') === 9);
check('queued for upload, saved on this device', store.sbOfflineQueue.some((q) => q.type === 'return' && q.id === r.ret.id) && JSON.parse(storage.mem.rc_returns)[r.ret.id]);
const tx = financialTransactions(D().sales, D().rets);
check('cash refund: one financial transaction out, in the cash book', tx.some((x) => x.id === 'ft:' + r.ret.id && x.dir === 'out' && x.amount === r.refund) && cashBook(tx).refunds === r.refund);
check('the original bill is unchanged; 1 of 2 Tee returned', D().saleById[s1.id].items[0].q === 2 && D().retLine[s1.id + '|0'] === 1);
// exchange: last Tee M for a Tee L at the same price, the bill's 10% kept by default
const before = { M: stockOf('p1:M'), L: stockOf('p1:L') };
r = recordReturn({ sid: s1.id, picks: { 0: 1 }, mode: 'exchange', pay: 'cash', collect: 'cash', newItems: [line('p1:L', 'p1', 'Tee', 1, 999)] });
check('same-price exchange with the bill\'s 10%: nets ₹0 — credit = the returned value, no payment, no refund', !r.error && r.refund === 0 && r.collect === 0 && r.sale.credit === r.ret.value && r.sale.payments.length === 0 && r.sale.billDisc.value === 10, r);
check('…the paisa between the two discount shares goes to the credit note round off; its taxable value and GST stay as sold', r.ret.value === 1007 && r.ret.ro === 0.01 && r.ret.items[0].value === 1006.99 && r.ret.items[0].tx === 899.11, r.ret);
check('exchange: Tee M +1, Tee L −1; a return and a new bill, linked', stockOf('p1:M') === before.M + 1 && stockOf('p1:L') === before.L - 1 && r.sale.kind === 'exchange' && r.sale.ex === r.ret.ex && r.ret.sale === s1.id && r.ret.kind === 'exchange');
check('the exchange bill is for the original customer', r.sale.cust && r.sale.cust.id === 'c1');
// not for resale
r = recordReturn({ sid: s1.id, picks: { 1: 1 }, mode: 'return', pay: 'upi', notForResale: { 1: true } });
check('not for resale: recorded and refunded (UPI → bank book), but stock stays', !r.error && stockOf('p2:') === 4 && r.ret.items[0].restock === false && bankBook(financialTransactions(D().sales, D().rets)).refunds === r.refund);
check('ledger lists it as "not for resale"', D().ledger.some((e) => e.type === 'NOT_FOR_RESALE' && e.returnId === r.ret.id));
check('the whole bill is now back: the return that finished it brought the bill round off, so the returned lines plus it add up to the bill total', r.ret.ro === s1.roundOff && D().rets.reduce((a, x) => a + x.items.reduce((b, it) => b + P(it.value), 0), 0) + P(s1.roundOff) === P(s1.total), [r.ret.ro, s1.roundOff]);
check('over-return refused, nothing saved', recordReturn({ sid: s1.id, picks: { 0: 1 }, mode: 'return', pay: 'cash' }).error === 'Only 0 of Tee can still be returned.' && Object.keys(store.returnsMap).length === 3);
check('choose at least one item', recordReturn({ sid: s1.id, picks: {}, mode: 'return', pay: 'cash' }).error === 'Choose at least one item coming back.');
// exchange for something dearer, and for something cheaper
const s2 = newSaleRecord([line('p2:', 'p2', 'Cap', 1, 500)], null, 'upi', { cust: null }); recordSale(s2);
r = recordReturn({ sid: s2.id, picks: { 0: 1 }, mode: 'exchange', pay: 'cash', collect: 'card', newItems: [line('p1:M', 'p1', 'Tee', 1, 999)] });
check('walk-in exchange for a dearer item: the customer pays the difference by card (a payment on the new bill, bank book)', !r.error && r.collect === Math.round((r.sale.total - r.ret.value) * 100) / 100 && r.sale.payments[0].method === 'card' && r.sale.payments[0].amount === r.collect && r.sale.cust === null);
const s3 = newSaleRecord([line('p1:L', 'p1', 'Tee', 1, 999)], null, 'cash', { cust: null }); recordSale(s3);
r = recordReturn({ sid: s3.id, picks: { 0: 1 }, mode: 'exchange', pay: 'upi', collect: 'cash', newItems: [line('p2:', 'p2', 'Cap', 1, 500)] });
check('exchange for a cheaper item: the difference is refunded (UPI)', !r.error && r.refund === Math.round((r.ret.value - r.sale.total) * 100) / 100 && r.refund > 0 && r.ret.pay === 'upi' && r.sale.payments.length === 0);
check('an exchange with no new items is refused', recordReturn({ sid: s2.id, picks: {}, mode: 'exchange' }).error === 'Choose at least one item coming back.');
// cancelled bills can't be returned
const s4 = newSaleRecord([line('p2:', 'p2', 'Cap', 1, 500)], null, 'cash', { cust: null }); recordSale(s4);
Object.values(store.localDays)[0].voids.push(s4.id); invalidate();
check('a cancelled bill can\'t be returned', recordReturn({ sid: s4.id, picks: { 0: 1 }, mode: 'return', pay: 'cash' }).error === 'This bill is cancelled, so nothing on it can be returned.');
// purchase history shows the returns
const H = purchaseHistory('c1');
check('purchase history: the bill shows its returned pieces and credit notes; spent = paid − refunds', H.bills.some((b) => b.id === s1.id && b.returnedPieces === 3 && b.creditNotes.length === 3), H.bills.map((b) => [b.id, b.returnedPieces, b.creditNotes]));
check('stock from the ledger equals stock on the Stock page for every variant', ['p1:M', 'p1:L', 'p2:'].every((v) => onHand(D().ledger)[v] === stockOf(v)), ['p1:M', 'p1:L', 'p2:'].map((v) => [onHand(D().ledger)[v], stockOf(v)]));

// ---------- mapping returns and events to the database and back ----------
{
  const ret = Object.values(store.returnsMap).find((x) => x.items[0].restock === false);
  const a = returnArgs(ret);
  const back = rowToReturn({ ...a.p_return, t: String(a.p_return.t), refund_amount: String(a.p_return.refund_amount), value: String(a.p_return.value) }, a.p_items.map((i) => rowToReturnItem({ ...i, value: String(i.value), taxable_value: String(i.taxable_value) })));
  check('a return survives the round trip (paise, credit note, not for resale, GST reversed)', back.refund === ret.refund && back.value === ret.value && back.no === ret.no && back.items[0].restock === false
    && back.items[0].tx === ret.items[0].tx && back.items[0].cgst === ret.items[0].cgst && back.items[0].hsn === ret.items[0].hsn, { back, ret });
  const ev = { id: 'e1', name: 'Fair', start: '2026-10-01', end: '2026-10-03', place: 'Pune', status: 'closed', t: 9 };
  check('an event survives the round trip', eq(rowToEvent({ ...eventRow(ev), start_date: '2026-10-01' }), ev), rowToEvent(eventRow(ev)));
  check('a bill carries its event both ways', saleRow({ ...s2, event: 'e1' }).event_id === 'e1' && rowToSale({ ...saleRow({ ...s2, event: 'e1' }), timestamp: s2.t }, []).event === 'e1' && saleRow(s2).event_id === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
