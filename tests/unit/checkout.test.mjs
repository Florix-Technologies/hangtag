// Discounts, GST, bill totals, payments (single and split) and the money books — the domain rules — and the checkout
// use cases that put them together. Run: npm run test:unit
import { allocate, checkBillDiscounts, checkDiscount, discountInput, discountLabel, discountPaise, normalizeDiscount } from '../../src/domain/sales/discounts.js';
import { gstinState, lineRate, lineTax, placeOfSupply, saleGstSplit, stateCode, taxBreakdown } from '../../src/domain/sales/gst.js';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { checkReference, payLabel, paymentId, paymentProgress, paymentsOf, settlePayments } from '../../src/domain/sales/payments.js';
import { bankBook, cashBook, financialTransactions, reconcileSale } from '../../src/domain/finance/books.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const P = (r) => Math.round(r * 100);   // rupees → paise, for exact comparisons
const intra = { mode: 'intra', inclusive: false }, none = { mode: 'none', inclusive: false };
const T = (lines, billDisc, gst = none) => computeCheckout({ lines, billDisc, gst });

// ---------- discounts ----------
check('item discount, percent: 10% off 2 × ₹999 is ₹199.80', T([{ q: 2, price: 999, disc: { type: 'percent', value: 10 } }]).itemDisc === 199.8);
check('item discount, fixed: ₹150 off a ₹1,000 line (the whole line, not each piece)', T([{ q: 2, price: 500, disc: { type: 'fixed', value: 150 } }]).itemDisc === 150);
check('bill discount, percent: 10% off ₹1,500', T([{ q: 1, price: 1000 }, { q: 1, price: 500 }], { type: 'percent', value: 10 }).billDisc === 150);
check('bill discount, fixed: ₹100 off, total ₹1,400', (() => { const r = T([{ q: 1, price: 1000 }, { q: 1, price: 500 }], { type: 'fixed', value: 100 }); return r.billDisc === 100 && r.total === 1400 && r.disc === 100; })());
const multi = T([{ q: 2, price: 999, disc: { type: 'percent', value: 10 } }, { q: 1, price: 250 }, { q: 3, price: 333 }], { type: 'fixed', value: 99.99 });
check('many items: the bill discount is applied after line discounts and shared over the lines exactly',
  P(multi.billDisc) === 9999 && multi.lines.reduce((a, l) => a + P(l.billDisc), 0) === 9999 && multi.lines[0].billDisc > multi.lines[1].billDisc && P(multi.disc) === P(multi.itemDisc) + 9999, multi.lines);
check('many items: subtotal − discounts = what GST is charged on', P(multi.sub) - P(multi.disc) === P(multi.taxable));
check('decimals: 12.5% of ₹999 is ₹124.88 (to the paisa); ₹10.55 off stays ₹10.55', T([{ q: 1, price: 999, disc: { type: 'percent', value: 12.5 } }]).itemDisc === 124.88 && T([{ q: 1, price: 999 }], { type: 'fixed', value: 10.55 }).billDisc === 10.55);
check('maximum: 100% off, or ₹ off equal to the line, leaves ₹0 — never less', T([{ q: 1, price: 999, disc: { type: 'percent', value: 100 } }]).total === 0 && T([{ q: 1, price: 999 }], { type: 'fixed', value: 999 }).total === 0);
check('a discount is never more than what it applies to (even if one slipped through)', discountPaise({ type: 'fixed', value: 5000 }, 1000) === 1000 && discountPaise({ type: 'percent', value: 250 }, 1000) === 1000);
check('invalid or excessive discounts are refused with a reason', checkDiscount({ type: 'percent', value: 101 }, 1000).error === "A discount can't be more than 100%."
  && checkDiscount({ type: 'fixed', value: 10.01 }, 1000).error === "A discount can't be more than ₹10." && checkDiscount({ type: 'fixed', value: -1 }, 1000).error === "A discount can't be negative."
  && checkDiscount({ type: 'fixed', value: 'abc' }, 1000).error === 'Enter a number for the discount.' && checkDiscount({ type: 'percent', value: 1.005 }, 1000).error === 'Use at most 2 decimal places.');
