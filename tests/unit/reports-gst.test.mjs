// Phase 19 (reports and profit) and Phase 20 (GST report and export): figures come from the saved bills and returns only,
// with one set of definitions; profit is never guessed; GST is what the invoices and credit notes carry.
// Run: npm run test:unit
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { quoteReturn } from '../../src/domain/returns/return-value.js';
import { groupLines, paymentSummary, profitSummary, returnLineMoney, saleLineMoney, salesSummary } from '../../src/domain/reports/sales-report.js';
import { DISCLAIMER, gstCreditNote, gstInvoice, gstReport, isB2B } from '../../src/domain/gst/gst-report.js';
import { csvText } from '../../src/shared/utils/csv.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';
import { store } from '../../src/shared/state/store.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const P = (r) => Math.round(r * 100);

/* A bill as checkout saves it: totals from the domain, payments settled */
function bill(id, lines, { billDisc = null, mode = 'intra', pays, credit = 0, t = 1790000000000, cust = null, kind = 'sale', pos = '27', voided = false } = {}) {
  const T = computeCheckout({ lines, billDisc, gst: { mode, inclusive: false } }), due = T.total - credit;
  const S = settlePayments(due, pays ? pays(due) : due > 0 ? [{ method: 'cash', amount: due }] : []);
  return { id, no: 'INV-' + id, t, kind, credit, cust, void: voided, gst: { mode, pos }, billDisc, roundOff: T.roundOff, total: T.total, sub: T.sub, disc: T.disc, tax: T.tax, taxRate: T.rate || 0,
    items: lines.map((l, k) => { const L = T.lines[k]; return { ln: k, p: l.p || 'p1', v: l.v || 'p1:M', n: l.n || 'Tee', q: l.q, price: l.price, cost: l.cost === undefined ? null : l.cost,
      gst: L.rate, hsn: l.hsn === undefined ? '6109' : l.hsn, tx: L.taxable, cgst: L.cgst, sgst: L.sgst, igst: L.igst, lt: L.total, dAmt: L.itemDisc, bdAmt: L.billDisc }; }),
    payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
const ret = (id, sale, picks, extra = {}) => { const Q = quoteReturn(sale, picks, extra.prior || []);
  return { id, no: 'CN-' + id, sale: sale.id, t: sale.t + 1000, kind: extra.kind || 'return', refund: extra.refund === undefined ? Q.value : extra.refund, pay: extra.pay || 'cash', value: Q.value, ro: Q.roundOff,
    items: Q.lines.map((L) => { const i = sale.items.find((x) => x.ln === L.ln); return { ln: L.ln, v: i.v, p: i.p, n: i.n, q: L.q, price: L.unit, value: L.value, cost: i.cost, tx: L.tx, cgst: L.cgst, sgst: L.sgst, igst: L.igst, gst: L.rate, hsn: L.hsn }; }) }; };

// ---------- the report definitions ----------
const biz = { id: 'c1', name: 'Acme', type: 'business', gstin: '27ABCDE1234F1Z5' }, far = { id: 'c2', name: 'Far', type: 'business', gstin: '29ABCDE1234F1Z5' };
const s1 = bill('1', [{ q: 2, price: 999, rate: 12, cost: 400 }, { q: 1, price: 499, rate: 5, cost: null, hsn: '6505', p: 'p2', v: 'p2:', n: 'Cap' }], { billDisc: { type: 'percent', value: 10 }, cust: biz,
  pays: (d) => [{ method: 'upi', amount: 1000, ref: 'U1' }, { method: 'cash', amount: d - 1000, received: d - 1000 }] });
const s2 = bill('2', [{ q: 1, price: 2000, rate: 12, cost: 900 }], { mode: 'inter', pos: '29', cust: far, pays: (d) => [{ method: 'card', amount: d, ref: 'APPR2' }] });
const s3 = bill('3', [{ q: 1, price: 300, rate: 0, cost: 100, hsn: '' }], {});
const sv = bill('4', [{ q: 5, price: 1000, rate: 12, cost: 500 }], { voided: true });
const r1 = ret('r1', s1, { 0: 1 });
const live = [s1, s2, s3], rets = [r1], byId = { 1: s1, 2: s2, 3: s3, 4: sv };
const S = salesSummary(live, rets, byId);
check('total sales = gross − returns; and = net sales + GST + round off (every rupee accounted for)', S.total === Math.round((s1.total + s2.total + s3.total - r1.value) * 100) / 100
  && P(S.netSales) + P(S.gst) + P(S.roundOff) === P(S.total), S);
check('net sales (revenue) is the saved taxable value less what was returned', P(S.netSales) === P(s1.items[0].tx + s1.items[1].tx + s2.items[0].tx + s3.items[0].tx) - P(r1.items[0].tx));
check('GST is the saved tax less the tax reversed; CGST / SGST / IGST apart', P(S.cgst) === P(s1.items[0].cgst + s1.items[1].cgst - r1.items[0].cgst) && S.igst === s2.items[0].igst && P(S.gst) === P(S.cgst) + P(S.sgst) + P(S.igst));
check('discounts, bills, pieces, average bill', S.discounts === s1.disc && S.bills === 3 && S.piecesSold === 5 && S.piecesReturned === 1 && S.pieces === 4 && S.avgBill === Math.round((s1.total + s2.total + s3.total) / 3 * 100) / 100);
check('returns and exchanges counted apart', S.returnCount === 1 && S.exchangeReturns === 0 && S.exchanges === 0 && S.refunds === r1.value);
const PM = paymentSummary(live, rets);
check('payments by method: each part of a split bill under its own method; refunds by the method paid', PM.methods.upi.in === 1000 && PM.methods.cash.in === Math.round((s1.total - 1000 + s3.total) * 100) / 100
  && PM.methods.card.in === s2.total && PM.methods.cash.refunds === r1.value && PM.split.bills === 1 && PM.split.value === s1.total && PM.net === Math.round((PM.in - PM.refunds) * 100) / 100, PM);
const lines = [...live.flatMap((s) => s.items.map((i) => saleLineMoney(s, i))), ...rets.flatMap((r) => r.items.map((i) => returnLineMoney(byId[r.sale], i)))];
const PR = profitSummary(lines);
check('profit only from lines with a known cost: the Cap (no cost) is left out and the coverage says so', !PR.complete && PR.piecesWithoutCost === 1 && P(PR.uncovered) === P(s1.items[1].tx) && PR.coverage > 0 && PR.coverage < 1, PR);
check('cost of goods: saved cost × pieces, less the returned piece', PR.cogs === 400 * 2 + 900 + 100 - 400);
check('gross profit = covered net sales − cost of goods; margin on covered sales', P(PR.grossProfit) === P(PR.covered) - P(PR.cogs) && PR.margin === Math.round((PR.covered - PR.cogs) / PR.covered * 1000) / 10);
check('no cost prices at all: no profit claimed (margin unknown, coverage 0)', (() => { const x = profitSummary([{ q: 1, rev: 100, cost: null }]); return x.covered === 0 && x.margin === null && x.coverage === 0 && !x.complete; })());
check('every cost known: profit is complete', profitSummary([{ q: 1, rev: 100, cost: 60 }]).complete);
const G = groupLines(lines.map((l, i) => ({ ...l, pid: i === 1 ? 'p2' : 'p1' })), (l) => l.pid);
check('product sales grouped (pieces net of returns; cost unknown when any line lacks it)', G[0].key === 'p1' && G[0].q === 3 && G.find((g) => g.key === 'p2').cost === null, G);

// ---------- GST report ----------
check('B2B = business customer with a valid GSTIN', isB2B(s1) && isB2B(s2) && !isB2B(s3) && !isB2B({ cust: { type: 'business', gstin: 'BAD' } }));
const inv = gstInvoice(s1);
check('an invoice\'s GST is its saved lines (no GST worked out again)', inv.taxable === Math.round((s1.items[0].tx + s1.items[1].tx) * 100) / 100 && inv.cgst === Math.round((s1.items[0].cgst + s1.items[1].cgst) * 100) / 100 && inv.pos === '27' && inv.posName === 'Maharashtra');
const cn = gstCreditNote(r1, s1);
check('a credit note carries the original invoice number and date, B2B, place of supply and the GST reversed', cn.invoiceNo === 'INV-1' && cn.invoiceT === s1.t && cn.b2b && cn.pos === '27' && cn.cgst === r1.items[0].cgst && cn.lines[0].rate === 12);
const oldRet = { id: 'r0', sale: '1', t: 1, value: r1.items[0].value, items: [{ ln: 0, q: 1, value: r1.items[0].value }] };
check('an older return (no GST kept) reverses its share of the line\'s GST', gstCreditNote(oldRet, s1).cgst === r1.items[0].cgst);
const GR = gstReport({ sales: [s1, s2, s3, sv], returns: rets, saleById: byId });
check('cancelled invoices are listed apart and left out of every total', GR.cancelled.length === 1 && GR.invoices.length === 3 && GR.docs.invoices.count === 4 && GR.docs.invoices.cancelled === 1);
check('net = invoices − credit notes (taxable and each tax)', P(GR.totals.net.taxable) === P(GR.totals.invoices.taxable) - P(GR.totals.creditNotes.taxable) && P(GR.totals.net.cgst) === P(GR.totals.invoices.cgst) - P(cn.cgst)
  && GR.totals.net.igst === s2.items[0].igst);
check('the report\'s net GST equals the sales report\'s GST (one source)', P(GR.totals.net.tax) === P(S.gst) && P(GR.totals.net.taxable) === P(S.netSales));
check('B2B / B2C split (net of credit notes)', GR.b2b.count === 2 && GR.b2c.count === 1 && P(GR.b2b.taxable) + P(GR.b2c.taxable) === P(GR.totals.net.taxable));
check('rate-wise rows: 0 %, 5 %, 12 %', GR.rates.map((r) => r.rate).join() === '0,5,12' && P(GR.rates.reduce((a, r) => a + r.tax, 0)) === P(GR.totals.net.tax));
check('HSN summary with net quantities', GR.hsn.find((h) => h.hsn === '6109').q === 2 && GR.hsn.find((h) => h.hsn === '6505').q === 1);
check('B2C by place of supply and rate', GR.b2cByPlace.length === 1 && GR.b2cByPlace[0].pos === '27' && GR.b2cByPlace[0].rate === 0);
check('nil-rated supplies counted', GR.nilRated.lines === 1 && GR.nilRated.taxable === 300);
check('documents issued: first and last numbers', GR.docs.invoices.first === 'INV-1' && GR.docs.invoices.last === 'INV-4' && GR.docs.creditNotes.count === 1);
check('says it prepares data, never files', GR.disclaimer === DISCLAIMER && /does not file/.test(DISCLAIMER));
const bad = bill('9', [{ q: 1, price: 100, rate: 5, hsn: '' }], { cust: { id: 'c9', name: 'NoGST', type: 'business', gstin: '27BAD' } });
const GI = gstReport({ sales: [bad], returns: [], saleById: { 9: bad } });
check('checks before filing: a business without a valid GSTIN (reported as B2C) and a taxed line without HSN', GI.issues.some((x) => x.kind === 'gstin') && GI.issues.some((x) => x.kind === 'hsn') && GI.b2c.count === 1);
check('a month with nothing still makes a (zero) report', (() => { const z = gstReport({ sales: [], returns: [], saleById: {} }); return z.totals.net.tax === 0 && z.invoices.length === 0; })());

// ---------- CSV exports ----------
installFakeDom(); memStorage();
Object.assign(store, { prefs: {}, events: {}, customers: { c1: biz }, returnsMap: {}, moves: {}, remoteDays: {}, localDays: {}, _d: null, catalog: { version: 3, products: [] }, settings: { taxOn: true } });
const { gstCsvRows } = await import('../../src/features/reports/services/gst-data.js');
const rows = gstCsvRows(GR, { from: '2026-09-01', to: '2026-09-30', gstin: '27ABCDE1234F1Z5' });
const text = csvText(rows);
check('GST CSV: a section per return table, the disclaimer, and the shop GSTIN', ['SUMMARY', 'B2B INVOICES', 'B2C BY PLACE OF SUPPLY AND RATE', 'CREDIT NOTES (RETURNS)', 'HSN SUMMARY', 'RATE-WISE', 'DOCUMENTS ISSUED', 'CANCELLED INVOICES']
  .every((h) => text.includes(h)) && text.includes(DISCLAIMER) && text.includes('27ABCDE1234F1Z5'));
check('GST CSV: B2B invoice rows by rate with the customer GSTIN and place of supply', rows.some((r) => r[0] === 'INV-1' && r[3] === '27ABCDE1234F1Z5' && r[4] === '27-Maharashtra' && r[5] === 12));
check('GST CSV: credit note row names its invoice', rows.some((r) => r[0] === 'CN-r1' && r[2] === 'INV-1'));
check('GST CSV totals match the screen (net taxable)', rows.some((r) => r[0] === 'Net' && r[2] === GR.totals.net.taxable.toFixed(2)));
check('CSV quoting: commas, quotes and new lines', csvText([['a,b', 'say "hi"', 'x\ny', 5]]) === '"a,b","say ""hi""","x\ny",5');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
