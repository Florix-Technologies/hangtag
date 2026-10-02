// Restaurant / table-ordering core: table setup, sessions and floor state, kitchen flow,
// table-bill snapshots, guest QR validation, and the local-first table repository.
// Run: npm run test:unit
import {
  MAX_TABLES,
  checkGuestOrder,
  checkTable,
  kitchenMoveOk,
  kitchenTickets,
  liveSessionsOf,
  nextKitchenStep,
  sessionBillLines,
  tableOrder,
  tableOrderUrl,
  tableState,
} from '../../src/domain/restaurant/tables.js';
import { createLocalFirstTableRepository } from '../../src/infrastructure/repositories/local-first-table-repository.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- table setup ----------
{
  const good = checkTable({ name: '  Garden   2 ', area: '  Roof  ', seats: '4', sort: '7', qr: 'q' });
  check('a table is trimmed and normalised, with numeric seats and sort', !good.error
    && eq(good.table, { id: undefined, name: 'Garden 2', area: 'Roof', seats: 4, sort: 7, active: true, qr: 'q' }), good);
  check('a table needs a short name and valid whole-number seats', checkTable({ name: '', seats: '4' }).field === 'name'
    && checkTable({ name: 'T1', seats: '2.5' }).field === 'seats'
    && checkTable({ name: 'T1', seats: '100' }).field === 'seats');
  check('an active duplicate table name is refused case-insensitively, while an archived one may be reused', checkTable({ name: ' t1 ' }, [{ id: 'a', name: 'T1', active: true }]).field === 'name'
    && !checkTable({ name: 't1' }, [{ id: 'a', name: 'T1', active: false }]).error);
  const full = Array.from({ length: MAX_TABLES }, (_, i) => ({ id: 't' + i, name: 'T' + i, active: true }));
  check('the configured table limit is enforced only for a new active table', !!checkTable({ name: 'Overflow' }, full).error
    && !checkTable({ id: 't0', name: 'T0' }, full).error);
  check('tables use natural number ordering and QR links keep the token in the fragment', ['T2', 'T10', 'T11'].sort((a, b) => tableOrder({ name: a }, { name: b })).join(',') === 'T2,T10,T11'
    && tableOrderUrl('https://shop.example/app/#old', 'abc_DEF-123') === 'https://shop.example/app/#t=abc_DEF-123');
}

// ---------- sessions, table state and kitchen flow ----------
{
  const sessions = [
    { id: 'closed', table: 't1', status: 'closed', t: 1 },
    { id: 'open-late', table: 't1', status: 'open', t: 30 },
    { id: 'other', table: 't2', status: 'open', t: 2 },
    { id: 'billing', table: 't1', status: 'billing', t: 20 },
  ];
  check('only a table’s open/billing sessions are live, oldest first', eq(liveSessionsOf(sessions, 't1').map(s => s.id), ['billing', 'open-late']));
  check('floor state is available, occupied, preparing, ready, then billing by priority', tableState([], []) === 'available'
    && tableState([{ status: 'open' }], []) === 'occupied'
    && tableState([{ status: 'open' }], [{ status: 'new' }]) === 'preparing'
    && tableState([{ status: 'open' }], [{ status: 'new' }], false) === 'occupied'
    && tableState([{ status: 'open' }], [{ status: 'preparing' }, { status: 'ready' }]) === 'ready'
    && tableState([{ status: 'billing' }], [{ status: 'ready' }]) === 'billing');
  check('kitchen flow only moves forward (skipping is allowed); cancellation stops before served', nextKitchenStep('new') === 'accepted'
    && nextKitchenStep('ready') === 'served' && nextKitchenStep('served') === null
    && kitchenMoveOk('new', 'ready') && !kitchenMoveOk('ready', 'preparing')
    && kitchenMoveOk('preparing', 'cancelled') && !kitchenMoveOk('served', 'cancelled'));
  const tickets = kitchenTickets([
    { id: 'n2', kind: 'table', status: 'new', t: 20 },
    { id: 'n1', kind: 'table', status: 'new', t: 10 },
    { id: 'r1', kind: 'table', status: 'ready', t: 5 },
    { id: 'served', kind: 'table', status: 'served', t: 1 },
    { id: 'cancelled', kind: 'table', status: 'cancelled', t: 1 },
    { id: 'quote', kind: 'quote', status: 'new', t: 1 },
  ]);
  check('kitchen tickets are grouped by active step and remain oldest first', eq(tickets, { new: [
    { id: 'n1', kind: 'table', status: 'new', t: 10 }, { id: 'n2', kind: 'table', status: 'new', t: 20 },
  ], accepted: [], preparing: [], ready: [{ id: 'r1', kind: 'table', status: 'ready', t: 5 }] }), tickets);
}