check('an empty discount box is no discount (not an error)', checkDiscount({ type: 'fixed', value: '' }, 1000) === null && checkDiscount(null, 1000) === null);
check('the bill discount is checked against what the line discounts leave', checkBillDiscounts([{ q: 1, price: 1000, disc: { type: 'fixed', value: 900 } }], { type: 'fixed', value: 200 }).error === "Bill discount: A discount can't be more than ₹100.");
check('a line discount that no longer fits (fewer pieces) is named', eq(checkBillDiscounts([{ name: 'Tee', q: 1, price: 100, disc: { type: 'fixed', value: 150 } }], null), { error: "Tee: A discount can't be more than ₹100.", line: 0 }));
check('removing: an empty, zero or cleared discount is no discount', normalizeDiscount('') === null && normalizeDiscount({ type: 'percent', value: 0 }) === null && normalizeDiscount(null) === null && T([{ q: 1, price: 500, disc: null }]).total === 500);
check('bills saved with a plain ₹ discount still read as ₹ off', eq(discountInput(50), { type: 'fixed', value: 50 }) && eq(normalizeDiscount(50), { type: 'fixed', value: 50 }) && discountInput(0) === null);
check('labels: "10%" and "₹50"', discountLabel({ type: 'percent', value: 10 }) === '10%' && discountLabel({ type: 'fixed', value: 50 }) === '₹50');
check('sharing out is exact, in proportion, ties to the earlier line', eq(allocate(100, [1, 1, 1]), [34, 33, 33]) && eq(allocate(0, [5, 5]), [0, 0]) && eq(allocate(7, [0, 0]), [0, 0]));

