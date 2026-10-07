// Business today (src/domain/reports/business-today.js): what today is compared with (a usual weekday by this time, else
// last week's, else yesterday), and for each figure whether it is out of the ordinary and WHY — only from the figures it
// is handed (nothing guessed): fewer or smaller bills, products selling less, a quiet spell, one big bill, returns and
// cancelled bills; the average bill; the margin (discounts, sales below cost, the mix, missing cost prices); cash / UPI /
// card (the mix against the last 30 days); old dues; stock that isn't selling; and reconciliation (a cash close that
// didn't match and the entry of exactly that amount, bills whose receipts don't add up, UPI to verify, money not on a
// bill, money that lands in no bank account). Run: npm run test:unit
import { REF_LABELS, THRESHOLDS, businessToday, explainAverageBill, explainMargin, explainPayments, explainReceivables, explainReconciliation, explainSales, explainStock, pickComparison } from '../../src/domain/reports/business-today.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); } };
const day = (k, total, bills, extra = {}) => ({ k, total, bills, avgBill: bills ? total / bills : 0, pieces: bills * 2, discounts: 0, ...extra });
const texts = (f) => f.reasons.map((r) => r.text).join(' | ');

console.log('--- the comparison ---');
let C = pickComparison({ weekday: 'Tuesday', weekdays: [day('w1', 6000, 10), day('w2', 0, 0), day('w3', 5000, 8), day('w4', 7000, 12)], yesterday: day('y', 900, 2) });
check('a usual Tuesday: the weekdays with sales (three of four), averaged', C.kind === 'usual' && C.days === 3 && C.total === 6000 && C.bills === 10 && C.label === 'a usual Tuesday by this time' && C.when === 'on a usual Tuesday' && C.short === 'usually', C);
check('...the average bill is weighted by bills (sales ÷ bills over the days), and the days used are named', C.avgBill === 600 && JSON.stringify(C.dayKeys) === '["w1","w3","w4"]', C);
C = pickComparison({ weekday: 'Tuesday', weekdays: [day('w1', 4000, 5), day('w2', 0, 0), day('w3', 0, 0), day('w4', 0, 0)], yesterday: day('y', 900, 2) });
check('only last Tuesday had sales: last Tuesday by this time', C.kind === 'lastweek' && C.label === 'last Tuesday by this time' && C.total === 4000, C);
C = pickComparison({ weekday: 'Tuesday', weekdays: [day('w1', 0, 0), day('w2', 0, 0), day('w3', 0, 0), day('w4', 0, 0)], yesterday: day('y', 900, 2) });
check('no Tuesdays: yesterday by this time', C.kind === 'yesterday' && C.label === 'yesterday by this time' && C.total === 900, C);
check('a new shop: nothing to compare with (null), never an invented baseline', pickComparison({ weekday: 'Tuesday', weekdays: [], yesterday: day('y', 0, 0) }) === null);

console.log('--- sales ---');
const usual = pickComparison({ weekday: 'Tuesday', weekdays: [day('w1', 10000, 10), day('w2', 10000, 10), day('w3', 10000, 10), day('w4', 10000, 10)] });
let S = explainSales({ today: { total: 0, bills: 0, avgBill: 0, pieces: 0, gross: 0, returns: 0 }, comparison: null });
check('no comparison, no bills: "no bills yet", nothing unusual', S.sub === 'no bills yet' && !S.unusual && S.headline === 'No bills yet today.', S);
S = explainSales({ today: { total: 5000, bills: 3, avgBill: 1666.67, pieces: 6, gross: 5000, returns: 0 }, comparison: null });
check('...with bills: "after returns" and an honest headline', S.sub === 'after returns' && /no earlier day to compare with/.test(S.headline), S);
S = explainSales({ today: { total: 4000, bills: 5, avgBill: 800, pieces: 8, gross: 4000, returns: 0 }, comparison: usual,
  products: [{ id: 'k', name: 'Kurta', today: 500, usual: 4000 }, { id: 'd', name: 'Dupatta', today: 1000, usual: 1200 }, { id: 'b', name: 'Belt', today: 2500, usual: 1000 }],
  lastBill: { t: 0, time: '1:10 pm' }, minutesSinceLastBill: 150, usualBillsSince: 3 });