// ---------- table bill snapshots ----------
{
  const pct10 = { type: 'percent', value: 10 };
  const lines = sessionBillLines([
    { id: 'later', kind: 'table', status: 'served', t: 20, items: [
      { v: 'v1', p: 'p1', name: 'Tea', vl: 'Large', u: 'kg', gst: 5, q: 1.25, price: 100, disc: pct10 },
    ] },
    { id: 'first', kind: 'table', status: 'ready', t: 10, items: [
      { v: 'v1', p: 'p1', name: 'Tea', vl: 'Large', u: 'kg', gst: 5, q: 0.75, price: 100, disc: pct10 },
      // Same variant/price/discount, but a different tax snapshot: it must not be merged.
      { v: 'v1', p: 'p1', name: 'Tea', vl: 'Large', u: 'kg', gst: 12, q: 1, price: 100, disc: pct10 },
    ] },
    { id: 'cancelled', kind: 'table', status: 'cancelled', t: 1, items: [
      { v: 'v2', p: 'p2', name: 'Ignored', q: 9, price: 9 },
    ] },
  ]);
  const snapshots = lines.map(l => [l.v, l.p, l.name, l.vl, l.u, l.gst, l.q, l.price, l.disc]);
  check('a table bill aggregates identical order snapshots, excludes cancelled orders, and preserves unit/GST snapshots', eq(snapshots, [
    ['v1', 'p1', 'Tea', 'Large', 'kg', 5, 2, 100, pct10],
    ['v1', 'p1', 'Tea', 'Large', 'kg', 12, 1, 100, pct10],
  ]), snapshots);
}

// ---------- guest QR order validation ----------
{
  const valid = checkGuestOrder([{ v: 'v1', q: '2.5', note: '  no\u0000 onion  ' }, { v: 'v2', q: 1 }]);
  check('guest orders retain valid variant IDs, rounded quantities and cleaned optional notes', eq(valid, { items: [
    { v: 'v1', q: 2.5, note: 'no onion' }, { v: 'v2', q: 1 },
  ] }), valid);
  check('guest orders reject an empty cart, over-precise/too-large quantities and more than 50 lines', !!checkGuestOrder([]).error
    && !!checkGuestOrder([{ v: 'v1', q: 1.0001 }]).error
    && !!checkGuestOrder([{ v: 'v1', q: 51 }]).error
    && !!checkGuestOrder([{ v: 'v1', q: 1 }, { v: 'v1', q: 1 }]).error
    && !!checkGuestOrder(Array.from({ length: 51 }, (_, i) => ({ v: 'v' + i, q: 1 }))).error);
}

// ---------- local-first table repository ----------
{
  const state = { tables: {}, tableSessions: {} }, calls = [];
  const repo = createLocalFirstTableRepository({
    store: state,
    persist: { saveTables: () => calls.push('tables'), saveTableSessions: () => calls.push('sessions') },
    outbox: { enqueue: item => calls.push(item) },
  });
  const table = { id: 't1', name: 'T1', active: true }, session = { id: 's1', table: 't1', status: 'open', t: 1 };
  repo.saveTable(table); repo.saveSession(session);
  check('the table repository saves locally before exactly one typed sync item per record', repo.table('t1') === table && repo.session('s1') === session
    && eq(repo.tables(), [table]) && eq(repo.sessions(), [session])
    && eq(calls, ['tables', { type: 'table', id: 't1', table }, 'sessions', { type: 'tsession', id: 's1', session }]), calls);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
