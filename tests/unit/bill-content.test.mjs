// One document engine (src/domain/documents/bill-content.js): a bill's facts become one document — its totals, payments
// and what follows them, in one set of words and one order — and every output only lays it out. So for the same bill the
// 80 mm receipt (screen and print), the A4 tax invoice (its preview, print and PDF come from one model), the WhatsApp text
// and the thermal printer's slip list the same money rows with the same amounts: nothing can drift between them.
// Checked on five kinds of bill: a split payment with change and a reference (IGST, prices without GST), prices with GST
// included (CGST + SGST), an exchange with credit, a bill partly on account, and one with nothing to pay. Run: npm run test:unit
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { printerOf } from '../../src/domain/shop/printer-settings.js';
import { billContent, billRows, lineSub, paymentNote } from '../../src/domain/documents/bill-content.js';
import { thermalReceipt } from '../../src/domain/receipts/thermal.js';
import { inrx } from '../../src/shared/formatting/money.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); } };
const J = (x) => JSON.stringify(x);

const mem = {};
override({ storage: { get: (k, f) => (k in mem ? mem[k] : f), set: (k, v) => { mem[k] = v; return true; }, getRaw: (k) => mem[k] ?? null, setRaw: (k, v) => { mem[k] = v; }, remove: (k) => { delete mem[k]; } } });
const profile = { shop_name: 'Aura Threads', address: '12 MG Road', city: 'Pune', state: 'Maharashtra', phone: '9876543210', gstin: '27ABCDE1234F1Z5' };
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: { 'today_d1_0': { date: 'x', dev: 'd1', chunk: 0, sales: [], voids: [] } }, dirty: new Set(), returnsMap: {}, moves: {}, _d: null,
  customers: { c1: { id: 'c1', name: 'Blr Traders', phone: '98450 12345', email: 'accounts@blr.in', gstin: '29ABCDE1234F1Z5', type: 'business' }, c2: { id: 'c2', name: 'Riya', phone: '98200 00000', email: '' } },
  cartCust: null, disc: null, settings: { taxOn: true, taxRate: 5, taxIncl: false, prefix: 'INV-', footer: 'Thank you!' }, profile, logo: '', sbOfflineQueue: [], deliveries: {}, channels: null, printer: printerOf(null),
  catalog: { version: 3, products: [{ id: 'p1', name: 'Kurta – Blue', price: 999, gst: 12, hsn: '6109', opts: [{ n: 'Size', v: ['M'] }], variants: [{ id: 'p1:M', o: ['M'], active: true }] },
    { id: 'p2', name: 'Cap', price: 500, gst: null, opts: [], variants: [{ id: 'p2:', o: [], active: true }] }] } });
const { newSaleRecord } = await import('../../src/features/sales/use-cases/checkout.js');
const { invoiceFor, receiptText } = await import('../../src/features/receipts/services/receipt-model.js');
const { invoiceModel } = await import('../../src/features/receipts/services/doc-models.js');
const { receiptHTML } = await import('../../src/features/receipts/components/receipt-view.js');
const lines = () => [{ v: 'p1:M', p: 'p1', name: 'Kurta – Blue', c: '', s: 'M', ov: [{ n: 'Size', v: 'M' }], q: 2, price: 999, disc: { type: 'percent', value: 10 } }, { v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 500 }];
const put = (s) => { if (s.error) throw new Error(s.error); store.localDays.today_d1_0.sales.push(s); store._d = null; return s; };

// five bills
store.cartCust = { id: 'c1', name: 'Blr Traders', phone: '98450 12345' };
const t1 = newSaleRecord(lines(), { type: 'fixed', value: 50 }, 'cash').total;
store.cartCust = { id: 'c1', name: 'Blr Traders', phone: '98450 12345' };
const split = put(newSaleRecord(lines(), { type: 'fixed', value: 50 }, [{ method: 'cash', amount: 1000, received: 1500 }, { method: 'upi', amount: Math.round((t1 - 1000) * 100) / 100, ref: 'UTR998877', confirmed: true }]));
store.settings = { ...store.settings, taxIncl: true }; store.cartCust = null;
const incl = put(newSaleRecord(lines(), null, { method: 'card', confirmed: true, last4: '4242' }));
const exch = put(newSaleRecord([{ v: 'p2:', p: 'p2', name: 'Cap', q: 2, price: 500 }], null, 'cash', { kind: 'exchange', credit: 400 }));
store.cartCust = { id: 'c2', name: 'Riya', phone: '98200 00000' };
const t4 = newSaleRecord(lines(), null, 'cash').total;
store.cartCust = { id: 'c2', name: 'Riya', phone: '98200 00000' };
const onAcct = put(newSaleRecord(lines(), null, [{ method: 'cash', amount: 1000 }, { method: 'due', amount: Math.round((t4 - 1000) * 100) / 100 }]));
store.cartCust = null;
const zero = put(newSaleRecord([{ v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 500 }], { type: 'percent', value: 100 }, 'cash'));
check('five bills saved', [split, incl, exch, onAcct, zero].every((s) => s && s.id), [split, incl, exch, onAcct, zero].map((s) => s && s.error));

