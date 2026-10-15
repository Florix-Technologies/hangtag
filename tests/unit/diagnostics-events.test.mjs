// Structured, privacy-safe diagnostic events (src/shared/logging/diagnostics.js recordEvent / logger.event): the owner's
// categories (API latency, sync, payments, email, WhatsApp, SMS, printer, Agent tools, automation, database), technical
// fields only (an operation name, a code, an HTTP status, a duration band, a count — never a name, phone, note or amount),
// the last 24 hours by category, API timing on the Supabase client's fetch (by operation, never the address's values),
// and database errors by SQLSTATE (a rule's message for people and the plan lock are not counted as errors).
// Run: node tests/unit/diagnostics-events.test.mjs
import { provide } from '../../src/shared/di/services.js';
import { DIAG_CATEGORIES, categoryCounts, clearDiagnostics, durationBand, getDiagnostics, recordEvent } from '../../src/shared/logging/diagnostics.js';
import { apiOp, withTiming } from '../../src/infrastructure/supabase/client.js';
import { toAppError } from '../../src/infrastructure/supabase/errors.js';
import { logger } from '../../src/shared/logging/logger.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const mem = new Map();
provide('storage', { get: (k, d) => (mem.has(k) ? JSON.parse(mem.get(k)) : d), set: (k, v) => { mem.set(k, JSON.stringify(v)); return true; }, getRaw: (k) => mem.get(k) ?? null, setRaw: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k) });
const quiet = { error: console.error, warn: console.warn, info: console.info };
console.error = console.warn = console.info = () => {};   // logger.event also prints; keep the test output readable

clearDiagnostics();
check('the owner\'s categories: API latency, sync, payments, email, WhatsApp, SMS, printer, Agent tools, automation, database',
  ['api', 'sync', 'payment', 'email', 'whatsapp', 'sms', 'printer', 'agent', 'automation', 'database'].every((k) => DIAG_CATEGORIES[k]));
const e1 = recordEvent('sync', 'upload-failed', { op: 'sale', code: 'NETWORK', name: 'Riya Sharma', phone: '9876543210', note: 'call Riya', amount: 500 });
check('an event keeps only its category, kind, operation and code — a name, phone, note or amount passed along is never read',
  e1.category === 'sync' && e1.kind === 'upload-failed' && e1.op === 'sale' && e1.code === 'NETWORK' && !/Riya|9876543210|call|500/.test(JSON.stringify(e1)), e1);
const e2 = recordEvent('api', 'slow-call', { op: 'rpc:hangtag_save_sales', ms: 4321, status: 200 }, 'warn');
check('a slow call: its operation and a duration band, never the exact time', e2.op === 'rpc:hangtag_save_sales' && /3–10 s/.test(e2.message) && !/4321/.test(JSON.stringify(e2)) && e2.level === 'warn', e2);
check('duration bands', durationBand(500) === 'under 1 s' && durationBand(2500) === '1–3 s' && durationBand(45000) === '30 s or more' && durationBand('x') === '');
recordEvent('printer', 'print-failed', { op: 'unreachable' });
recordEvent('payment', 'start-failed', { op: 'provider', code: 'DELIVERY' });
logger.event('whatsapp', 'send-failed', { op: 'auto-receipt' });
logger.event('agent', 'tool-failed', { op: 'get_low_stock' }, 'warn');
logger.event('automation', 'rule-failed', { op: 'reorder' }, 'warn');
recordEvent('sync', 'upload-failed', { op: 'sale', code: 'NETWORK' });
const c = categoryCounts(24);
check('the last 24 hours by category (a repeat within a minute is counted, not duplicated)', c.sync === 2 && c.api === 1 && c.printer === 1 && c.payment === 1 && c.whatsapp === 1
  && c.agent === 1 && c.automation === 1 && c.email === 0 && c.sms === 0 && c.database === 0, c);
