// Customer credit (a bill left partly on account, what customers owe, payments collected, refunds to the account), held
// bills, and the orders engine (quotations, sales orders: totals, statuses, conversion, billing, partial delivery).
// Run: npm run test:unit
import { DUE, payLabel, paymentProgress, paymentsOf, settlePayments } from '../../src/domain/sales/payments.js';
import { checkCollection, collectionLabel, customerAccount, dueRefundRoom, outstandingByCustomer } from '../../src/domain/customers/credit.js';
import { bankBook, cashBook, financialTransactions, reconcileSale } from '../../src/domain/finance/books.js';
import { FINAL, ORDER_NEXT, ORDER_STATUSES, canMove, cartBlock, checkHold, checkOrder, convertQuote, fulfil, heldName, isExpired, isFinal, nextStatuses, orderCartLines,
  orderCheckout, orderDeviceCode, orderNo, remaining, shownStatus, soldFromOrder } from '../../src/domain/orders/orders.js';
import { collectionRow, heldRow, orderArgs, rowToCollection, rowToHeld, rowToOrder, rowToOrderItem, rowToSale, saleRow } from '../../src/infrastructure/supabase/mappers.js';
import { UPLOAD_PERMISSIONS, dependsOn, uploadAllowed } from '../../src/domain/sync/queue-rules.js';
import { TAB_PERMISSIONS, roleCan } from '../../src/domain/shop/permissions.js';
import { createLocalFirstCreditRepository } from '../../src/infrastructure/repositories/local-first-credit-repository.js';
import { createLocalFirstOrderRepository } from '../../src/infrastructure/repositories/local-first-order-repository.js';
import { createLocalFirstCustomerRepository } from '../../src/infrastructure/repositories/local-first-customer-repository.js';
import { createLocalFirstReturnRepository } from '../../src/infrastructure/repositories/local-first-return-repository.js';
import { toAppError } from '../../src/infrastructure/supabase/errors.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const eq = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

// ---------- credit: settling a bill with part on account ----------
{
  const S = settlePayments(1000, [{ method: 'cash', amount: 400 }, { method: DUE, amount: 600 }], { customer: true });
  check('some now, the rest on account: the payments are what was paid now', S.ok && S.paid === 400 && S.onAccount === 600 && S.payments.length === 1 && S.payments[0].method === 'cash', S);
  const N = settlePayments(1000, [{ method: DUE, amount: 1000 }], { customer: true });
  check('nothing now: all of it on account, no payment', N.ok && N.payments.length === 0 && N.onAccount === 1000);
  check('on account needs a saved customer', settlePayments(1000, [{ method: DUE, amount: 1000 }]).field === 'customer' && settlePayments(1000, [{ method: DUE, amount: 1000 }], { customer: false }).error);
  check('the parts must still add up: short and over are refused', settlePayments(1000, [{ method: 'cash', amount: 300 }, { method: DUE, amount: 600 }], { customer: true }).error === '₹100 still to pay.'
    && settlePayments(1000, [{ method: 'upi', amount: 500, ref: 'U1' }, { method: DUE, amount: 600 }], { customer: true }).error === "That's ₹100 more than the bill.");
  check('on account twice, negative, or with paise beyond 2 places → refused', !!settlePayments(10, [{ method: DUE, amount: 5 }, { method: DUE, amount: 5 }], { customer: true }).error
    && !!settlePayments(10, [{ method: 'cash', amount: 11 }, { method: DUE, amount: -1 }], { customer: true }).error && !!settlePayments(10, [{ method: DUE, amount: 9.999 }, { method: 'cash', amount: 0.001 }], { customer: true }).error);
  check('without an account part the result is as before (no onAccount)', !('onAccount' in settlePayments(10, [{ method: 'cash', amount: 10 }])));
  const P = paymentProgress(1000, [{ method: 'cash', amount: 250, received: 300 }, { method: DUE, amount: 750 }]);
  check('live figures: paid now, balance 0, on account, change', P.paid === 250 && P.balance === 0 && P.onAccount === 750 && P.change === 50 && P.over === 0, P);
  const sale = { id: 's1', total: 1000, credit: 0, dueAmt: 600, payments: [{ id: 's1:cash', method: 'cash', amount: 400 }] };
  check('pay label shows the part on account', payLabel(sale) === 'Cash + On account' && payLabel({ id: 's2', total: 500, dueAmt: 500, payments: [] }) === 'On account');
  check('old single-method bills with an amount on account: only the rest was paid', paymentsOf({ id: 'o', total: 1000, credit: 0, dueAmt: 300, pay: 'cash' })[0].amount === 700);
}

