// Unified commerce (src/domain/commerce/channels.js): each bill's channel from what it records, sales by channel with
// returns going to their bill's channel, and stock reserved for online-store orders exactly as the database counts it.
// Run: npm run test:unit
import { CHANNELS, byChannel, channelLabel, channelOf, isOnlineOrder, reservedByOrders } from '../../src/domain/commerce/channels.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); } };
const orders = { m1: { id: 'm1', kind: 'sales', source: 'customer' }, s1: { id: 's1', kind: 'sales', source: 'staff' }, t1: { id: 't1', kind: 'table', source: 'customer' } };
const orderOf = (id) => orders[id] || null;

check('five channels: counter, online store, sales orders, dine-in, events', CHANNELS.map((c) => c.key).join() === 'counter,online,orders,dinein,event' && channelLabel('online') === 'Online store' && channelLabel('nope') === 'Counter');
check('a bill\'s channel from what it records', channelOf({ id: 'a' }) === 'counter' && channelOf({ table: 'T1' }) === 'dinein' && channelOf({ order: 'm1' }, orderOf) === 'online'
  && channelOf({ order: 's1' }, orderOf) === 'orders' && channelOf({ order: 't1' }, orderOf) === 'dinein' && channelOf({ event: 'e1' }) === 'event' && channelOf({ order: 'gone' }, orderOf) === 'orders' && channelOf(null) === 'counter');
const live = [{ id: 'b1', total: 1000 }, { id: 'b2', total: 2000, order: 'm1' }, { id: 'b3', total: 500, event: 'e1' }];
const rets = [{ sale: 'b2', value: 300 }, { sale: 'old', value: 100 }];
const sum = (l, r) => ({ sales: l.reduce((a, s) => a + s.total, 0) - r.reduce((a, x) => a + x.value, 0), bills: l.length });
const C = byChannel(live, rets, { orderOf, saleOf: (id) => (id === 'old' ? { id: 'old', order: 'm1' } : null), summarize: sum });
check('sales by channel, in channel order; a return goes to its bill\'s channel (an older bill too)', JSON.stringify(C) === JSON.stringify([{ key: 'counter', label: 'Counter', sales: 1000, bills: 1 }, { key: 'online', label: 'Online store', sales: 1600, bills: 1 }, { key: 'event', label: 'Events & pop-ups', sales: 500, bills: 1 }]), C);
const O = [
  { id: 'm1', kind: 'sales', source: 'customer', status: 'confirmed', items: [{ v: 'v1', q: 3, fq: 1 }, { v: 'v2', q: 2 }] },
  { id: 'm2', kind: 'sales', source: 'customer', status: 'draft', items: [{ v: 'v1', q: 1.5 }] },
  { id: 'm3', kind: 'sales', source: 'customer', status: 'completed', items: [{ v: 'v1', q: 9 }] },
  { id: 'm4', kind: 'sales', source: 'customer', status: 'cancelled', items: [{ v: 'v1', q: 9 }] },
  { id: 's1', kind: 'sales', source: 'staff', status: 'confirmed', items: [{ v: 'v1', q: 9 }] },
  { id: 't1', kind: 'table', source: 'customer', status: 'new', items: [{ v: 'v1', q: 9 }] },
];
const res = reservedByOrders(O);
check('reserved: open online-store orders only, less what was billed (as the database counts it)', res.get('v1') === 3.5 && res.get('v2') === 2 && res.size === 2, [...res]);
check('...the order on the bill may take its own reservation', reservedByOrders(O, { except: 'm1' }).get('v1') === 1.5 && !reservedByOrders(O, { except: 'm1' }).has('v2'));
check('an online-store order is a sales order the customer placed', isOnlineOrder(O[0]) && !isOnlineOrder(O[4]) && !isOnlineOrder(O[5]) && !isOnlineOrder(null));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