// ---------- GST ----------
const one = (amt, rate, g) => lineTax(P(amt), rate, g);
check('prices include GST (5%, CGST + SGST): ₹1,050 is ₹1,000 taxable + ₹25 + ₹25', eq(one(1050, 5, { mode: 'intra', inclusive: true }), { taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, tax: 5000, total: 105000, rate: 5 }));
check('GST added on top (12%): ₹1,000 + ₹60 CGST + ₹60 SGST = ₹1,120', eq(one(1000, 12, intra), { taxable: 100000, cgst: 6000, sgst: 6000, igst: 0, tax: 12000, total: 112000, rate: 12 }));
check('IGST (18%, on top): ₹1,000 + ₹180', eq(one(1000, 18, { mode: 'inter', inclusive: false }), { taxable: 100000, cgst: 0, sgst: 0, igst: 18000, tax: 18000, total: 118000, rate: 18 }));
check('IGST with prices including GST (18%): ₹1,180 is ₹1,000 + ₹180', eq(one(1180, 18, { mode: 'inter', inclusive: true }), { taxable: 100000, cgst: 0, sgst: 0, igst: 18000, tax: 18000, total: 118000, rate: 18 }));
check('zero GST (exempt goods): no tax, taxable = amount', eq(one(500, 0, intra), { taxable: 50000, cgst: 0, sgst: 0, igst: 0, tax: 0, total: 50000, rate: 0 }));
check('GST switched off: no tax even when a rate is set', one(500, 18, none).tax === 0 && T([{ q: 1, price: 500, rate: 18 }]).mode === 'none');
check('discount before GST: 10% off ₹1,000, then 5% on ₹900', (() => { const r = T([{ q: 1, price: 1000, rate: 5, disc: { type: 'percent', value: 10 } }], null, intra); return r.taxable === 900 && r.cgst === 22.5 && r.sgst === 22.5 && r.total === 945; })());
const r999 = T([{ q: 1, price: 999, rate: 5 }], null, intra);
check('rounding: 5% on ₹999 = CGST ₹24.98 + SGST ₹24.98 (always equal), ₹1,048.96 rounds to ₹1,049 (+₹0.04)', r999.cgst === 24.98 && r999.sgst === 24.98 && r999.exact === 1048.96 && r999.roundOff === 0.04 && r999.total === 1049);
check('rounding half up: ₹1,048.50 → ₹1,049; ₹1,048.49 → ₹1,048', T([{ q: 1, price: 1048.5 }]).total === 1049 && T([{ q: 1, price: 1048.49 }]).total === 1048 && T([{ q: 1, price: 1048.49 }]).roundOff === -0.49);
const mixed = T([{ q: 1, price: 1000, rate: 5 }, { q: 1, price: 2000, rate: 12 }], null, intra);
check('different rates on one bill: tax by rate, no single rate', mixed.rate === null && eq(mixed.breakdown.map((b) => [b.rate, b.taxable, b.tax]), [[5, 1000, 50], [12, 2000, 240]]) && mixed.tax === 290);
check('taxBreakdown skips untaxed lines', taxBreakdown([{ rate: 0, tax: 0, taxable: 1, cgst: 0, sgst: 0, igst: 0 }]).length === 0);
const shop = { gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' }, on = { taxOn: true };
check("customer GSTIN from another state → IGST; place of supply is the customer's state", eq(placeOfSupply({ settings: on, shop, customer: { gstin: '29ABCDE1234F1Z5', type: 'business' } }), { mode: 'inter', shopState: '27', pos: '29', b2b: true }));
check('customer GSTIN from the same state → CGST + SGST', placeOfSupply({ settings: on, shop, customer: { gstin: '27PQRSX1234F1Z5', type: 'business' } }).mode === 'intra');
check('walk-in or a customer without GSTIN (not registered for GST) → CGST + SGST in the shop\'s state', eq(placeOfSupply({ settings: on, shop, customer: null }), { mode: 'intra', shopState: '27', pos: '27', b2b: false })
  && eq(placeOfSupply({ settings: on, shop, customer: { gstin: '', type: 'individual' } }), { mode: 'intra', shopState: '27', pos: '27', b2b: false }));
check('a business customer is B2B only with a GSTIN', placeOfSupply({ settings: on, shop, customer: { gstin: '', type: 'business' } }).b2b === false && placeOfSupply({ settings: on, shop, customer: { gstin: '27PQRSX1234F1Z5', type: 'business' } }).b2b === true);
check('a malformed GSTIN is ignored (no IGST by mistake)', gstinState('29ABC') === '' && gstinState('99ABCDE1234F1Z5') === '' && placeOfSupply({ settings: on, shop, customer: { gstin: '29ABC' } }).mode === 'intra');
check("a shop without its own GSTIN uses its state's name (and old names)", stateCode('Maharashtra') === '27' && stateCode(' tamil  nadu ') === '33' && stateCode('Orissa') === '21' && stateCode('Narnia') === ''
  && placeOfSupply({ settings: on, shop: { state: 'Karnataka' }, customer: { gstin: '27ABCDE1234F1Z5' } }).mode === 'inter');
check('GST switched off in settings → a non-GST sale', placeOfSupply({ settings: { taxOn: false }, shop, customer: { gstin: '29ABCDE1234F1Z5', type: 'business' } }).mode === 'none');
check("a product's own rate beats the shop's; no rate → the shop's", lineRate(12, { taxRate: 5 }) === 12 && lineRate(0, { taxRate: 5 }) === 0 && lineRate(null, { taxRate: 5 }) === 5 && lineRate('', { taxRate: 18 }) === 18);
check("a saved bill's GST split; older bills (GST amount only) count as CGST + SGST halves", eq(saleGstSplit({ tax: 61 }), { mode: 'intra', cgst: 30.5, sgst: 30.5, igst: 0 }) && eq(saleGstSplit({ tax: 0 }), { mode: 'none', cgst: 0, sgst: 0, igst: 0 })
  && eq(saleGstSplit({ tax: 25, cgst: 0, sgst: 0, igst: 25, gst: { mode: 'inter' } }), { mode: 'inter', cgst: 0, sgst: 0, igst: 25 }));
check('the order is: subtotal → discount → taxable → GST → round off → total', (() => { const r = T([{ q: 3, price: 333, rate: 18, disc: { type: 'fixed', value: 99 } }], { type: 'percent', value: 5 }, intra);
  return P(r.sub) - P(r.disc) === P(r.taxable) && P(r.taxable) + P(r.tax) === P(r.exact) && P(r.exact) + P(r.roundOff) === P(r.total) && r.total % 1 === 0; })());

// ---------- payments ----------
check('cash, exact: received = amount, no change', eq(settlePayments(1049, [{ method: 'cash', amount: 1049 }]), { ok: true, payments: [{ method: 'cash', amount: 1049, received: 1049, change: 0, verification: 'recorded' }], paid: 1049, received: 1049, change: 0 }));
check('cash with ₹2,000 handed over: change ₹951', settlePayments(1049, [{ method: 'cash', amount: 1049, received: 2000 }]).change === 951);
check('cash handed over is less than the amount → refused', settlePayments(1049, [{ method: 'cash', amount: 1049, received: 1000 }]).error === 'Cash received is less than the cash amount.');
check('UPI checked by hand, explicitly marked received (reference optional): unverified', eq(settlePayments(500, [{ method: 'upi', amount: 500, ref: ' 412345678901 ', confirmed: true }]).payments, [{ method: 'upi', amount: 500, via: 'manual', verification: 'unverified', ref: '412345678901' }])
  && settlePayments(500, [{ method: 'upi', amount: 500 }]).field === 'confirmed');
check('card on a card machine: its reference is required (spec 006 FR-015), then recorded', settlePayments(500, [{ method: 'card', amount: 500 }]).field === 'ref' && eq(settlePayments(500, [{ method: 'card', amount: 500, ref: 'A1' }]).payments, [{ method: 'card', amount: 500, via: 'terminal', verification: 'recorded', ref: 'A1' }]));
check('a wrong amount: short or over the bill', settlePayments(1000, [{ method: 'upi', amount: 900, ref: 'U1' }]).error === '₹100 still to pay.' && settlePayments(1000, [{ method: 'upi', amount: 1100, ref: 'U1' }]).error === "That's ₹100 more than the bill.");
check('a bad reference is refused', !!checkReference('x'.repeat(41)) && !!checkReference('<script>') && checkReference('UTR-12/34') === null && settlePayments(10, [{ method: 'upi', amount: 10, ref: '<b>' }]).field === 'ref');
// split payments
// UPI and card parts carry their references (required for UPI checked by hand and the card machine)
const split = (list, due = 1000) => settlePayments(due, list.map((a) => a.method === 'upi' ? { confirmed: true, ...(a.ref === undefined ? { ref: 'Rupi' } : {}), ...a }
  : a.method === 'card' && a.ref === undefined ? { ...a, ref: 'Rcard' } : a));
check('split: cash + UPI', split([{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }]).ok);
check('split: cash + card', split([{ method: 'cash', amount: 250.5 }, { method: 'card', amount: 749.5 }]).ok);
check('split: UPI + card', split([{ method: 'upi', amount: 1 }, { method: 'card', amount: 999 }]).ok);
check('split: all three, with change on the cash part', (() => { const r = split([{ method: 'cash', amount: 300, received: 500 }, { method: 'upi', amount: 300 }, { method: 'card', amount: 400 }]); return r.ok && r.change === 200 && r.received === 1200 && r.paid === 1000; })());
check('split: underpayment is refused with the balance', eq((({ error, balance, paid }) => ({ error, balance, paid }))(split([{ method: 'cash', amount: 300 }, { method: 'upi', amount: 300 }])), { error: '₹400 still to pay.', balance: 400, paid: 600 }));
check('split: overpayment is refused (only cash can give change)', split([{ method: 'upi', amount: 600 }, { method: 'card', amount: 600 }]).error === "That's ₹200 more than the bill.");
check('split: the same method twice is refused (no duplicate allocation)', split([{ method: 'cash', amount: 500 }, { method: 'cash', amount: 500 }]).error === 'Cash is there twice. Put all of it on one line.');
check('split: negative, unknown method, too many decimals, text', !!split([{ method: 'cash', amount: -1 }, { method: 'upi', amount: 1001 }]).error && split([{ method: 'cheque', amount: 1000 }]).error === 'Choose cash, UPI or card.'
  && split([{ method: 'upi', amount: 999.999 }]).error === 'Use at most 2 decimal places.' && split([{ method: 'upi', amount: 'lots' }]).error === 'Enter the UPI amount as a number.');
check('split: empty rows are left out', split([{ method: 'cash', amount: '' }, { method: 'upi', amount: 1000 }, { method: 'card', amount: 0 }]).payments.length === 1);
check('nothing due (an exchange covered by its credit): no payment needed', eq(settlePayments(0, []), { ok: true, payments: [], paid: 0, received: 0, change: 0 }) && !!settlePayments(0, [{ method: 'cash', amount: 1 }]).error);
check('live figures: paid, balance, over and change', eq(paymentProgress(1000, [{ method: 'cash', amount: 300, received: 500 }, { method: 'upi', amount: 200 }]), { paid: 500, balance: 500, over: 0, change: 200 })
  && paymentProgress(1000, [{ method: 'upi', amount: 1200 }]).over === 200);
check('payment ids: one per bill and method', paymentId('s1', 'upi') === 's1:upi');
check('bills saved before split payments have one payment for what was due', eq(paymentsOf({ id: 'o', total: 1000, credit: 200, pay: 'card' }), [{ id: 'o:card', method: 'card', amount: 800 }]) && eq(paymentsOf({ id: 'o', total: 300, credit: 300, pay: 'cash' }), []));
check('payment labels', payLabel({ payments: [{ method: 'cash' }, { method: 'upi' }] }) === 'Cash + UPI' && payLabel({ id: 'x', total: 5, pay: 'card' }) === 'Card');

// ---------- financial transactions, cash book, bank book ----------
const sales = [
  { id: 'a', no: 'INV-1', t: 100, total: 1000, credit: 0, payments: [{ id: 'a:cash', method: 'cash', amount: 400, received: 500, change: 100 }, { id: 'a:upi', method: 'upi', amount: 600, ref: 'U1' }] },
  { id: 'b', no: 'INV-2', t: 200, total: 700, credit: 0, pay: 'cash' },                                   // saved before split payments
  { id: 'c', no: 'INV-3', t: 300, total: 900, credit: 0, void: true, payments: [{ id: 'c:card', method: 'card', amount: 900 }] },
  { id: 'd', no: 'INV-4', t: 400, total: 300, credit: 300, kind: 'exchange', pay: 'cash' },              // covered by credit
];
const returns = [{ id: 'r1', sale: 'b', t: 500, refund: 200, pay: 'cash' }, { id: 'r2', sale: 'a', t: 600, refund: 100, pay: 'upi' }, { id: 'r3', sale: 'a', t: 700, refund: 0, pay: 'cash' }];
const tx = financialTransactions(sales, returns);
check('one transaction per payment and per refund, each naming its bill (none for ₹0)', eq(tx.map((x) => [x.id, x.kind, x.dir, x.amount, x.saleId, x.billNo]), [
  ['ft:a:cash', 'sale_receipt', 'in', 400, 'a', 'INV-1'], ['ft:a:upi', 'sale_receipt', 'in', 600, 'a', 'INV-1'], ['ft:b:cash', 'sale_receipt', 'in', 700, 'b', 'INV-2'],
  ['ft:c:card', 'sale_receipt', 'in', 900, 'c', 'INV-3'], ['ft:r1', 'refund', 'out', 200, 'b', 'INV-2'], ['ft:r2', 'refund', 'out', 100, 'a', 'INV-1']]));
check('sale → payment → transaction links: the payment id is kept on the transaction', tx[0].paymentId === 'a:cash' && tx[4].returnId === 'r1' && tx[4].paymentId === null);
check('a cancelled bill keeps its transactions, marked cancelled', tx.find((x) => x.id === 'ft:c:card').status === 'cancelled' && tx.filter((x) => x.status === 'posted').length === 5);
check('the same bills always give the same transactions (nothing twice)', eq(financialTransactions(sales, returns), tx) && new Set(tx.map((x) => x.id)).size === tx.length);
const cb = cashBook(tx);
check('cash book: cash sales in, refunds out, running balance', eq(cb.entries.map((e) => [e.id, e.type, e.in, e.out, e.balance]), [['cb:ft:a:cash', 'cash_sale', 400, 0, 400], ['cb:ft:b:cash', 'cash_sale', 700, 0, 1100], ['cb:ft:r1', 'cash_refund', 0, 200, 900]]));
check('cash book totals: cash sales, cash received and change given, refunds, balance', cb.cashSales === 1100 && cb.received === 1200 && cb.changeGiven === 100 && cb.refunds === 200 && cb.closing === 900 && cb.opening === 0);
const cbLater = cashBook(tx, { from: 150, to: 450 });
check('cash book for a period: opening balance from before it, only its entries', cbLater.opening === 400 && cbLater.entries.length === 1 && cbLater.closing === 1100);
const bb = bankBook(tx);
check('bank book: UPI and card in (cancelled marked, not counted), UPI refund out', eq(bb.entries.map((e) => [e.id, e.method, e.in, e.out, e.status]), [['bb:ft:a:upi', 'upi', 600, 0, 'posted'], ['bb:ft:c:card', 'card', 900, 0, 'cancelled'], ['bb:ft:r2', 'upi', 0, 100, 'posted']])
  && bb.upiIn === 600 && bb.cardIn === 0 && bb.refunds === 100 && bb.net === 500 && bb.cancelled === 1 && bb.entries[0].ref === 'U1');
check('reconciliation: receipts match what was due; a cancelled bill is due nothing', reconcileSale(sales[0], tx).ok && reconcileSale(sales[1], tx).ok && eq(reconcileSale(sales[2], tx), { due: 0, received: 0, ok: true }) && reconcileSale(sales[3], tx).ok
  && !reconcileSale({ id: 'a', total: 1100, credit: 0 }, tx).ok);
check('paise stay exact in the books', cashBook(financialTransactions([{ id: 'z', t: 1, total: 0.3, credit: 0, payments: [{ id: 'z:cash', method: 'cash', amount: 0.1 }, { id: 'z:x', method: 'cash', amount: 0.2 }] }], [])).closing === 0.3);

// ---------- checkout use cases (the app's bill, with this shop's settings) ----------
const mem = {};
override({ storage: { get: (k, f) => (k in mem ? mem[k] : f), set: (k, v) => { mem[k] = v; return true; }, getRaw: (k) => mem[k] ?? null, setRaw: (k, v) => { mem[k] = v; }, remove: (k) => { delete mem[k]; } } });
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: {}, returnsMap: {}, moves: {}, _d: null, customers: {}, cartCust: null, disc: null,
  settings: { taxOn: true, taxRate: 5, taxIncl: false, prefix: 'INV-' }, profile: { gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' },
  catalog: { version: 3, products: [{ id: 'p1', name: 'Tee', price: 999, gst: 12, hsn: '6109', opts: [], variants: [{ id: 'p1:', o: [], active: true }] }, { id: 'p2', name: 'Cap', price: 500, gst: null, opts: [], variants: [{ id: 'p2:', o: [], active: true }] }] } });