// ---------- credit: what customers owe, collections, refunds to the account ----------
const sales = [
  { id: 'a', no: 'INV-1', t: 100, total: 1000, credit: 0, dueAmt: 600, cust: { id: 'c1', name: 'Riya' }, payments: [{ id: 'a:cash', method: 'cash', amount: 400 }] },
  { id: 'b', no: 'INV-2', t: 200, total: 500, credit: 0, cust: { id: 'c1', name: 'Riya' }, payments: [{ id: 'b:upi', method: 'upi', amount: 500, ref: 'U1', verification: 'unverified' }] },
  { id: 'c', no: 'INV-3', t: 300, total: 800, credit: 0, dueAmt: 800, cust: { id: 'c2', name: 'Anil' }, payments: [] },
  { id: 'v', no: 'INV-4', t: 350, total: 900, credit: 0, dueAmt: 900, void: true, cust: { id: 'c1', name: 'Riya' }, payments: [] },
];
const returns = [{ id: 'r1', no: 'CN-1', sale: 'a', t: 400, refund: 100, pay: 'due', value: 100 }, { id: 'r2', no: 'CN-2', sale: 'b', t: 410, refund: 50, pay: 'cash', value: 50 }];
const collections = [{ id: 'k1', cust: 'c1', amount: 200, method: 'cash', t: 500, status: 'posted' }, { id: 'k2', cust: 'c1', amount: 99, method: 'upi', ref: 'U9', verification: 'unverified', t: 600, status: 'cancelled' },
  { id: 'k3', cust: 'c2', amount: 300, method: 'card', ref: 'A1', t: 700, status: 'posted' }];
{
  const A = customerAccount('c1', { sales, returns, collections });
  check('account: purchases (cancelled bills left out), paid at the till + collected, outstanding', A.purchases === 1500 && A.paidAtSale === 900 && A.collected === 200 && A.paid === 1100
    && A.onAccount === 600 && A.refundedToAccount === 100 && A.outstanding === 300 && A.bills === 2, A);
  check('account history: newest first, with the running balance', A.entries[0].kind === 'collection' && A.entries[0].status === 'cancelled' && A.entries[0].balance === 300
    && A.entries.find((e) => e.id === 'r1').balance === 500 && A.entries.find((e) => e.id === 'a').charge === 600 && A.entries.find((e) => e.id === 'k1').credit === 200);
  check('everyone\'s outstanding', eq(outstandingByCustomer({ sales, returns, collections }), { c1: 300, c2: 500 }));
  check('refund room on a bill: what is still on account after refunds to the account', dueRefundRoom(sales[0], returns) === 500 && dueRefundRoom(sales[1], returns) === 0 && dueRefundRoom(sales[3], []) === 0);
  check('collect: at most what they owe; UPI needs its reference and is unverified; card its machine reference', checkCollection({ amount: 301, method: 'cash' }, 300).field === 'amount'
    && checkCollection({ amount: 100, method: 'upi' }, 300).field === 'ref' && eq(checkCollection({ amount: '100', method: 'upi', ref: ' U1 ' }, 300).collection, { amount: 100, method: 'upi', ref: 'U1', verification: 'unverified' })
    && checkCollection({ amount: 50, method: 'card', ref: 'A1' }, 300).collection.verification === 'recorded' && !!checkCollection({ amount: 10, method: 'cash' }, 0).error
    && !!checkCollection({ amount: '', method: 'cash' }, 10).error && !!checkCollection({ amount: 1.005, method: 'cash' }, 10).error && !!checkCollection({ amount: 5, method: 'cheque' }, 10).error
    && !!checkCollection({ amount: 5, method: 'card', ref: '4111111111111111' }, 10).error);
  check('collection label', collectionLabel({ method: 'upi', ref: 'U1' }) === 'UPI · ref U1' && collectionLabel({ method: 'cash' }) === 'Cash');
}
// ---------- credit: the books ----------
{
  const tx = financialTransactions(sales, returns, [], collections);
  check('collections are transactions of kind "collection" (ids ft:<collection id>); refunds to the account move no money', tx.filter((x) => x.kind === 'collection').length === 3
    && tx.some((x) => x.id === 'ft:k1' && x.dir === 'in' && x.method === 'cash' && x.status === 'posted') && tx.find((x) => x.id === 'ft:k2').status === 'cancelled' && !tx.some((x) => x.returnId === 'r1'));
  const cb = cashBook(tx), bb = bankBook(tx);
  check('cash book: cash collected is its own figure and in the closing balance', cb.collections === 200 && cb.closing === 400 + 200 - 50, cb);
  check('bank book: card collected in, cancelled UPI collection out of the figures', bb.collections === 300 && bb.cardIn === 300 && bb.upiIn === 500 && bb.upiUnverified === 500, bb);
  check('a bill with part on account reconciles against what was due now', reconcileSale(sales[0], tx).ok && reconcileSale(sales[2], tx).ok && reconcileSale(sales[2], tx).due === 0);
  check('without collections the books are as before', financialTransactions(sales, returns, []).every((x) => x.kind !== 'collection'));
}