check('events older than 24 hours are not counted', categoryCounts(24, Date.now() + 25 * 3600e3).sync === 0);
check('an unknown category becomes "app" (never free text as a category)', recordEvent('Riya Sharma', 'x').category === 'app');

console.log('=== API timing on the Supabase client ===');
check('operation names carry no values', apiOp('https://p.supabase.co/rest/v1/hangtag_customers?phone=eq.9876543210&select=*') === 'table:hangtag_customers'
  && apiOp('https://p.supabase.co/rest/v1/rpc/hangtag_save_sales') === 'rpc:hangtag_save_sales' && apiOp('https://p.supabase.co/functions/v1/send-receipt') === 'fn:send-receipt'
  && apiOp('https://p.supabase.co/auth/v1/token?grant_type=password') === 'auth:token' && apiOp('not a url at all') === 'other');
clearDiagnostics();
let t = 0; const clock = () => t;
const slow = withTiming(async () => { t += 5000; return { status: 200 }; }, clock);
const bad = withTiming(async () => { t += 10; return { status: 503 }; }, clock);
const down = withTiming(async () => { throw new TypeError('Failed to fetch'); }, clock);
const fast = withTiming(async () => ({ status: 200 }), clock);
const refused = withTiming(async () => ({ status: 400 }), clock);
await slow('https://p.supabase.co/rest/v1/rpc/hangtag_save_sales');
await bad('https://p.supabase.co/rest/v1/hangtag_sales?id=eq.INV-1');
await down('https://p.supabase.co/functions/v1/agent').catch(() => {});
await fast('https://p.supabase.co/rest/v1/hangtag_products');
await refused('https://p.supabase.co/rest/v1/hangtag_products');
const d = getDiagnostics();
check('a slow call, a server error and a failed connection are noted by operation; a quick or refused call is not', d.length === 3 && d.map((x) => x.kind).join() === 'slow-call,server-error,connection-failed'
  && d[1].status === 503 && d.every((x) => x.category === 'api') && !/INV-1|eq\./.test(JSON.stringify(d)), d);

console.log('=== a slow call: the network\'s own time, and a hidden page ===');
// the app's timer runs until the page's thread takes the answer: a busy or hidden page makes a quick answer look slow
clearDiagnostics();
const e3 = recordEvent('api', 'slow-call', { op: 'rpc:hangtag_subscription_status', ms: 5200, status: 200, net: 180, hidden: true }, 'warn');
check('a slow call with the network\'s own time and a hidden page: both as words (a band, a flag), never the exact times',
  e3.message === 'slow call (rpc:hangtag_subscription_status) · 3–10 s · network under 1 s · page hidden' && e3.net === 'under 1 s' && e3.hidden === true
  && !/5200|180/.test(JSON.stringify(e3)), e3);