const { newSaleRecord } = await import('../../src/features/sales/use-cases/checkout.js');
const { setBillDiscount, setLineDiscount, billDiscountError } = await import('../../src/features/sales/use-cases/discounts.js');
const { billTotals } = await import('../../src/features/sales/services/totals.js');
store.cart = [{ v: 'p1:', p: 'p1', name: 'Tee', q: 2, price: 999 }, { v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 500 }];
check('the bill uses each product\'s GST rate (Tee 12%, Cap the shop\'s 5%)', eq(billTotals(store.cart, null).breakdown.map((b) => b.rate), [5, 12]));
check('line discount: set, then removed', setLineDiscount(0, { type: 'percent', value: 10 }).ok && store.cart[0].disc.value === 10 && setLineDiscount(0, { type: 'percent', value: '' }).ok && !store.cart[0].disc);
check('line discount: too much is refused and nothing changes', setLineDiscount(1, { type: 'fixed', value: 600 }).error === "A discount can't be more than ₹500." && !store.cart[1].disc);
setLineDiscount(0, { type: 'fixed', value: 198 });
check('bill discount: kept as typed; a bad one blocks payment with its reason', setBillDiscount({ type: 'percent', value: 150 }).error === "Bill discount: A discount can't be more than 100%." && billDiscountError() !== '' && store.disc.value === 150);
check('…and a bill with a bad discount cannot be completed', newSaleRecord(store.cart, store.disc, 'cash').error === "Bill discount: A discount can't be more than 100%.");
setBillDiscount({ type: 'percent', value: 5 });
const walkIn = newSaleRecord(store.cart, store.disc, 'cash');
check('walk-in cash sale: totals, one cash payment for the total, CGST + SGST', walkIn.cust === null && walkIn.pay === 'cash' && eq(walkIn.payments, [{ id: walkIn.id + ':cash', method: 'cash', amount: walkIn.total, received: walkIn.total, change: 0, verification: 'recorded' }])
  && walkIn.gst.mode === 'intra' && walkIn.igst === 0 && walkIn.itemDisc === 198 && walkIn.billDisc.value === 5 && walkIn.items[0].disc.value === 198 && walkIn.items[0].hsn === '6109' && walkIn.items[0].gst === 12, walkIn);