// ---------- orders: numbers, statuses, totals ----------
{
  const n = orderNo('quote', new Date(2026, 8, 29).getTime(), 7, 'dev-abc');
  check('numbers: QT- + date + device code + running number', /^QT-260929-[0-9A-Z]{3}007$/.test(n) && orderNo('sales', new Date(2026, 8, 29).getTime(), 1, 'dev-abc').startsWith('SO-260929-') && orderDeviceCode('a') !== orderDeviceCode('b') && orderDeviceCode('x').length === 3, n);
  check('status moves: a quotation goes draft → sent → accepted → converted; nothing leaves a final status', canMove('quote', 'draft', 'sent') && canMove('quote', 'sent', 'accepted') && canMove('quote', 'accepted', 'converted')
    && !canMove('quote', 'converted', 'draft') && !canMove('quote', 'cancelled', 'draft') && !canMove('sales', 'completed', 'partial') && canMove('sales', 'confirmed', 'partial') && !canMove('sales', 'partial', 'confirmed'));
  check('every kind lists its statuses, first and final ones', ORDER_STATUSES.quote.length === 6 && ORDER_STATUSES.sales.length === 5 && ORDER_STATUSES.table.includes('preparing')
    && Object.keys(ORDER_NEXT.sales).every((s) => ORDER_STATUSES.sales.includes(s)) && FINAL.sales.includes('completed') && isFinal({ kind: 'quote', status: 'converted' }) && !isFinal({ kind: 'sales', status: 'partial' }));
  check('the editor offers only moves a person makes (not converted / partial / completed)', eq(nextStatuses({ kind: 'sales', status: 'confirmed' }), ['confirmed', 'cancelled']) && eq(nextStatuses({ kind: 'quote', status: 'draft' }), ['draft', 'sent', 'accepted', 'cancelled', 'expired']));
  const q = { kind: 'quote', status: 'sent', validUntil: '2026-09-28' };
  check('expired: a draft or sent quotation past its date', isExpired(q, '2026-09-29') && !isExpired(q, '2026-09-28') && shownStatus(q, '2026-09-30') === 'expired' && !isExpired({ ...q, status: 'accepted' }, '2026-10-30'));
  const o = { kind: 'quote', status: 'draft', cust: { id: 'c1', name: 'Riya' }, billDisc: { type: 'percent', value: 10 },
    items: [{ ln: 0, name: 'Tee', q: 2, price: 500, gst: 5, disc: { type: 'fixed', value: 100 } }, { ln: 1, name: 'Cap', q: 1.5, price: 200, gst: 12 }] };
  const T = orderCheckout(o, { mode: 'intra', inclusive: true });
  check('order totals: the one bill calculation (line and bill discounts, GST in prices)', T.sub === 1300 && T.itemDisc === 100 && T.billDisc === 120 && T.total === 1080 && T.cgst > 0 && T.lines.length === 2, T);
  check('order checks: customer, lines, quantity (3 decimals), price, discounts', checkOrder(o) === null && checkOrder({ ...o, cust: null }).field === 'customer' && checkOrder({ ...o, items: [] }).field === 'items'
    && checkOrder({ ...o, items: [{ name: 'X', q: 0.0001, price: 1 }] }).field === 'qty' && checkOrder({ ...o, items: [{ name: 'X', q: 1, price: -1 }] }).field === 'price'
    && checkOrder({ ...o, items: [{ name: 'X', q: 1, price: 10, disc: { type: 'fixed', value: 20 } }] }).field === 'disc' && checkOrder({ ...o, billDisc: { type: 'percent', value: 120 } }).field === 'billDisc'
    && checkOrder({ ...o, status: 'confirmed' }).field === 'status' && checkOrder({ ...o, items: [{ name: 'X', q: 1, price: 1, fq: 2 }] }).field === 'qty' && checkOrder({ ...o, validUntil: '29/09' }).field === 'validUntil');
}
// ---------- orders: conversion, billing, partial delivery ----------
{
  const q = { id: 'q1', kind: 'quote', no: 'QT-1', status: 'accepted', cust: { id: 'c1', name: 'Riya' }, notes: 'Blue ones', validUntil: '2026-10-10', billDisc: null, version: 3,
    items: [{ ln: 0, p: 'p1', v: 'p1:a', name: 'Tee', q: 3, price: 500 }, { ln: 4, p: 'p2', v: 'p2:', name: 'Cap', q: 2, price: 200, disc: { type: 'percent', value: 10 } }] };
  const r = convertQuote(q, { id: 'so1', no: 'SO-1', t: 10, dev: 'd1' }, '2026-10-01');
  check('a quotation becomes a sales order: lines copied (renumbered, nothing delivered), confirmed; the quotation is converted', r.order.kind === 'sales' && r.order.status === 'confirmed' && r.order.items.length === 2
    && r.order.items[1].ln === 1 && r.order.items[1].disc.value === 10 && r.order.items.every((l) => l.fq === 0) && r.order.version === 0 && /From quotation QT-1/.test(r.order.notes)
    && r.quote.status === 'converted' && r.quote.convertedTo === 'so1');
  check('an expired or final quotation doesn\'t convert', !!convertQuote({ ...q, status: 'sent', validUntil: '2026-09-01' }, { id: 'x' }, '2026-10-01').error && !!convertQuote(r.quote, { id: 'x' }, '2026-10-01').error && !!convertQuote(r.order, { id: 'x' }, '2026-10-01').error);
  const so = r.order;
  check('what can go on a bill: a draft sales order must be confirmed; a final one or one fully delivered can\'t', cartBlock({ ...so, status: 'draft' }, '2026-10-01') === 'Confirm the sales order first.' && cartBlock(so, '2026-10-01') === null
    && !!cartBlock({ ...so, status: 'cancelled' }, '2026-10-01') && !!cartBlock(null) && !!cartBlock({ ...so, kind: 'table' }));
  const { lines, skipped } = orderCartLines(so, (v) => (v === 'p1:a' ? 2 : v === 'p2:' ? 5 : null));
  check('bill lines: what is left, at the order\'s price and discount, capped by stock', lines.length === 2 && lines[0].q === 2 && lines[0].short === 1 && lines[0].price === 500 && lines[0].oln === 0 && lines[0].ord === 'so1'
    && lines[1].disc.value === 10 && skipped.length === 0);
  check('lines no longer in the catalog or out of stock are skipped with a reason', orderCartLines(so, (v) => (v === 'p1:a' ? 0 : null)).skipped.map((s) => s.why).join('|') === 'out of stock|no longer in the catalog');
  const sale = { id: 's9', order: 'so1', items: [{ ord: 'so1', oln: 0, q: 2 }, { ord: 'so1', oln: 1, q: 2 }, { q: 1 }] };
  check('what a bill delivered, per order line', eq(soldFromOrder(sale, 'so1'), { 0: 2, 1: 2 }));
  const part = fulfil(so, soldFromOrder(sale, 'so1'), 's9', 20);
  check('partly delivered: the order counts it and lists the bill', part.status === 'partial' && part.items[0].fq === 2 && part.items[1].fq === 2 && remaining(part.items[0]) === 1 && eq(part.saleIds, ['s9']) && so.items[0].fq === 0);
  const done = fulfil(part, { 0: 5 }, 's10', 30);
  check('completed when everything is delivered (never more than ordered)', done.status === 'completed' && done.items[0].fq === 3 && eq(done.saleIds, ['s9', 's10']));
  const qb = fulfil(q, { 0: 1 }, 's11', 40);
  check('a quotation billed straight away is converted (to the bill)', qb.status === 'converted' && qb.convertedTo === 's11');
  check('held bills: a name, something on the bill', checkHold([], 'x') && checkHold([{}], ' ') && checkHold([{}], 'x'.repeat(61)) && checkHold([{}], 'Riya') === null
    && heldName({ name: 'Riya' }, 'Bill 2:05') === 'Riya' && heldName(null, 'Bill 2:05') === 'Bill 2:05');
}

