// The owner's morning briefing (src/domain/reports/daily-briefing.js): yesterday against a usual weekday and why (Business
// today's explanation, for a whole day), the week, the best seller; products to act on; payments overdue; purchase orders
// expected; whether the money reconciled; and ONE thing to do first — the most pressing, in a fixed order (money that
// doesn't add up, lost sales, overdue payments, late deliveries, running out, a falling week, stock not selling). Nothing
// padded: empty parts are left out and a quiet day says so. Run: npm run test:unit
import { dailyBriefing } from '../../src/domain/reports/daily-briefing.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const day = (k, total, bills) => ({ k, total, bills, avgBill: bills ? total / bills : 0, pieces: bills * 2, gross: total, discounts: 0, returns: 0 });
const busy = {
  dayLabel: 'Monday, 5 October', weekday: 'Monday',
  yesterday: day('y', 6000, 6), weekdays: [day('a', 10000, 10), day('b', 10000, 10), day('c', 10000, 10), day('d', 10000, 10)], dayBefore: day('z', 9000, 9),
  products: [{ id: 'k', name: 'Kurta', today: 1000, usual: 5000 }], week: { total: 52000, prev: 70000 }, best: { id: 'd', name: 'Dupatta', q: 6, amount: 3000 },
  stock: { soldOut: [{ id: 'k', name: 'Kurta', sold: 12 }], runningOut: [{ id: 's', name: 'Saree', days: 2 }], rising: [{ id: 'c', name: 'Cap', trend: 80 }], expiring: [{ name: 'Ghee', batch: 'B7', days: 3 }], dead: { value: 40000, products: 4, days: 60 } },
  dues: { overdueDays: 7, open: [{ id: 'c1', name: 'Riya', amount: 4000, days: 40, no: 'INV-1' }, { id: 'c1', name: 'Riya', amount: 1000, days: 9, no: 'INV-5' }, { id: 'c2', name: 'Arun', amount: 500, days: 3, no: 'INV-9' }] },
  pos: [{ id: 'p1', no: 'PO-000003', supplier: 'Lakshmi Textiles', value: 18000, expected: '2 Oct', late: 3 }, { id: 'p2', no: 'PO-000004', supplier: 'Om Traders', value: 5000, expected: '', late: null }],
  recon: { close: { dayLabel: 'yesterday', expected: 12500, counted: 12000, diff: -500, matches: [] }, bills: [], upi: { count: 2, amount: 1500 }, unmatched: {} },
};
let B = dailyBriefing(busy);
check('titled with the day it is about', B.title === 'Your morning briefing · Monday, 5 October');
check('first: the money that doesn\'t add up (cash ₹500 short at yesterday\'s close), with the cash book', B.first.text === "Check the cash: it was ₹500 short at yesterday's close." && B.first.ref.target === 'cashbook' && !B.quiet, B.first);
const S = Object.fromEntries(B.sections.map((s) => [s.key, s.lines.map((l) => l.text)]));
check('yesterday: 40% below a usual Monday and why (fewer bills; Kurta selling less), the week down 26%, the best seller', /^Sales are 40% below a usual Monday: ₹6,000 against ₹10,000\.$/.test(S.yesterday[0]) && S.yesterday.some((t) => /^Fewer bills: 6 against 10 on a usual Monday\.$/.test(t))
  && S.yesterday.some((t) => /The last 7 days: ₹52,000, 26% down on the 7 days before/.test(t)) && S.yesterday.some((t) => /Best seller yesterday: Dupatta, 6 sold for ₹3,000/.test(t)), S.yesterday);
check('products: sold out but selling, running out, rising, expiring, money not selling', /Sold out but selling: Kurta \(12 sold this week\)/.test(S.products[0]) && /Running out: Saree \(about 2 days left\)/.test(S.products.join(' '))
  && /Demand rising: Cap \(up 80%\)/.test(S.products.join(' ')) && /Ghee batch B7 \(in 3 days\)/.test(S.products.join(' ')) && /₹40,000 is in 4 products with no sale for 60\+ days/.test(S.products.join(' ')), S.products);
check('payments overdue (more than 7 days): the total and each customer, oldest first — Arun (3 days) isn\'t overdue', /^₹5,000 owed for more than 7 days by 1 customer\.$/.test(S.dues[0]) && /^Riya: ₹5,000, the oldest 40 days ago\.$/.test(S.dues[1]) && !S.dues.some((t) => /Arun/.test(t)), S.dues);
check('purchase orders: the late one first, then one with no date', /^PO-000003 from Lakshmi Textiles \(₹18,000\): 3 days late \(was due 2 Oct\)\.$/.test(S.pos[0]) && /PO-000004 from Om Traders \(₹5,000\): no date given/.test(S.pos[1]), S.pos);
check('money: what to check before it reconciles (the close and two UPI payments)', /3 things to check before the money reconciles/.test(S.money[0]) && /₹500 short at yesterday's close/.test(S.money.join(' ')), S.money);
check('to share: the same, as text', B.text.startsWith('Your morning briefing · Monday, 5 October\n\nFirst: Check the cash') && B.text.includes('Payments overdue:\n• ₹5,000 owed'));

B = dailyBriefing({ ...busy, recon: { close: null, bills: [], upi: {}, unmatched: {} } });
check('cash fine: first comes the lost sales (Kurta sold out with 12 sold this week)', B.first.text === 'Reorder Kurta: sold out, and 12 sold in the last 7 days.' && B.first.ref.target === 'reorder', B.first);
B = dailyBriefing({ ...busy, recon: null, stock: { ...busy.stock, soldOut: [] } });
check('...then the overdue payment', B.first.text === 'Collect ₹5,000 from Riya: owed for 40 days.' && B.first.ref.id === 'c1', B.first);
B = dailyBriefing({ ...busy, recon: null, stock: { ...busy.stock, soldOut: [] }, dues: { overdueDays: 7, open: [] } });
check('...then the late delivery', B.first.text === 'Chase Lakshmi Textiles: PO-000003 is 3 days late.', B.first);
B = dailyBriefing({ ...busy, recon: null, stock: { runningOut: [], soldOut: [] }, dues: { overdueDays: 7, open: [] }, pos: [] });
check('...then a falling week', /^Sales are down 26% on the week before/.test(B.first.text), B.first);

const quiet = dailyBriefing({ dayLabel: 'Sunday, 4 October', weekday: 'Sunday', yesterday: day('y', 0, 0), weekdays: [], dayBefore: null, products: [], week: { total: 0, prev: 0 }, stock: {}, dues: { overdueDays: 7, open: [] }, pos: [],
  recon: { close: null, bills: [], upi: {}, unmatched: {} } });
check('a quiet day: says so, and nothing is padded (only yesterday and the money)', quiet.quiet && /^Nothing needs you first thing/.test(quiet.first.text) && quiet.sections.map((s) => s.key).join() === 'yesterday,money'
  && quiet.sections[0].lines[0].text === 'No bills yesterday.', quiet);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