const e4 = recordEvent('api', 'slow-call', { op: 'rpc:x', ms: 4000, net: '9876543210', hidden: 'yes' }, 'warn');
check('…a network time that isn\'t a number, or a "hidden" that isn\'t true, is left out', e4.message === 'slow call (rpc:x) · 3–10 s' && !('net' in e4) && !('hidden' in e4), e4);
clearDiagnostics();
{
  let t3 = 0; const clock3 = () => t3;
  const timing = (net, hidden) => ({ hidden: () => false, hiddenSince: () => hidden, network: async () => net });
  const busyPage = withTiming(async () => { t3 += 4000; return { status: 200 }; }, clock3, timing(120, false));
  const hiddenSlow = withTiming(async () => { t3 += 6000; return { status: 200 }; }, clock3, timing(5800, true));
  const unknown = withTiming(async () => { t3 += 3500; return { status: 200 }; }, clock3, timing(null, false));
  const asleep = withTiming(async () => { throw new TypeError('Failed to fetch'); }, clock3, timing(null, true));
  await busyPage('https://p.supabase.co/rest/v1/rpc/hangtag_subscription_status?x=eq.9876543210');
  await hiddenSlow('https://p.supabase.co/rest/v1/rpc/hangtag_subscription_status');
  await unknown('https://p.supabase.co/rest/v1/hangtag_sales');
  await asleep('https://p.supabase.co/auth/v1/token?grant_type=refresh_token').catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  const m = getDiagnostics().map((x) => x.message);
  check('withTiming: a slow call the network answered quickly (a busy page), one slow on the network while the page was hidden, one the browser didn\'t time, and a failed connection while hidden',
    m.length === 4 && m[0] === 'slow call (rpc:hangtag_subscription_status) · 3–10 s · network under 1 s' && m[1] === 'slow call (rpc:hangtag_subscription_status) · 3–10 s · network 3–10 s · page hidden'
    && m[2] === 'slow call (table:hangtag_sales) · 3–10 s' && m[3] === 'connection failed (auth:token) · under 1 s · page hidden' && !/9876543210|eq\./.test(JSON.stringify(getDiagnostics())), m);
}
{
  // the browser's side, with a stand-in window: Resource Timing entries as they come, and the page's visibility
  const { createNetworkTiming } = await import('../../src/infrastructure/supabase/network-timing.js');
  const on = {}; let vis = 'visible', nowMs = 1000, deliver = null;
  const win = { document: { get visibilityState() { return vis; }, addEventListener: (k, f) => { on[k] = f; } }, performance: { now: () => nowMs },
    PerformanceObserver: class { constructor(cb) { deliver = cb; } observe() {} } };
  const nt = createNetworkTiming({ opOf: apiOp, win });
  const waiting = nt.network('rpc:hangtag_subscription_status', 1000, 500);
  deliver({ getEntries: () => [{ initiatorType: 'script', name: 'https://p.supabase.co/rest/v1/rpc/hangtag_subscription_status', startTime: 1001, duration: 9 },
    { initiatorType: 'fetch', name: 'https://p.supabase.co/rest/v1/rpc/hangtag_subscription_status?p=eq.9876543210', startTime: 1002, duration: 140 }] });
  const got = await waiting;
  deliver({ getEntries: () => [{ initiatorType: 'fetch', name: 'https://p.supabase.co/rest/v1/rpc/hangtag_subscription_status', startTime: 1500, duration: 80 }] });
  const later = await nt.network('rpc:hangtag_subscription_status', 1501, 50), none = await nt.network('rpc:hangtag_save_sales', 1000, 50);
  check('the network time of a call: the browser\'s own (a fetch of that operation, started then), also when asked after it came; none when it doesn\'t come in time',
    got === 140 && later === 80 && none === null, { got, later, none });
  nowMs = 2000;
  const before = nt.hiddenSince(1500);
  vis = 'hidden'; nowMs = 2100; on.visibilitychange(); vis = 'visible'; nowMs = 2200; on.visibilitychange();
  check('…and the page\'s visibility: a call since 1500 saw the page hidden (at 2100), one since 2150 didn\'t', before === false && nt.hiddenSince(1500) === true
    && nt.hiddenSince(2150) === false && nt.hidden() === false);
  const plain = createNetworkTiming({ opOf: apiOp, win: null });
  check('…in Node (no page): nothing is known, nothing is waited for', plain.hidden() === false && plain.hiddenSince(0) === false && (await plain.network('rpc:x', 0)) === null);

  // two calls of one operation: a timing goes to one call only, the closest; started together, neither gets one
  const w2 = { document: { visibilityState: 'visible', addEventListener() {} }, performance: { now: () => 0 }, addEventListener: (k, f) => { w2[k] = f; },
    PerformanceObserver: class { constructor(cb) { w2.deliver = cb; } observe() {} } };
  const t2 = createNetworkTiming({ opOf: apiOp, win: w2 });
  const URL_T = 'https://p.supabase.co/rest/v1/hangtag_table_sessions';
  t2.begin('table:hangtag_table_sessions', 1000); t2.begin('table:hangtag_table_sessions', 1000.5);   // started together
  const a = t2.network('table:hangtag_table_sessions', 1000, 50), b = t2.network('table:hangtag_table_sessions', 1000.5, 50);
  w2.deliver({ getEntries: () => [{ initiatorType: 'fetch', name: URL_T, startTime: 1000.2, duration: 3600 }, { initiatorType: 'fetch', name: URL_T, startTime: 1000.6, duration: 150 }] });
  const [na, nb] = await Promise.all([a, b]);
  t2.begin('table:hangtag_table_sessions', 5000); t2.begin('table:hangtag_table_sessions', 5400);   // apart: each has its own
  const c = t2.network('table:hangtag_table_sessions', 5000, 200), d2 = t2.network('table:hangtag_table_sessions', 5400, 200);
  w2.deliver({ getEntries: () => [{ initiatorType: 'fetch', name: URL_T, startTime: 5401, duration: 90 }, { initiatorType: 'fetch', name: URL_T, startTime: 5001, duration: 3700 }] });
  const [nc, nd] = await Promise.all([c, d2]);
  t2.begin('rpc:hangtag_save_sales', 9000);
  w2.deliver({ getEntries: () => [{ initiatorType: 'fetch', name: 'https://p.supabase.co/rest/v1/rpc/hangtag_save_sales', startTime: 9001, duration: 120 }] });
  const once = await t2.network('rpc:hangtag_save_sales', 9000, 30), again = await t2.network('rpc:hangtag_save_sales', 9002, 30);
  check('two calls of one operation: started together, neither gets a network time (a guess could blame the page for the network); apart, each gets its own; a timing is used once',
    na === null && nb === null && nc === 3700 && nd === 90 && once === 120 && again === null, { na, nb, nc, nd, once, again });
  t2.begin('rpc:hangtag_subscription_status', 20000);
  const left = t2.network('rpc:hangtag_subscription_status', 20000, 60000);
  w2.pagehide();
  check('…leaving the page: a call still waiting is noted at once (without a network time), not lost', (await left) === null);
  const d3 = { visibilityState: 'visible', addEventListener: (k, f) => { d3[k] = f; } };
  const w3 = { document: d3, performance: { now: () => 0 }, addEventListener() {}, PerformanceObserver: class { observe() {} } };
  const t3 = createNetworkTiming({ opOf: apiOp, win: w3 });
  t3.begin('rpc:hangtag_subscription_status', 30000);
  const frozen = t3.network('rpc:hangtag_subscription_status', 30000, 60000);
  d3.freeze();
  check('…and the page frozen (an installed app in the background may be ended without a pagehide): noted at once too', (await frozen) === null);
}
clearDiagnostics();
{
  // the entry is stamped with the time the answer came, though noted once the network time is known
  let t4 = 0; const before = Date.now();
  const late = { hidden: () => false, hiddenSince: () => false, begin() {}, network: () => new Promise((r) => setTimeout(() => r(200), 120)) };
  await withTiming(async () => { t4 += 3500; return { status: 200 }; }, () => t4, late)('https://p.supabase.co/rest/v1/rpc/hangtag_subscription_status');
  const answered = Date.now();
  await new Promise((r) => setTimeout(r, 200));
  const e5 = getDiagnostics().find((x) => x.kind === 'slow-call');
  check('…a slow call noted later is stamped with the time its answer came', !!e5 && Date.parse(e5.at) >= before && Date.parse(e5.at) <= answered, { at: e5 && e5.at, before, answered });
  // the notes never stand in the way of the call: a timing that throws leaves the answer (or the failure) as it was
  const broken = { hidden() { throw new Error('x'); }, hiddenSince() { throw new Error('x'); }, begin() { throw new Error('x'); }, network() { throw new Error('x'); } };
  const okRes = await withTiming(async () => { t4 += 4000; return { status: 200, ok: true }; }, () => t4, broken)('https://p.supabase.co/rest/v1/hangtag_sales').catch((e) => 'rejected: ' + e.message);
  const failed = await withTiming(async () => { throw new TypeError('Failed to fetch'); }, () => t4, broken)('https://p.supabase.co/auth/v1/token').catch((e) => e.name);
  check('…and a timing that fails never breaks a call: the answer comes back, a failure stays the same failure', okRes && okRes.status === 200 && failed === 'TypeError', { okRes, failed });
}
clearDiagnostics();