check('the saved bill adds up: subtotal − discount = taxable; + GST + round off = total; lines add up', P(walkIn.sub) - P(walkIn.disc) === P(walkIn.taxable) && P(walkIn.taxable) + P(walkIn.tax) + P(walkIn.roundOff) === P(walkIn.total)
  && walkIn.items.reduce((a, i) => a + P(i.lt), 0) === P(walkIn.total) - P(walkIn.roundOff));
store.customers = { c1: { id: 'c1', name: 'Blr Traders', phone: '', gstin: '29ABCDE1234F1Z5', type: 'business' } };
store.cartCust = { id: 'c1', name: 'Blr Traders', phone: '' };
const b2b = newSaleRecord(store.cart, store.disc, [{ method: 'upi', amount: 1000, ref: 'U77' }, { method: 'card', amount: 'x' }]);
check('split with a bad amount is refused', b2b.error === 'Enter the Card amount as a number.');
const due = billTotals(store.cart, store.disc).total;
  const sale2 = newSaleRecord(store.cart, store.disc, [{ method: 'upi', amount: 1000, ref: 'U77', confirmed: true }, { method: 'cash', amount: due - 1000, received: due - 900 }]);
check('customer from another state with a GSTIN: IGST, the customer GSTIN kept on the bill, split UPI + cash with change', sale2.gst.mode === 'inter' && sale2.gst.pos === '29' && sale2.gst.b2b && sale2.cgst === 0 && sale2.igst > 0
  && sale2.cust.gstin === '29ABCDE1234F1Z5' && sale2.cust.type === 'business' && sale2.pay === 'split' && sale2.payments.length === 2 && sale2.payments[1].change === 100, sale2);
check('an incorrect split total never makes a bill', newSaleRecord(store.cart, store.disc, [{ method: 'upi', amount: 1, ref: 'U1' }]).error === `₹${(due - 1).toLocaleString('en-IN')} still to pay.`);
store.settings.taxOn = false;
check('GST off: a non-GST bill (no tax, taxable = amount after discounts)', (() => { const s = newSaleRecord(store.cart, store.disc, { method: 'card', ref: 'A1' }); return s.gst.mode === 'none' && s.tax === 0 && s.taxable === s.sub - s.disc && s.payments[0].method === 'card'; })());
const ex = newSaleRecord([{ v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 500 }], null, 'cash', { kind: 'exchange', ex: 'x1', credit: 500, cust: null });
check('an exchange covered by its credit: nothing to pay, no payment rows', ex.kind === 'exchange' && ex.credit === 500 && eq(ex.payments, []) && ex.pay === 'cash');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
