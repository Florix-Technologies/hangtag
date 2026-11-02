// Customer intelligence (src/domain/customers/customer-insight.js): what a customer's own bills say — the summary, what
// they buy most, how they pay (and how long they take to pay what they take on account), and plain observations only when
// there is enough history: how often they come (and whether it's been longer than usual), favourites, the usual size, what
// they buy together, returns, an old due against their usual time to pay, where they stand. Run: npm run test:unit
import { customerInsight, daysToPay } from '../../src/domain/customers/customer-insight.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); } };
const DAY = 864e5, NOW = Date.UTC(2026, 9, 7, 6, 0);
const at = (daysAgo) => NOW - daysAgo * DAY;
const K = (q, size) => ({ pid: 'k', name: 'Kurta', size: size || 'M', q, amt: q * 1000 });
const D = (q) => ({ pid: 'd', name: 'Dupatta', size: '', q, amt: q * 500 });
const bill = (id, daysAgo, lines, pay, due = 0) => ({ id, no: 'INV-' + id, t: at(daysAgo), total: lines.reduce((a, l) => a + l.amt, 0), lines, payments: pay, due });
const texts = (x) => x.insights.map((i) => i.id + ': ' + i.text).join(' | ');

console.log('--- paying off what was taken on account ---');
const P = daysToPay([{ t: at(40), charge: 1000, credit: 0 }, { t: at(36), charge: 0, credit: 1000 }, { t: at(20), charge: 500, credit: 0 }, { t: at(10), charge: 0, credit: 200 }]);
check('a due paid 4 days later; one still partly open (₹300 from 20 days ago)', P.paid.length === 1 && Math.round(P.paid[0]) === 4 && P.open.length === 1 && P.open[0].amount === 300 && P.open[0].t === at(20), P);

console.log('--- a regular customer ---');
const bills = [
  bill('1', 70, [K(2), D(1)], [{ method: 'cash', amount: 2500 }]),
  bill('2', 56, [K(2, 'M'), D(1)], [{ method: 'upi', amount: 2500 }]),
  bill('3', 42, [K(1, 'L')], [{ method: 'cash', amount: 1000 }]),
  bill('4', 28, [K(2)], [{ method: 'cash', amount: 1000 }], 1000),
  bill('5', 14, [K(1), D(2)], [{ method: 'card', amount: 2000 }]),
];
const account = { purchases: 9000, paid: 8000, outstanding: 1000, entries: [{ t: at(28), charge: 1000, credit: 0 }].reverse() };
let X = customerInsight({ bills, returns: [], account, peers: [100, 200, 300, 500, 800, 900, 1000, 1200, 1500, 2000, 3000], now: NOW });
check('summary: ₹10,000 over 5 bills (₹2,000 a bill), owes ₹1,000 from 28 days ago, last 14 days ago', X.summary.purchases === 10000 && X.summary.bills === 5 && X.summary.avgBill === 2000 && X.summary.outstanding === 1000
  && X.summary.oldestDueDays === 28 && X.summary.daysSinceLast === 14, X.summary);
check('buys most: Kurta (8 on 5 bills), then Dupatta (4 on 3 bills)', X.products[0].name === 'Kurta' && X.products[0].q === 8 && X.products[0].bills === 5 && X.products[1].name === 'Dupatta' && X.products[1].bills === 3, X.products);
check('how they pay: cash first, with shares, and what was taken on account', X.payments.methods[0].key === 'cash' && X.payments.methods.some((m) => m.key === 'due' && m.amount === 1000) && X.payments.onAccount.bills === 1, X.payments);
check('comes about every 14 days (last visit 14 days ago)', /rhythm: Comes about every 14 days \(last visit 14 days ago\)/.test(texts(X)), texts(X));
check('buys Kurta on most visits (5 of 5 bills), usually 2 at a time', /favourite: Buys Kurta on most visits \(5 of 5 bills\), usually 2 at a time/.test(texts(X)), texts(X));
check('usually takes size M (7 of 8 pieces)', /size: Usually takes size M \(7 of 8 pieces\)/.test(texts(X)), texts(X));
check('often buys Kurta with Dupatta (3 bills)', /together: Often buys Kurta with Dupatta \(3 bills\)/.test(texts(X)), texts(X));
check('owes ₹1,000, the oldest part from 28 days ago (no pay-back history yet to compare)', /due: Owes ₹1,000, the oldest part from 28 days ago\./.test(texts(X)), texts(X));
check('among the top 5% of customers by purchases (₹10,000, more than all the others)', /standing: Among your top 5% of customers/.test(texts(X)), texts(X));
check('serve and money observations are told apart', X.insights.filter((i) => i.kind === 'serve').map((i) => i.id).join() === 'rhythm,favourite,size,together' && X.insights.filter((i) => i.kind === 'money').map((i) => i.id).join() === 'due,standing');

console.log('--- longer than usual, returns, slow to pay ---');
X = customerInsight({ bills, returns: [{ t: at(13), saleId: '5', pieces: 3, value: 2000, lines: [{ pid: 'k', name: 'Kurta', q: 1, amt: 1000 }, { pid: 'd', name: 'Dupatta', q: 2, amt: 1000 }] }],
  account: { purchases: 9000, paid: 8000, outstanding: 1000, entries: [{ t: at(60), charge: 500, credit: 0 }, { t: at(58), charge: 0, credit: 500 }, { t: at(50), charge: 500, credit: 0 }, { t: at(48), charge: 0, credit: 500 }, { t: at(45), charge: 1000, credit: 0 }].reverse() },
  now: NOW + 40 * DAY });
check('54 days since the last visit against every 14: longer than usual', /rhythm: Usually comes about every 14 days; the last visit was 54 days ago — longer than usual\./.test(texts(X)), texts(X));
check('returned 3 of 12 pieces (25%), most recently Kurta; the summary nets it out', /returns: Returned 3 of 12 pieces bought \(25%\), most recently Kurta/.test(texts(X)) && X.summary.returned === 2000 && X.summary.net === 8000, texts(X));
check('owes from 85 days ago — longer than the 2 days they usually take to pay', /due: Owes ₹1,000, the oldest part from 85 days ago — longer than the 2 days they usually take to pay\./.test(texts(X)), texts(X));
check('Dupatta, all of it returned except 2: still listed with the net quantity', X.products.find((p) => p.name === 'Dupatta').q === 2, X.products);

console.log('--- too little history says little ---');
X = customerInsight({ bills: [bill('9', 3, [K(1)], [{ method: 'cash', amount: 1000 }])], account: { purchases: 1000, paid: 1000, outstanding: 0, entries: [] }, peers: [1, 2, 3], now: NOW });
check('one bill: the summary and what they bought, no observations invented', X.summary.bills === 1 && X.products.length === 1 && X.insights.length === 0, X.insights);
X = customerInsight({ now: NOW });
check('no bills: an empty, honest summary', X.summary.bills === 0 && X.summary.last === 0 && X.summary.daysSinceLast === null && !X.products.length && !X.insights.length);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