// ---------- rows, queue rules, permissions ----------
{
  const c = { id: 'k1', cust: 'c1', amount: 250, method: 'upi', ref: 'U1', verification: 'unverified', note: 'part', t: 5, dev: 'd1', status: 'posted' };
  check('collection rows round trip', eq(rowToCollection({ ...collectionRow(c), amount: '250.00' }), c));
  const h = { id: 'h1', name: 'Riya', data: { cart: [{ v: 'p1:', q: 1 }], disc: null, cust: null }, t: 7, dev: 'd1' };
  check('held bill rows round trip', eq(rowToHeld(heldRow(h)), h));
  const o = { id: 'o1', kind: 'sales', no: 'SO-1', status: 'partial', cust: { id: 'c1', name: 'Riya', phone: '98' }, billDisc: { type: 'percent', value: 5 }, notes: 'n', validUntil: '', source: 'staff',
    convertedTo: null, saleIds: ['s1'], version: 4, t: 1, updatedT: 2, dev: 'd1', items: [{ ln: 0, p: 'p1', v: 'p1:', name: 'Tee', vl: 'M', q: 1.5, price: 500, gst: 5, fq: 1, disc: { type: 'fixed', value: 10 } }] };
  const A = orderArgs(o);
  check('order → RPC arguments (the version this device saw, lines with delivered quantities)', A.p_order.version === 4 && A.p_order.customer_id === 'c1' && A.p_order.sale_ids[0] === 's1' && A.p_items[0].qty === 1.5 && A.p_items[0].fulfilled_qty === 1 && A.p_items[0].line_no === 0);
  const back = rowToOrder({ ...A.p_order, bill_disc: A.p_order.bill_disc, customer: A.p_order.customer }, A.p_items.map((i) => rowToOrderItem({ ...i, qty: String(i.qty), price: '500.00' })));
  check('order rows round trip', eq(back, o), back);
  const s = { id: 's1', t: 1, items: [], sub: 1000, disc: 0, total: 1000, credit: 0, dueAmt: 600, order: 'o1', pay: 'cash', dev: 'd1', payments: [], cust: { id: 'c1', name: 'Riya', phone: '' } };
  const row = saleRow(s);
  check('bill rows carry the amount on account and the order', row.due_amount === 600 && row.order_id === 'o1' && rowToSale(row, [], []).dueAmt === 600 && rowToSale(row, [], []).order === 'o1'
    && saleRow({ ...s, dueAmt: undefined, order: undefined }).due_amount === 0 && !('dueAmt' in rowToSale({ ...row, due_amount: '0.00' }, [], [])));
  check('a collection waits for its customer to upload', eq(dependsOn({ type: 'collection', id: 'k1', col: c }), ['cust:c1']));
  const cashier = (p) => roleCan('cashier', null, p), server = (p) => roleCan('server', null, p), kitchen = (p) => roleCan('kitchen', null, p);
  check('uploads need: collection → collect_credit, held → create_sale, order → create_order', uploadAllowed({ type: 'collection' }, cashier) && uploadAllowed({ type: 'order' }, server) && !uploadAllowed({ type: 'held' }, server)
    && !uploadAllowed({ type: 'collection' }, server) && !uploadAllowed({ type: 'order' }, kitchen) && eq(UPLOAD_PERMISSIONS.helddel, ['create_sale']));
  check('the Orders tab: sellers and order takers', eq(TAB_PERMISSIONS.orders, ['create_sale', 'create_order']));
  check('"changed on another device" (40001) is a conflict for the sync review', toAppError({ code: '40001', message: 'Order o1 was changed on another device' }).code === 'CONFLICT');
}