check('60% below a usual Tuesday: unusual, down, in words with both figures', S.unusual && S.tone === 'down' && S.change === -60 && S.sub === '▼ 60% vs usual'
  && S.headline === 'Sales are 60% below a usual Tuesday by this time: ₹4,000 against ₹10,000.', S);
check('...why: a quiet spell first (no bill since 1:10 pm, 3 usually by now)', S.reasons[0].id === 'quiet' && /No bill since 1:10 pm; on a usual Tuesday about 3 bills come in/.test(S.reasons[0].text), texts(S));
check('...fewer bills (5 against 10) and the products selling less (Kurta), not the one selling more', /Fewer bills: 5 so far against 10 on a usual Tuesday/.test(texts(S)) && /Selling less than on a usual Tuesday: Kurta ₹500 against ₹4,000/.test(texts(S)) && !/Belt/.test(texts(S)), texts(S));
check('...each reason says where to look (the product)', S.reasons.find((r) => r.id === 'products').ref.target === 'product' && S.reasons.find((r) => r.id === 'products').ref.id === 'k');
S = explainSales({ today: { total: 25000, bills: 12, avgBill: 2083, pieces: 20, gross: 25000, returns: 0 }, comparison: usual, biggest: { id: 's9', no: 'INV-000127', total: 12000, customer: 'Riya' } });
check('150% above: unusual and up; one big bill explains it (with the bill to open)', S.unusual && S.tone === 'up' && S.reasons[0].id === 'big' && /One bill is 48% of today: INV-000127, ₹12,000 to Riya/.test(S.reasons[0].text) && S.reasons[0].ref.id === 's9', texts(S));
S = explainSales({ today: { total: 7000, bills: 10, avgBill: 900, pieces: 20, gross: 9000, returns: 2000, returnCount: 2 }, comparison: usual, cancelled: { count: 1, value: 1500 } });
check('returns and a cancelled bill are named when they take a real share', /₹2,000 came back in 2 returns today/.test(texts(S)) && /1 bill cancelled today \(₹1,500\) isn't counted/.test(texts(S)), texts(S));
const thin = pickComparison({ weekday: 'Tuesday', weekdays: [day('w1', 1000, 1), day('w2', 1000, 1)] });
S = explainSales({ today: { total: 3000, bills: 2, avgBill: 1500, pieces: 2, gross: 3000, returns: 0 }, comparison: thin });
check('a comparison with too few bills (1): not called unusual, and it says why', !S.unusual && /only 1 bill to compare with/.test(S.headline), S.headline);
S = explainSales({ today: { total: 10500, bills: 10, avgBill: 1050, pieces: 20, gross: 10500, returns: 0 }, comparison: usual });
check('within ' + THRESHOLDS.sales + '%: in line, nothing marked', !S.unusual && /in line with a usual Tuesday/.test(S.headline));

console.log('--- the average bill ---');
let A = explainAverageBill({ today: { total: 20000, bills: 8, avgBill: 2500, pieces: 9, discounts: 0 }, comparison: usual, biggest: { id: 's1', no: 'INV-9', total: 9000 } });
check('₹2,500 against ₹1,000: unusual, higher; the sub says the usual', A.unusual && A.tone === 'up' && A.sub === '₹1,000 usually' && /150% higher/.test(A.headline), A);
check('...one bill lifts the average (and without it the average is said)', /INV-9 at ₹9,000 lifts the average; without it the average bill is ₹1,571/.test(texts(A)), texts(A));
A = explainAverageBill({ today: { total: 3000, bills: 6, avgBill: 500, pieces: 6, discounts: 900 }, comparison: { ...usual, discounts: 100 } });
check('smaller bills: fewer pieces a bill and more off each bill', A.unusual && A.tone === 'down' && /1 piece a bill against 2/.test(texts(A)) && /₹150 off each bill on average against ₹10/.test(texts(A)), texts(A));

console.log('--- the margin ---');
const prof = (net, cov, cogs, extra = {}) => ({ netSales: net, covered: cov, cogs, grossProfit: cov - cogs, margin: cov ? Math.round((cov - cogs) / cov * 1000) / 10 : null, coverage: net ? cov / net : 0, complete: net === cov, ...extra });
let M = explainMargin({ today: prof(10000, 6000, 3000), usual: prof(100000, 100000, 60000), products: [{ id: 'b', name: 'Belt', rev: 4000, cost: null, q: 2 }] });
check('cost prices on only 60% of the sales: no profit figure (no guess), and which products lack one', M.value === null && M.tone === 'muted' && M.sub === 'cost prices missing on 40% of sales' && /No cost price: Belt \(₹4,000 of sales\)/.test(texts(M)), M);
M = explainMargin({ today: prof(10000, 10000, 8000), usual: prof(100000, 100000, 60000), bills: 6, discounts: { today: 1200, todayGross: 11000, usual: 2000, usualGross: 110000 },
  products: [{ id: 'r', name: 'Rice', rev: 7000, cost: 6500, q: 10 }, { id: 'c', name: 'Cable', rev: 1000, cost: 1200, q: 1 }, { id: 'k', name: 'Kurta', rev: 2000, cost: 300, q: 1 }] });
check('20% today against 40% over 30 days: unusual, down; the sub keeps "20% margin"', M.unusual && M.tone === 'down' && M.change === -20 && M.sub === '20% margin' && /20% today against 40% over the last 30 days/.test(M.headline), M);
check('...why: sold below cost (Cable), discounts 10.9% against 1.8%, and the mix (Rice, 70% of sales at 7.1%)', /Sold below cost: Cable \(₹1,000 for what cost ₹1,200\)/.test(texts(M)) && /Discounts were 10.9% of sales today \(₹1,200\) against 1.8%/.test(texts(M)) && /Rice was 70% of today's sales at a 7.1% margin/.test(texts(M)), texts(M));
M = explainMargin({ today: prof(10000, 10000, 6000), usual: null, products: [] });
check('no earlier sales to compare: the margin, nothing marked', !M.unusual && M.sub === '40% margin' && /40% margin/.test(M.headline));

console.log('--- cash, UPI and card ---');
let P = explainPayments({ today: { cash: 9000, upi: 500, card: 500 }, usual: { cash: 40000, upi: 50000, card: 10000, bills: 120 }, bills: 12, count: { cash: 10, upi: 1, card: 1 },
  drawer: { opening: 2000, closing: 10500, in: 9000, out: 500 }, unverified: { count: 1, amount: 500 }, refunds: { cash: 300 } });
const [cash, upi] = P;
check('three figures, cash / UPI / card, each its share of the money taken', P.map((x) => x.key).join() === 'cash,upi,card' && cash.sub === '90% of money taken · usually 40%' && upi.sub === '5% of money taken', P.map((x) => x.sub));
check('cash 90% against 40%: the method that moved is unusual, with what to check (UPI recorded as cash?)', cash.unusual && !upi.unusual && /Cash was 90% of the money taken today against 40%/.test(cash.headline) && /recorded as UPI or card, not cash/.test(cash.check), cash);
check('...the drawer now and cash refunds; UPI still checked by hand on UPI', /The drawer should hold ₹10,500 now: ₹2,000 at the start of the day, ₹9,000 in, ₹500 out/.test(texts(cash)) && /₹300 paid back by cash/.test(texts(cash)) && /1 UPI payment today \(₹500\) checked only by hand/.test(texts(upi)), [texts(cash), texts(upi)]);
P = explainPayments({ today: { cash: 9000, upi: 500, card: 500 }, usual: { cash: 4000, upi: 5000, card: 1000, bills: 12 }, bills: 12 });
check('fewer than 20 bills in the last 30 days: no mix judged', P.every((x) => !x.unusual));

console.log('--- what customers owe ---');
let R = explainReceivables({ total: 9000, customers: 3, rows: [{ id: 'c1', name: 'Riya', amount: 6000 }, { id: 'c2', name: 'Arun', amount: 2000 }, { id: 'c3', name: 'Mo', amount: 1000 }],
  open: [{ saleId: 's1', no: 'INV-1', id: 'c1', name: 'Riya', amount: 4000, days: 40 }, { saleId: 's2', no: 'INV-2', id: 'c2', name: 'Arun', amount: 2000, days: 9 }, { saleId: 's3', no: 'INV-3', id: 'c1', name: 'Riya', amount: 2000, days: 1 }],
  addedToday: { amount: 2000, bills: 1 }, collectedToday: { amount: 500, count: 1 }, overdueDays: 7 });
check('owed more than 7 days (the reminder setting): unusual, how much and on how many bills', R.unusual && R.tone === 'warn' && R.sub === '₹6,000 over 7 days' && /₹6,000 has been owed for more than 7 days, on 2 bills/.test(R.headline), R);
check('...the oldest (with the account to open), who owes most, and today\'s change', /Oldest: Riya — ₹4,000 on INV-1 from 40 days ago/.test(texts(R)) && R.reasons[0].ref.target === 'customer' && /Riya owes ₹6,000, 67% of the total/.test(texts(R)) && /Today: ₹2,000 added on 1 bill sold on account; ₹500 collected/.test(texts(R)), texts(R));
check('nothing owed: said plainly', /No customer owes/.test(explainReceivables({ total: 0, customers: 0, rows: [], open: [] }).headline));

console.log('--- stock ---');
let K = explainStock({ value: 100000, cost: 55000, coverage: 0.9, dead: { value: 40000, products: 4, days: 60, top: [{ id: 'a', name: 'Coat', value: 20000 }, { id: 'b', name: 'Shawl', value: 12000 }] }, today: { received: 8000, sold: 3000 } });
check('valued at cost (cost known on 90%), and 40% not selling for 60 days: unusual', K.value === 55000 && K.sub === 'at cost · cost known on 90%' && K.unusual && /₹40,000 of stock \(40% of it, at selling price\) hasn't sold for 60 days/.test(K.headline), K);
check('...which products, today\'s stock in and out at cost, and the cost prices missing', /Not selling: Coat \(₹20,000\), Shawl \(₹12,000\) and 1 more/.test(texts(K)) && /Today: ₹8,000 of stock received at cost; ₹3,000 sold at cost/.test(texts(K)) && /missing on 10% of the stock/.test(texts(K)), texts(K));
K = explainStock({ value: 50000, cost: 10000, coverage: 0.3, dead: { value: 0 }, today: {} });
check('cost known on too little of it: shown at selling price, and said so', K.value === 50000 && K.sub === 'at selling price · cost known on 30%' && !K.unusual, K);

console.log('--- reconciliation ---');
let X = explainReconciliation({ close: { dayLabel: 'yesterday', expected: 12500, counted: 12000, diff: -500, changed: false, expectedNow: 12500, matches: [{ kind: 'cash_sale', saleId: 's7', no: 'INV-7', time: '4:12 pm', method: 'cash' }] },
  bills: [{ id: 's8', no: 'INV-8', due: 1000, received: 900 }], billCount: 1, upi: { count: 2, amount: 1500 }, unmatched: { loaded: true, count: 1, amount: 450, first: { amount: 400, paidAmount: 450 } }, landing: { upi: true } });
check('cash ₹500 short at yesterday\'s close: bad, with counted and expected', X.unusual && X.tone === 'bad' && /Cash was ₹500 short at yesterday's close: counted ₹12,000, the books expected ₹12,500/.test(texts(X)), texts(X));
check('...₹500 is exactly the cash on INV-7: was it collected, or paid by UPI or card? (opens the bill)', /₹500 is exactly the cash on INV-7 \(4:12 pm\): check it was collected, or whether it was paid by UPI or card/.test(texts(X)) && X.reasons[1].ref.target === 'bill' && X.reasons[1].ref.id === 's7', texts(X));
check('...a bill whose receipts don\'t add up, UPI to verify, a payment on no bill (paid ₹450 where ₹400 was asked), UPI landing nowhere',
  /1 bill where what was received doesn't match what was due: INV-8 \(₹1,000 due, ₹900 received\)/.test(texts(X)) && /2 UPI payments \(₹1,500\) checked only by hand/.test(texts(X)) && /₹450 paid where ₹400 was asked/.test(texts(X)) && /UPI money isn't linked to a bank account/.test(texts(X)), texts(X));
check('...counted: 5 things to check, the amounts involved', X.count === 5 && X.display === '5 to check' && X.sub === '₹2,550 involved', X);
X = explainReconciliation({ close: { dayLabel: 'today', expected: 3000, counted: 3200, diff: 200, changed: true, expectedNow: 3400, matches: [] }, bills: [], upi: {}, unmatched: { loaded: false } });
check('₹200 over with no entry of that amount: says where to look; entries added after the close: close again', /No single bill or entry that day is exactly ₹200: look for cash taken in without an entry/.test(texts(X)) && /should now hold ₹3,400, not ₹3,000. Close the day again/.test(texts(X)), texts(X));
X = explainReconciliation({ close: null, bills: [], upi: { count: 0 }, unmatched: { loaded: true, count: 0 }, landing: {} });
check('all matched: "All matched", ok, not unusual', X.display === 'All matched' && X.tone === 'ok' && !X.unusual && X.count === 0 && /reconcile/.test(X.headline), X);

console.log('--- together ---');
const facts = { comparison: usual, today: { total: 4000, bills: 5, avgBill: 800, pieces: 8, gross: 4000, returns: 0 }, products: [],
  profit: { today: prof(4000, 4000, 2400), usual: prof(100000, 100000, 60000), products: [] },
  payments: { today: { cash: 4000, upi: 0, card: 0 }, usual: { cash: 1, upi: 1, card: 1, bills: 1 } },
  dues: { total: 0, customers: 0, rows: [], open: [] }, stock: { value: 1000, cost: 500, coverage: 1, dead: { value: 0 }, today: {} },
  recon: { close: { dayLabel: 'today', expected: 4000, counted: 3500, diff: -500, matches: [] }, bills: [], upi: {}, unmatched: {} } };
let V = businessToday(facts, { profit: true, money: true, position: true });
check('the owner\'s figures, in the card\'s order', V.figures.map((x) => x.key).join() === 'sales,bills,avgBill,profit,cash,upi,card,receivables,stock,reconciliation', V.figures.map((x) => x.key));
check('unusual ones worst first: reconciliation (bad), then sales', V.unusual.join() === 'reconciliation,sales', V.unusual);
check('one summary sentence naming them', /^2 things out of the ordinary today: 1 thing to check before the money reconciles; Sales are 60% below/.test(V.summary), V.summary);
V = businessToday(facts, {});
check('someone who doesn\'t see reports: sales, bills, average bill only', V.figures.map((x) => x.key).join() === 'sales,bills,avgBill', V.figures.map((x) => x.key));
V = businessToday(facts, { profit: true, position: true });
check('a manager (no money split): no cash / UPI / card or reconciliation', !V.figures.some((x) => ['cash', 'upi', 'card', 'reconciliation'].includes(x.key)) && V.figures.some((x) => x.key === 'stock'));
check('every ref a reason may carry has words for its button', ['bill', 'customer', 'product', 'report', 'reconcile', 'reorder', 'cashbook', 'bankbook', 'customers', 'bills', 'banks'].every((k) => REF_LABELS[k]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