console.log('=== database errors ===');
clearDiagnostics();
toAppError({ code: '23505', message: 'duplicate key value violates unique constraint Key (phone)=(9876543210)' });
toAppError({ code: 'P0001', message: 'Riya owes ₹500' });
toAppError({ code: 'HT402', message: 'HANGTAG_SUBSCRIPTION_INACTIVE: plan ended' });
toAppError(new TypeError('Failed to fetch'));
const db = getDiagnostics();
check('the SQLSTATE only (a unique violation), never the database\'s message; a rule\'s message for people, the plan lock and a network error are not database errors',
  db.length === 1 && db[0].category === 'database' && db[0].code === '23505' && db[0].kind === 'unique-violation' && !/9876543210|Riya|phone/.test(JSON.stringify(db)), db);
clearDiagnostics();

// 2026-10-13: "Problem · error PGRST116" said neither what it meant nor which read failed (supabase-js raises it itself, after
// the server answered 200, when a single-row read gets several rows)
toAppError({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'Results contain 9 rows, application/vnd.pgrst.object+json requires 1 row' },
  'table:hangtag_meta');
let ev = getDiagnostics();
check('a single-row read that got several rows: "more than one row (table:hangtag_meta)", a problem; never the rows or the message',
  ev.length === 1 && ev[0].category === 'database' && ev[0].code === 'PGRST116' && ev[0].kind === 'more-than-one-row' && ev[0].op === 'table:hangtag_meta' && ev[0].level === 'error'
  && /more than one row \(table:hangtag_meta\)/.test(ev[0].message) && !/9 rows|JSON object|requires/.test(JSON.stringify(ev)), ev);