// ---------- use cases on this device ----------
const el = installFakeDom();
globalThis.window = globalThis.window || { addEventListener(){} };
globalThis.confirm = () => true;
const storage = memStorage();
const P = await import('../../src/shared/state/persistence.js');
const OB = await import('../../src/features/sync/services/outbox.js');
const outbox = { enqueue: OB.enqueue, dropQueued: OB.dropQueued };
const { invalidate, D } = await import('../../src/features/inventory/services/ledger.js');
const baseCloud = { auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) }, async saveSale(){}, async saveReturn(){}, async saveCustomer(){}, async saveCollection(){}, async saveHeldCart(){},
  async deleteHeldCart(){}, async saveOrder(o){ return { version: (+o.version || 0) + 1 }; } };
override({
  orderRepository: createLocalFirstOrderRepository({ store, persist: { saveOrders: P.saveOrders, saveHeldCarts: P.saveHeldCarts }, outbox }),
  creditRepository: createLocalFirstCreditRepository({ store, persist: { saveCollections: P.saveCollections }, outbox: { enqueue: OB.enqueue } }),
  customerRepository: createLocalFirstCustomerRepository({ store, persist: { saveCustomers: P.saveCustomers }, outbox }),
  returnRepository: createLocalFirstReturnRepository({ store, persist: { saveReturns: P.saveReturns }, outbox, invalidate }),
  cloud: baseCloud,
});
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: {}, dirty: new Set(), returnsMap: {}, _d: null, customers: { c1: { id: 'c1', name: 'Riya', phone: '9876543210' } },
  cartCust: null, cartOrder: null, disc: null, cart: [], sbOfflineQueue: [], syncReview: [], sbClient: null, sbStatus: 'disconnected', events: {}, prefs: { event: '' }, lastCheckout: 0, deliveries: {}, channels: null,
  settings: { taxOn: false, prefix: 'INV-' }, profile: {}, moves: {}, cashMoves: {}, dayCloses: {}, deliveryQueue: [], payConfig: null, collections: {}, heldCarts: {}, orders: {}, access: null,
  catalog: { version: 3, products: [{ id: 'p1', name: 'Tee', price: 500, opts: [], variants: [{ id: 'p1:', o: [], active: true }] }, { id: 'p2', name: 'Cap', price: 200, opts: [], variants: [{ id: 'p2:', o: [], active: true }] }] } });
store.moves = { m1: { id: 'm1', v: 'p1:', p: 'p1', q: 10, type: 'in', t: 1 }, m2: { id: 'm2', v: 'p2:', p: 'p2', q: 2, type: 'in', t: 1 } };
invalidate();
const CK = await import('../../src/features/sales/use-cases/checkout.js');
const checkout = (pay) => { store.lastCheckout = 0; return CK.checkout(pay); };   // bills rung up one after another (no double-tap guard)
const { collectPayment, cancelCollection } = await import('../../src/features/customers/use-cases/collect-payment.js');
const { accountOf, outstandingAll, billDueRoom } = await import('../../src/features/customers/services/customer-account.js');
const { holdCart, recallHeld, discardHeld, listHeldCarts } = await import('../../src/features/orders/use-cases/held-carts.js');
const OU = await import('../../src/features/orders/use-cases/orders.js');
const { recordReturn } = await import('../../src/features/returns/use-cases/record-return.js');
const { shopTransactions } = await import('../../src/features/finance/services/books-data.js');
const { ORDERS_MODULE, orderViews } = await import('../../src/features/orders/module.js');
const q = (type) => store.sbOfflineQueue.filter((x) => x.type === type);
const member = (role, perms) => { store.access = { role, perms, shopId: 'owner1' }; };
const ownerAgain = () => { store.access = null; };

