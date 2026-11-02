// The purchase plan within a budget (src/domain/inventory/purchase-plan.js): what runs out first before the better
// margin, a line in part when only some of it fits, the rest waiting, and lines without a cost price listed apart
// (never guessed). Run: npm run test:unit
import { planBySupplier, purchasePlan } from '../../src/domain/inventory/purchase-plan.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); } };
const L = (name, q, price, days, sell, supplierId = 's1', u) => ({ v: name, p: name, name, vl: '', q, price, days, sell, supplierId, supplier: supplierId ? 'Supplier ' + supplierId : '', ...(u ? { u } : {}) });
const lines = [L('B', 2, 300, 5, 330, 's2'), L('A', 4, 100, 0, 200), L('C', 10, 50, 2, 150), L('D', 3, null, 1, 90), L('E', 1, 1000, null, 1500, null)];

let p = purchasePlan(lines);
check('no budget: every priced line, sold out first, then the fewest days left; no budget left shown', p.lines.map((l) => l.name).join() === 'A,C,B,E' && p.total === 2500 && p.budget === null && p.left === null);
check('...a line without a cost price is listed apart, never priced', p.unknownCost.map((l) => l.name).join() === 'D' && !p.lines.some((l) => l.name === 'D'));
p = purchasePlan(lines, 1000);
check('₹1,000: A (₹400) and C (₹500) fit; B and E wait', p.lines.map((l) => `${l.name}×${l.q}=${l.cost}`).join() === 'A×4=400,C×10=500' && p.total === 900 && p.left === 100 && p.skipped.map((l) => l.name).join() === 'B,E', p);
p = purchasePlan(lines, 650);
check('₹650: A whole, then 5 of the 10 C that the rest buys (marked partial)', p.lines.map((l) => `${l.name}×${l.q}`).join() === 'A×4,C×5' && p.lines[1].partial && p.lines[1].wanted === 10 && p.lines[1].cost === 250 && p.left === 0, p);
p = purchasePlan([L('X', 1, 100, 3, 110), L('Y', 1, 100, 3, 200)], 100);
check('the same urgency: the better margin for each rupee first', p.lines.map((l) => l.name).join() === 'Y' && p.skipped.map((l) => l.name).join() === 'X');
p = purchasePlan([L('Rice', 2.5, 120, 1, 150, 's1', 'kg')], 150);
check('sold by the kg: part of a kg when only that fits', p.lines[0].q === 1.25 && p.lines[0].cost === 150 && p.lines[0].partial, p.lines[0]);
p = purchasePlan(lines, 40);
check('a budget too small for anything: nothing planned, everything waits', p.lines.length === 0 && p.total === 0 && p.skipped.length === 4);
const g = planBySupplier(purchasePlan(lines));
check('by supplier: one group each, those with a supplier first, totals added', g.map((x) => x.supplierId).join() === 's1,s2,' && g[0].total === 900 && g[2].supplierId === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
