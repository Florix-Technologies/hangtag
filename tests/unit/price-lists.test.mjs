// Price lists: the one resolver (customer list → chosen list → default → the item's own price), never ₹0, per-variant
// prices over product prices, lists in use only between their days, validation, and that a saved bill keeps its prices.
import { activeList, checkPriceList, choosableLists, listLive, normalizeList, resolvePrice, setListPrice, withDefault } from '../../src/domain/sales/pricing.js';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if(ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };

const retail = normalizeList({ id: 'r', name: 'Retail', isDefault: true, prices: { 'p:shirt': 900 } });
const whole = normalizeList({ id: 'w', name: 'Wholesale', prices: { 'p:shirt': 700, 'v:shirt-xl': 750 } });
const vip = normalizeList({ id: 'x', name: 'Special', prices: { 'v:shirt-m': 650 }, from: '2026-01-01', to: '2026-12-31' });
const lists = [retail, whole, vip];
const ctx = o => ({ lists, day: '2026-10-03', ...o });

let r = resolvePrice('shirt', 'shirt-m', 1000, ctx({}));
check('no customer, nothing chosen: the default list', r.price === 900 && r.source === 'default' && r.listId === 'r', r);
r = resolvePrice('shirt', 'shirt-m', 1000, ctx({ selectedListId: 'w' }));
check('a list chosen on the bill wins over the default', r.price === 700 && r.source === 'selected', r);
r = resolvePrice('shirt', 'shirt-xl', 1000, ctx({ selectedListId: 'w' }));
check('a variant price on the list wins over its product price', r.price === 750, r);
r = resolvePrice('shirt', 'shirt-m', 1000, ctx({ customerListId: 'x', selectedListId: 'w' }));
check('the customer\'s own list comes first', r.price === 650 && r.source === 'customer' && r.listName === 'Special', r);
r = resolvePrice('shirt', 'shirt-s', 1000, ctx({ customerListId: 'x', selectedListId: 'w' }));
check('a list without a price for the item falls through to the next one (never ₹0)', r.price === 700 && r.source === 'selected', r);
r = resolvePrice('jeans', 'jeans-32', 1500, ctx({ selectedListId: 'w' }));
check('an item on no list keeps its own price', r.price === 1500 && r.source === 'product' && r.listId === null, r);
r = resolvePrice('shirt', 'shirt-m', 1000, ctx({ customerListId: 'x', day: '2027-02-01' }));
check('a list outside its days is not used', r.source === 'default' && r.price === 900, r);
r = resolvePrice('shirt', 'shirt-m', 1000, { lists: [{ ...whole, active: false }, retail], selectedListId: 'w', day: '2026-10-03' });
check('a list switched off is not used', r.source === 'default');
r = resolvePrice('shirt', 'shirt-m', 1000, { lists: [normalizeList({ id: 'z', name: 'Zero', prices: { 'p:shirt': 0, 'v:shirt-m': -5 } })], selectedListId: 'z', day: '2026-10-03' });
check('a zero or negative stored price is dropped, never resolved', r.price === 1000 && r.source === 'product', r);
r = resolvePrice('shirt', 'shirt-m', 1000, { lists: [whole], selectedListId: 'gone-list', customerListId: 'other-shop-list', day: '2026-10-03' });
check('an unknown list id (another shop\'s, or removed) is ignored', r.source === 'product' && r.price === 1000, r);

check('the till shows the customer\'s list, locked', (() => { const a = activeList(ctx({ customerListId: 'w', selectedListId: 'r' })); return a.locked && a.list.id === 'w'; })());
check('…otherwise the chosen list, else the default', activeList(ctx({ selectedListId: 'w' })).list.id === 'w' && activeList(ctx({})).list.id === 'r' && !activeList(ctx({})).locked);
check('choosable lists: in use today, the default first', JSON.stringify(choosableLists(lists, '2026-10-03').map(l => l.id)) === '["r","x","w"]' && choosableLists(lists, '2027-01-01').every(l => l.id !== 'x'));
check('list days', listLive(vip, '2026-06-01') && !listLive(vip, '2025-12-31') && listLive(retail, ''));

check('checks: a name is needed, unique in the shop', checkPriceList({ name: '' }, lists).field === 'name' && checkPriceList({ id: 'n', name: 'wholesale' }, lists).field === 'name'
  && checkPriceList({ id: 'w', name: 'Wholesale', prices: {} }, lists) === null);
check('checks: prices above ₹0 with at most 2 decimals', checkPriceList({ name: 'A', prices: { 'p:x': 0 } }, []).field === 'prices'
  && checkPriceList({ name: 'A', prices: { 'p:x': 10.005 } }, []).field === 'prices' && checkPriceList({ name: 'A', prices: { 'q:x': 10 } }, []).field === 'prices');
check('checks: the last day is not before the first; the default must be in use', checkPriceList({ name: 'A', from: '2026-02-01', to: '2026-01-01' }, []).field === 'to'
  && checkPriceList({ name: 'A', isDefault: true, active: false }, []).field === 'active');
check('setting and removing one item\'s price', setListPrice(whole, 'p:jeans', '1200').prices['p:jeans'] === 1200 && !('p:shirt' in setListPrice(whole, 'p:shirt', '').prices));
check('one default per shop', withDefault(lists, 'w').filter(l => l.isDefault).map(l => l.id).join() === 'w');

// a saved bill keeps the price it was sold at: the bill's lines carry the price, and changing the list later changes nothing there
const bill = computeCheckout({ lines: [{ q: 2, price: resolvePrice('shirt', 'shirt-m', 1000, ctx({ selectedListId: 'w' })).price, rate: 0 }], gst: { mode: 'none' } });
const changed = setListPrice(whole, 'p:shirt', 800);
check('historical bills stay as sold when a list changes later', bill.total === 1400 && resolvePrice('shirt', 'shirt-m', 1000, { lists: [changed], selectedListId: 'w', day: '2026-10-03' }).price === 800 && bill.total === 1400);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