clearDiagnostics();
{
  const { sbFetchAll } = await import('../../src/infrastructure/supabase/query.js');
  const missing = { from: () => { const q = { select: () => q, order: () => q,
    range: async () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.hangtag_units' in the schema cache" } }) }; return q; } };
  let err = null; try { await sbFetchAll(missing, 'hangtag_units', ['id']); } catch (e) { err = e; }
  ev = getDiagnostics();
  check('…a table the database doesn\'t have, read in bulk: "database update needed (table:hangtag_units)", and the read still refuses as before',
    err && err.code === 'OUTDATED_DATABASE' && ev.length === 1 && ev[0].kind === 'database-update-needed' && ev[0].op === 'table:hangtag_units' && ev[0].code === 'PGRST205'
    && ev[0].level === 'warn' && !/schema cache/.test(JSON.stringify(ev)), { err: err && err.code, ev });
}
clearDiagnostics();
toAppError({ code: '23505', message: 'x' });
check('…a caller that names no operation records the code as before (no operation field)', getDiagnostics().length === 1 && !('op' in getDiagnostics()[0])
  && getDiagnostics()[0].code === '23505', getDiagnostics());
clearDiagnostics();
toAppError({ code: '42501', message: 'new row violates row-level security policy for table "hangtag_sales"' }, 'table:hangtag_sales');
toAppError({ code: '23505', message: 'x' }, 'table:9876543210');
toAppError({ code: '23503', message: 'x' }, 'table:hangtag_customers?phone=eq.9876543210');
ev = getDiagnostics();
check('…a refusal by row security stays a problem, with its table; an operation not in the app\'s own shape (a number, a filter) is never kept',
  ev.length === 3 && ev[0].kind === 'permission-denied' && ev[0].level === 'error' && ev[0].op === 'table:hangtag_sales' && !('op' in ev[1]) && !('op' in ev[2])
  && !/9876543210|phone/.test(JSON.stringify(ev)), ev);
clearDiagnostics();

Object.assign(console, quiet);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