// selling on credit
{
  store.cart = [{ v: 'p1:', p: 'p1', name: 'Tee', q: 2, price: 500 }]; store.cartCust = null;
  let r = await checkout([{ method: 'cash', amount: 400 }, { method: DUE, amount: 600 }]);
  check('a walk-in bill can\'t go on account (nothing saved)', r && r.error && r.field === 'customer' && store.cart.length === 1, r);
  store.cartCust = { id: 'c1', name: 'Riya', phone: '9876543210' };
  member('server', ['view_products', 'create_sale', 'create_order']);
  r = await checkout([{ method: 'cash', amount: 400 }, { method: DUE, amount: 600 }]);
  check('without collect_credit selling on account is refused before anything changes', r && /can't sell on credit/.test(r.error) && store.cart.length === 1 && !D().sales.length, r);
  ownerAgain();
  r = await checkout([{ method: 'cash', amount: 400 }, { method: DUE, amount: 600 }]);
  const s = store.lastSale;
  check('the bill keeps what is on account; its payments are what was paid now', !r.error && s.dueAmt === 600 && s.payments.length === 1 && s.payments[0].amount === 400 && s.pay === 'cash' && q('sale').length === 1, r);
  check('Riya owes 600', accountOf('c1').outstanding === 600 && outstandingAll().c1 === 600 && billDueRoom(s.id) === 600);
  store.cart = [{ v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 200 }]; store.cartCust = { id: 'c1', name: 'Riya' };
  await checkout([{ method: DUE, amount: 200 }]);
  check('nothing now: the whole bill on account, marked credit', store.lastSale.pay === 'credit' && store.lastSale.payments.length === 0 && accountOf('c1').outstanding === 800);
  // collecting
  member('server', ['view_products', 'create_sale', 'create_order']);
  check('without collect_credit collecting is refused', /can't collect payments/.test(collectPayment('c1', { amount: 100, method: 'cash' }).error) && !Object.keys(store.collections).length);
  ownerAgain();
  check('more than they owe is refused', collectPayment('c1', { amount: 801, method: 'cash' }).field === 'amount');
  const c = collectPayment('c1', { amount: 300, method: 'upi', ref: 'U77' });
  check('a payment collected: kept here, queued, posted in the bank book, what they owe goes down', c.outstanding === 500 && store.collections[c.collection.id].verification === 'unverified' && q('collection').length === 1
    && JSON.parse(storage.mem.rc_collections)[c.collection.id] && shopTransactions().some((x) => x.kind === 'collection' && x.method === 'upi' && x.amount === 300 && x.customerName === 'Riya'), c);
  member('cashier', ['view_products', 'create_sale', 'apply_discount', 'perform_return', 'collect_credit', 'create_order']);
  check('only the owner cancels a payment collected', !!cancelCollection(c.collection.id).error);
  ownerAgain();
  check('the owner cancels it: out of the balances', cancelCollection(c.collection.id).ok && accountOf('c1').outstanding === 800 && store.collections[c.collection.id].status === 'cancelled' && q('collection').length === 1 && q('collection')[0].col.status === 'cancelled');
  // a refund to the account
  const sid = s.id;
  let rr = recordReturn({ sid, picks: { 0: 1 }, mode: 'return', pay: 'due', reason: 'Other' });
  check('a return refunded to the account: no money moves, what they owe goes down', !rr.error && rr.ret.pay === 'due' && accountOf('c1').outstanding === 300 && !shopTransactions().some((x) => x.returnId === rr.ret.id), rr);
  rr = recordReturn({ sid, picks: { 0: 1 }, mode: 'return', pay: 'due', reason: 'Other' });
  check('never more than the bill still has on account', /At most ₹100/.test(rr.error || ''), rr);
  const c2 = collectPayment('c1', { amount: 250, method: 'cash' });
  check('…nor more than the customer owes now (a payment collected since covered part of it)', c2.outstanding === 50 && billDueRoom(sid) === 50 && /At most ₹50/.test(recordReturn({ sid, picks: { 0: 1 }, mode: 'return', pay: 'due' }).error || ''));
  member('server', ['view_products', 'create_sale', 'create_order', 'perform_return']);
  check('refunding to the account needs collect_credit', /change what customers owe/.test(recordReturn({ sid, picks: { 0: 1 }, mode: 'return', pay: 'due' }).error || ''));
  ownerAgain();
}
// holding and recalling
{
  store.cart = [{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }]; store.cartCust = { id: 'c1', name: 'Riya' }; store.disc = { type: 'percent', value: 5 };
  const stockBefore = D().sold['p1:'] || 0;
  member('server', ['view_products', 'create_order']);
  check('holding needs create_sale', !!holdCart().error && store.cart.length === 1);
  ownerAgain();
  const h = holdCart();
  check('held: named after the customer, the bill cleared, queued; stock untouched', h.held.name === 'Riya' && !store.cart.length && store.disc === null && q('held').length === 1 && listHeldCarts().length === 1 && (D().sold['p1:'] || 0) === stockBefore);
  store.cart = [{ v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 200 }];
  check('recall only onto an empty bill', /Finish, hold or clear/.test(recallHeld(h.held.id).error));
  store.cart = [];
  const r = recallHeld(h.held.id);
  check('recalled: back on the bill with its discount and customer; the held copy removed (its waiting upload dropped)', !r.error && store.cart.length === 1 && store.disc.value === 5 && store.cartCust.id === 'c1'
    && !listHeldCarts().length && q('held').length === 0 && q('helddel').length === 1);
  store.cart = [{ v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 200 }]; store.cartCust = null; store.disc = null;
  const h2 = holdCart('Second queue');
  check('a name given is kept', h2.held.name === 'Second queue' && discardHeld(h2.held.id).ok && !listHeldCarts().length && !!discardHeld('nope').error);
}
// quotations and sales orders
{
  check('the Orders module for the navigation registry: held bills for everyone, quotations and sales orders by capability', ORDERS_MODULE.submodules.map((m) => m.id + ':' + (m.capability || '')).join(',') === 'held:,quote:uses_quotations,sales:uses_sales_orders'
    && orderViews(() => true).length === 3 && orderViews((c) => c !== 'uses_quotations').map((v) => v.id).join() === 'held,sales');
  member('cashier', ['view_products', 'create_sale', 'perform_return', 'collect_credit']);
  check('saving a quotation needs create_order', !!OU.saveOrder(OU.newOrderDraft('quote', {})).error && !OU.ordersOf('quote').length);
  ownerAgain();
  store.cart = [{ v: 'p1:', p: 'p1', name: 'Tee', q: 3, price: 500 }]; store.cartCust = { id: 'c1', name: 'Riya', phone: '9876543210' }; store.disc = null;
  const d = OU.newOrderDraft('quote', { cart: store.cart, disc: store.disc, cust: store.cartCust });
  check('a draft from the bill on the screen: its lines, customer, 15 days validity', d.items.length === 1 && d.cust.id === 'c1' && d.status === 'draft' && d.validUntil > OU.todayKey());
  check('no customer: refused', OU.saveOrder({ ...d, cust: null }).field === 'customer');
  member('cashier', ['view_products', 'create_sale', 'create_order']);
  check('a discount needs apply_discount', /give discounts/.test(OU.saveOrder({ ...d, billDisc: { type: 'percent', value: 5 } }).error || ''));
  ownerAgain();
  let r = OU.saveOrder({ ...d, items: [...d.items, OU.orderLine('p2:', 2)] });
  const quote = r.order;
  check('saved: numbered QT-, version 0 until the cloud takes it, queued as one "order" item', /^QT-\d{6}-[0-9A-Z]{3}001$/.test(quote.no) && quote.version === 0 && q('order').length === 1 && quote.items[1].ln === 1 && quote.items[1].price === 200, r);
  r = OU.setOrderStatus(quote.id, 'sent');
  check('status moves are saved (one queued upload per order)', r.order.status === 'sent' && q('order').length === 1 && OU.orderById(quote.id).no === quote.no);
  check('a move the rules don\'t allow is refused', OU.setOrderStatus(quote.id, 'completed').field === 'status');
  const stale = { ...OU.orderById(quote.id), notes: 'from an old copy', updatedT: 1 };
  check('a copy taken before the order last changed isn\'t saved over it', /changed while it was open/.test(OU.saveOrder(stale).error || '') && OU.orderById(quote.id).notes === '');
  store.sbClient = {}; store.sbStatus = 'connected'; await OB.flushSbQueue(); store.sbClient = null; store.sbStatus = 'disconnected';
  check('uploaded: the cloud\'s version is kept for the next save', OU.orderById(quote.id).version === 1 && q('order').length === 0);
  // a line removed and a new one added: numbers aren't reused
  r = OU.saveOrder({ ...OU.orderById(quote.id), items: [OU.orderById(quote.id).items[1], OU.orderLine('p1:', 1)] });
  check('lines keep their numbers; a new line gets the next unused one', r.order.items.map((l) => l.ln).join() === '1,2', r.order.items);
  const cv = OU.convertToSalesOrder(quote.id);
  check('converted: a confirmed sales order SO-, the quotation converted (both queued)', cv.order.kind === 'sales' && cv.order.status === 'confirmed' && /^SO-/.test(cv.order.no) && OU.orderById(quote.id).status === 'converted' && q('order').length === 2);
  check('a converted quotation can\'t change any more', !!OU.saveOrder({ ...OU.orderById(quote.id), notes: 'x' }).error);
  // billing a sales order in parts: stock of Cap is 1 (2 ordered)
  store.cart = [{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 1 }];
  check('an order goes only onto an empty bill', /Finish, hold or clear/.test(OU.orderToCart(cv.order.id).error));
  store.cart = []; store.cartCust = null;
  const oc = OU.orderToCart(cv.order.id);
  check('the order on the bill: what is left, at its prices, for its customer, capped by stock', !oc.error && store.cart.length === 2 && store.cart.find((c) => c.v === 'p2:').q === 1 && store.cart.every((c) => c.ord === cv.order.id)
    && store.cartCust.id === 'c1' && store.cartOrder.id === cv.order.id && store.cart.find((c) => c.v === 'p1:').price === 500, oc);
  const soldBefore = D().sold['p1:'] || 0;
  const co = await checkout('cash');
  const after = OU.orderById(cv.order.id);
  check('checkout: the bill keeps the order; the order is partly delivered; only the bill took stock', !co.error && store.lastSale.order === cv.order.id && store.lastSale.items.every((i) => i.ord === cv.order.id && i.oln != null)
    && after.status === 'partial' && after.saleIds[0] === store.lastSale.id && (D().sold['p1:'] || 0) === soldBefore + 1 && store.cartOrder === null, { co, after });
  store.moves.m3 = { id: 'm3', v: 'p2:', p: 'p2', q: 5, type: 'in', t: 2 }; invalidate();
  OU.orderToCart(cv.order.id);
  check('the rest goes on the next bill', store.cart.length === 1 && store.cart[0].v === 'p2:' && store.cart[0].q === 1);
  await checkout('cash');
  check('completed when everything is delivered', OU.orderById(cv.order.id).status === 'completed' && OU.orderById(cv.order.id).saleIds.length === 2 && !!OU.orderToCart(cv.order.id).error);
  // a quotation billed straight away; detaching a bill from its order
  const q2 = OU.saveOrder({ ...OU.newOrderDraft('quote', {}), cust: { id: 'c1', name: 'Riya' }, items: [OU.orderLine('p1:', 1)] }).order;
  OU.orderToCart(q2.id); OU.detachCartOrder();
  await checkout('cash');
  check('a bill detached from its order doesn\'t deliver it', !store.lastSale.order && OU.orderById(q2.id).status === 'draft');
  OU.orderToCart(q2.id);
  member('cashier', ['view_products', 'create_sale']);
  check('billing an order needs create_order too', /bill orders/.test((await checkout('cash')).error || '') && store.cart.length === 1);
  ownerAgain();
  await checkout('cash');
  check('a quotation billed straight away is converted to the bill', OU.orderById(q2.id).status === 'converted' && OU.orderById(q2.id).convertedTo === store.lastSale.id);
  // expired
  const q3 = OU.saveOrder({ ...OU.newOrderDraft('quote', {}), cust: { id: 'c1', name: 'Riya' }, validUntil: '2020-01-01', items: [OU.orderLine('p1:', 1)] }).order;
  check('an expired quotation can\'t be billed or converted until its validity is extended', /expired/.test(OU.orderToCart(q3.id).error) && /expired/.test(OU.convertToSalesOrder(q3.id).error)
    && !OU.saveOrder({ ...OU.orderById(q3.id), validUntil: '2099-01-01' }).error && !OU.orderToCart(q3.id).error);
  store.cart = []; store.cartOrder = null;
}
// uploads refused as changed elsewhere, and what a download keeps
{
  const PL = await import('../../src/features/sync/services/pull.js');
  const o = OU.ordersOf('quote')[0];
  const cloudOrders = [{ ...o, status: 'cancelled', version: 9 }];
  override({ cloud: { ...baseCloud, async fetchOrders(){ return cloudOrders; }, async fetchHeldCarts(){ return [{ id: 'hx', name: 'Other till', data: { cart: [] }, t: 1, dev: 'd2' }]; }, async fetchCollections(){ return []; },
    async saveOrder(){ const e = new Error('changed on another device'); e.code = '40001'; throw toAppError(e); } } });
  OU.saveOrder({ ...o, notes: 'changed here' });
  store.sbClient = {}; store.sbStatus = 'connected'; await OB.flushSbQueue(); store.sbClient = null; store.sbStatus = 'disconnected';
  check('saving on an old version: refused as changed elsewhere → sync review, not overwritten', store.syncReview.some((r) => r.item.type === 'order' && r.item.id === o.id) && !q('order').length);
  await PL.pullOrders();
  check('the download brings the cloud\'s order (the refused change stays in the review), other tills\' held bills, and keeps this device\'s collections',
    OU.orderById(o.id).status === 'cancelled' && OU.orderById(o.id).version === 9 && listHeldCarts().some((h) => h.id === 'hx') && Object.keys(store.collections).length === 2);
}

// the screens draw (a stand-in DOM: every element is the same object, so innerHTML is the last thing drawn)
{
  const OP = await import('../../src/features/orders/pages/orders-page.js');
  const OE = await import('../../src/features/orders/components/order-editor.js');
  const CA = await import('../../src/features/customers/components/customer-account.js');
  const PS = await import('../../src/features/sales/components/payment-sheet.js');
  const BP = await import('../../src/features/sales/components/bill-panel.js');
  store.ordersView = 'quote'; OP.renderOrders();
  check('Orders → Quotations lists them with their status', /data-ordview="held"/.test(el.innerHTML) && /QT-/.test(el.innerHTML) && /ostat-/.test(el.innerHTML), el.innerHTML.slice(0, 300));
  store.ordersView = 'held'; OP.renderOrders();
  check("Orders → Held bills: another till's held bill with Recall", /data-heldrecall="hx"/.test(el.innerHTML) && /Other till/.test(el.innerHTML));
  const so = OU.ordersOf('sales')[0];
  OE.openOrderEditor(so.id);
  check('the editor draws an order: customer, lines, totals, read-only once completed', /data-ofcust/.test(el.innerHTML) && /ofTotals/.test(el.innerHTML) && !/data-ofsave/.test(el.innerHTML) && /Completed/.test(el.innerHTML), el.innerHTML.slice(0, 300));
  OE.openOrderEditor(null, 'quote', false);
  check('a new quotation: the product search and Save', /id="ofQ"/.test(el.innerHTML) && /data-ofsave/.test(el.innerHTML) && /Valid until/.test(el.innerHTML));
  check('typing a search lists matching items', OE.orderFormInput({ id: 'ofQ', value: 'tee', dataset: {}, closest: () => el }) && store.orderForm.q === 'tee');
  store.orderForm = null;
  const acc = CA.accountHTML('c1');
  check('a customer\'s account: purchases, paid, outstanding and the history', /Total purchases/.test(acc) && /Outstanding/.test(acc) && /acents/.test(acc));
  CA.openCollectForm('c1');
  check('Collect payment opens with what they owe', /collectForm/.test(el.innerHTML) && store.collectForm && store.collectForm.amount === String(accountOf('c1').outstanding));
  store.collectForm = null;
  store.cart = [{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }]; store.cartCust = { id: 'c1', name: 'Riya', phone: '' };
  PS.openPayment('cash'); PS.payMode('credit');
  check('payment: the Credit option, everything on account until amounts are typed', store.payState.mode === 'credit' && /data-paymode="credit"/.test(el.innerHTML) && /On account/.test(el.innerHTML) && /paycred/.test(el.innerHTML), el.innerHTML.slice(0, 200));
  check('…the parts: nothing now, ₹500 on account', eq(PS.allocations().filter((a) => +a.amount > 0).map((a) => [a.method, a.amount]), [['due', 500]]));
  store.payState.amt.cash = '200';
  check('…₹200 cash now, ₹300 on account', eq(PS.allocations().filter((a) => +a.amount > 0).map((a) => [a.method, a.amount]), [['cash', '200'], ['due', 300]]));
  store.payState = null;
  store.imgs = store.imgs || {}; const bp = BP.billPanelHTML('sheet');
  check('the bill has Hold and "Save as quotation"', /data-hold/.test(bp) && /data-ordfromcart="quote"/.test(bp));
  store.cart = []; store.cartCust = null;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
