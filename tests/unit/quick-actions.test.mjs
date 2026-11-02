// Smart quick actions (src/domain/shop/quick-actions.js): the New sheet's order — the workspace's own actions first, then
// what this person starts most on this device (recent use counts more: half after two weeks), then the role's usual
// order; nothing "suggested" when neither applies; the use record stays small. Run: npm run test:unit
import { ROLE_QUICK, noteQuickUse, rankQuickActions, useScore } from '../../src/domain/shop/quick-actions.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const DAY = 864e5, now = Date.UTC(2026, 9, 7, 6);
const AREA = { sale: 'sell', stock: 'stock', purchase: 'stock', po: 'stock', product: 'products', customer: 'customers', quote: 'orders', order: 'orders', expense: 'report', cash: 'report', bank: 'report', voucher: 'sell' };
const all = Object.keys(AREA).reverse().map((id) => ({ id, area: AREA[id] }));   // offered in any order
const ids = (l) => l.map((a) => a.id).join();

let R = rankQuickActions(all, { role: 'owner', now });
check('no page context, no use yet: nothing suggested, the owner\'s usual order', R.suggested.length === 0 && ids(R.list) === ROLE_QUICK.owner.join(), ids(R.list));
R = rankQuickActions(all, { role: 'cashier', now });
check('a cashier\'s order starts with a sale; what isn\'t in the role\'s order comes last', R.list[0].id === 'sale' && R.list[1].id === 'customer'
  && ids(R.list.slice(-5)) === 'stock,purchase,product,po,bank', ids(R.list));
R = rankQuickActions(all, { role: 'manager', area: 'stock', now });
check('on Stock: receive stock, a supplier bill, a purchase order suggested ("for this page")', ids(R.suggested) === 'stock,purchase,po' && R.suggested.every((a) => a.why === 'here')
  && !R.rest.some((a) => a.area === 'stock') && R.list.length === all.length, R.suggested);

let use = {};
use = noteQuickUse(use, 'expense', now - 3 * DAY); use = noteQuickUse(use, 'expense', now - DAY);
check('use counts add up and age: two starts this week ≈ 1.8', Math.abs(useScore(use.expense, now) - (Math.pow(0.5, 2 / 14) + 1) * Math.pow(0.5, 1 / 14)) < 0.01, use.expense);
R = rankQuickActions(all, { role: 'owner', area: 'stock', usage: use, now });
check('…then what is started often, after the page\'s own', ids(R.suggested) === 'stock,purchase,po,expense' && R.suggested[3].why === 'often', R.suggested);
R = rankQuickActions(all, { role: 'owner', area: 'stock', usage: use, now, suggest: 3 });
check('at most the few asked for', ids(R.suggested) === 'stock,purchase,po' && R.rest.some((a) => a.id === 'expense'));
const old = { quote: { n: 4, t: now - 28 * DAY }, order: { n: 4, t: now - 14 * DAY }, po: { n: 1, t: now } };
R = rankQuickActions(all, { role: 'owner', usage: old, now });
check('four starts a month ago no longer count (1); four a fortnight ago still do (2); one start today isn\'t "often"', ids(R.suggested) === 'order' && R.suggested[0].why === 'often',
  [useScore(old.quote, now), useScore(old.order, now), ids(R.suggested)]);
const busy = { cash: { n: 4, t: now - DAY }, bank: { n: 4, t: now - DAY } };
R = rankQuickActions(all, { role: 'owner', usage: busy, now });
check('equal use: the role\'s order breaks the tie', ids(R.suggested) === 'cash,bank', ids(R.suggested));
R = rankQuickActions(all.filter((a) => a.id !== 'bank'), { role: 'owner', usage: busy, now });
check('only what was offered is ranked (no bank entry without a bank)', !R.list.some((a) => a.id === 'bank') && ids(R.suggested) === 'cash');
check('an unknown role ranks as the owner', ids(rankQuickActions(all, { role: 'auditor', now }).list) === ROLE_QUICK.owner.join());

let many = {};
for (let i = 0; i < 25; i++) many = noteQuickUse(many, 'a' + i, now - (25 - i) * 1000);
check('the use record keeps the 20 most recent', Object.keys(many).length === 20 && !many.a0 && !!many.a24);
check('nothing breaks on no record', useScore(undefined, now) === 0 && useScore({ n: 0, t: now }, now) === 0 && Object.keys(noteQuickUse(null, 'sale', now)).join() === 'sale');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
