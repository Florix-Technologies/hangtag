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

Object.assign(console, quiet);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