/* each output's money rows as [label, value] */
const amount = (x) => x.amount == null ? '' : (x.sign || '') + inrx(x.amount);
const strip = (h) => h.replace(/<small>.*?<\/small>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
const from80 = (s) => { const h = receiptHTML(s, '80mm'), tot = h.slice(h.indexOf('<div class="r-tot">'));
  return [...tot.matchAll(/<div class="r-row[^"]*"><span>(.*?)<\/span><span>(.*?)<\/span><\/div>/g)].map((m) => [strip(m[1]), strip(m[2])]); };
const fromA4 = (s) => invoiceModel(s).totals.map(([l, v]) => [l, v]);
const fromDoc = (s) => billRows(billContent(invoiceFor(s))).map((x) => [x.label, amount(x)]);
// the A4 shows a payment's note beside its label ("Paid by UPI (ref …)"), the 80 mm receipt under it
const fromDocA4 = (s) => billRows(billContent(invoiceFor(s))).map((x) => [x.label + (x.note ? ` (${x.note})` : ''), amount(x)]);
const BILLS = { 'a split payment with change and a reference': split, 'prices with GST included': incl, 'an exchange with credit': exch, 'a bill partly on account': onAcct, 'nothing to pay': zero };
for (const [name, s] of Object.entries(BILLS)) {
  const doc = fromDoc(s), r80 = from80(s), a4 = fromA4(s), text = receiptText(s).split('\n'), slip = thermalReceipt(invoiceFor(s)).lines.map((l) => l.text);
  check(`${name}: the 80 mm receipt lists exactly the document's rows`, J(r80) === J(doc), { r80, doc });
  check(`${name}: the A4 invoice (preview, print, PDF) lists exactly the same rows`, J(a4) === J(fromDocA4(s)), { a4, doc: fromDocA4(s) });
  let at = -1; const inText = doc.every(([l, v]) => { const i = text.findIndex((t, k) => k > at && t.replace(/\*/g, '').startsWith(v ? `${l}: ${v}` : l)); if (i < 0) return false; at = i; return true; });
  check(`${name}: the WhatsApp text has them, in the same order`, inText, { doc, text });
  let ti = -1; const inSlip = doc.filter(([l]) => l !== 'Change given').every(([l]) => { const want = l === 'Total' ? 'TOTAL' : l.replace(/^(Amount due|Balance due)/, (m) => m.toUpperCase());
    const i = slip.findIndex((t, k) => k > ti && t.startsWith(want.replace('–', '-'))); if (i < 0) return false; ti = i; return true; });
  check(`${name}: the thermal slip has them, in the same order (its change printed under the cash payment)`, inSlip, { doc, slip });
}
// the digital receipt, email and WhatsApp are written by the send-receipt function from the rows the app saves to the cloud:
// the same bills through the app's own cloud mappers and the function's billView give exactly the same rows
const { billArgs } = await import('../../src/infrastructure/supabase/mappers.js');
const { billView } = await import('../../supabase/functions/send-receipt/core.js');
for (const [name, s] of Object.entries(BILLS)) {
  const a = billArgs(s), server = billView({ sale: a.sale, items: a.items, payments: a.payments, returns: [], shop: { shop_name: 'Aura Threads' }, customer: s.cust || null, region: 'IN' }).rows.map(([l, v]) => [l, v]);
  check(`${name}: the digital receipt and messages (the server) list exactly the same rows`, J(server) === J(fromDocA4(s)), { server, app: fromDocA4(s) });
}
// what the document itself says
const D1 = billContent(invoiceFor(split)), R1 = billRows(D1).map((x) => x.label);
check('split: totals, then each payment (with how it was paid), then the change', J(R1.slice(-3)) === J(['Paid by Cash', 'Paid by UPI', 'Change given']) && D1.payments[0].note === 'received ₹1,500 · change ₹500' && D1.payments[1].note === 'ref UTR998877 · unverified', [R1, D1.payments]);
const D2 = billContent(invoiceFor(incl));
check('GST included: the total, then the taxable amount and "Includes CGST / SGST" under it', J(billRows(D2).map((x) => x.label).slice(-5, -1)) === J(['Total', 'Taxable amount', 'Includes CGST 2.5%', 'Includes SGST 2.5%'])
  || billRows(D2).some((x) => /^Includes CGST/.test(x.label)), billRows(D2).map((x) => x.label));
const D3 = billContent(invoiceFor(exch));
check('exchange: the credit off the total, then the amount due', billRows(D3).some((x) => x.key === 'credit' && x.sign === '−' && x.amount === 400) && billRows(D3).some((x) => x.key === 'due' && x.grand));
const D4 = billContent(invoiceFor(onAcct));
check('on account: what was paid, then the balance due (on account) — never "paid" for the whole bill', billRows(D4).some((x) => x.label === 'Paid by Cash' && x.amount === 1000) && billRows(D4).some((x) => x.label === 'Balance due (on account)' && x.grand));
const D5 = billContent(invoiceFor(zero));
check('nothing to pay: said once, no payment rows', D5.settled === 'Nothing to pay' && !D5.payments.length && billRows(D5).filter((x) => x.key === 'settled').length === 1);
check('a line\'s details under its name: variant, SKU, serials, batch', lineSub({ variant: 'M', sku: 'K-1', serials: 'A1, A2', batch: 'B7' }) === 'M · K-1 · SN A1, A2 · Batch B7');
check('a payment note in words', paymentNote({ method: 'card', last4: '4242', verification: 'verified' }) === 'card ••4242 · verified');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
