// Observability (src/shared/logging/diagnostics.js): every server call's time, kept as hourly counts per operation for 24
// hours (calls, failures, the average, where most fall, the slowest — by operation name only, never the address's values),
// timed on the Supabase client's fetch; and the Hangtag Agent's chain for each question — request → tool → result →
// action → approval → outcome — as codes only (never the question, a name or an amount), the latest 20 kept; both in the
// support report. Run: node tests/unit/observability.test.mjs
import { provide } from '../../src/shared/di/services.js';
import { TRACE_LIMIT, TRACE_STEPS, clearLatency, clearTraces, currentTrace, diagnosticsReport, endTrace, getTraces, latencySummary, recordLatency, startTrace, traceStep } from '../../src/shared/logging/diagnostics.js';
import { withTiming } from '../../src/infrastructure/supabase/client.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const mem = new Map();
provide('storage', { get: (k, d) => (mem.has(k) ? JSON.parse(mem.get(k)) : d), set: (k, v) => { mem.set(k, JSON.stringify(v)); return true; }, getRaw: (k) => mem.get(k) ?? null, setRaw: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k) });
const quiet = { error: console.error, warn: console.warn, info: console.info };
console.error = console.warn = console.info = () => {};

// ---------- latency ----------
clearLatency();
const now = Date.UTC(2026, 9, 7, 10, 30);
[120, 340, 800, 1500, 4200].forEach((ms) => recordLatency('rpc:hangtag_save_sales', ms, true, now));
recordLatency('rpc:hangtag_save_sales', 900, false, now);
[90, 110].forEach((ms) => recordLatency('table:hangtag_sales', ms, true, now - 3600e3));
recordLatency('fn:send-receipt', 31000, false, now - 25 * 3600e3);   // more than a day ago
let L = latencySummary(24, now);
const save = L.ops.find((o) => o.op === 'rpc:hangtag_save_sales');
check('every call counted by operation, busiest first: calls, failures, the average, the slowest', L.ops[0].op === 'rpc:hangtag_save_sales' && save.calls === 6 && save.failed === 1 && save.avgMs === Math.round((120 + 340 + 800 + 1500 + 4200 + 900) / 6) && save.maxMs === 4200, L);
check('…where half and nearly all of them fall (bands), how many were slow (3 s or more)', save.p50 === 'under 1 s' && save.p95 === '3–10 s' && save.slow === 1, save);
check('totals for the day: calls, failed, typical time, slow', L.calls === 8 && L.failed === 1 && L.slow === 1 && L.avgMs > 0, L);
check('older than 24 hours: not counted', !L.ops.some((o) => o.op === 'fn:send-receipt'));
check('a value in the operation is never kept (only its name)', (() => { recordLatency('table:hangtag_customers?phone=eq.9876543210', 50, true, now); return !JSON.stringify(latencySummary(24, now)).includes('9876543210'); })());
recordLatency('rpc:x', NaN, true, now); recordLatency('rpc:x', -5, true, now);
check('a broken time is ignored', !latencySummary(24, now).ops.some((o) => o.op === 'rpc:x'));
for (let i = 0; i < 60; i++) recordLatency('rpc:op' + i, 10, true, now);
check('bounded: at most 40 operations an hour', latencySummary(1, now).ops.length <= 40);
clearLatency();

let clock = 0;
const fakeFetch = (status, delay) => async () => { clock += delay; return { status }; };
await withTiming(fakeFetch(200, 250), () => clock)('https://abc.supabase.co/rest/v1/hangtag_sales?id=eq.5', {});
await withTiming(fakeFetch(503, 4000), () => clock)('https://abc.supabase.co/rest/v1/rpc/hangtag_save_sales', {});
try { await withTiming(async () => { clock += 100; throw new TypeError('Failed to fetch'); }, () => clock)('https://abc.supabase.co/functions/v1/send-receipt', {}); } catch {}
L = latencySummary(24);
check('the Supabase client times every call: ok, a server error, a failed connection — by operation', L.calls === 3 && L.failed === 2 && ['table:hangtag_sales', 'rpc:hangtag_save_sales', 'fn:send-receipt'].every((op) => L.ops.some((o) => o.op === op)), L.ops);
clearLatency();

// ---------- the Agent's chain ----------
clearTraces();
check('the chain\'s steps, in order', TRACE_STEPS.join() === 'request,tool,result,action,approval,outcome');
const id = startTrace('ask', 1000);
check('a question starts a chain (the current one, for the tool host)', currentTrace() === id);
traceStep(id, 'request', { op: 'question' }, 1000);
traceStep(id, 'tool', { op: 'get_today_sales', ok: true, ms: 40, name: 'Riya Sharma', phone: '9876543210' }, 1040);
traceStep(id, 'result', { op: 'get_today_sales', count: 3 }, 1041);
traceStep(id, 'tool', { op: 'get_customer_insight', ok: false, code: 'NOT_ALLOWED' }, 1050);
traceStep(id, 'nonsense', { op: 'x' }, 1051);
endTrace(id);
check('…the current one ends with the answer', currentTrace() === null);
traceStep(id, 'action', { op: 'bill' }, 1100); traceStep(id, 'approval', { op: 'approved' }, 5000); traceStep(id, 'outcome', { op: 'saved' }, 5001);
const T = getTraces().find((t) => t.id === id);
check('request → tool → result → tool (refused) → action → approval → outcome; an unknown step isn\'t kept', T.steps.map((s) => s.step).join() === 'request,tool,result,tool,action,approval,outcome', T.steps);
check('codes only: the tool, whether it worked, its code, the rows, a time band — never a name or a phone passed along', T.steps[1].op === 'get_today_sales' && T.steps[1].ok && T.steps[1].time === 'under 1 s'
  && T.steps[2].count === 3 && T.steps[3].ok === false && T.steps[3].code === 'NOT_ALLOWED' && !/Riya|9876543210/.test(JSON.stringify(T)), T.steps);
check('each step says how long after the question it came', T.steps[6].after === '3–10 s' && T.steps[0].after === 'under 1 s');
for (let i = 0; i < 25; i++) startTrace('ask', 2000 + i);
check('the latest ' + TRACE_LIMIT + ' chains are kept', getTraces().length === TRACE_LIMIT && !getTraces().some((t) => t.id === id));
const R = diagnosticsReport({ online: true });
check('the support report carries the day\'s latency and the chains', R.schema === 3 && R.latency && Array.isArray(R.latency.ops) && Array.isArray(R.agentChains) && R.agentChains.length === TRACE_LIMIT);
clearTraces();
check('cleared on request', getTraces().length === 0 && currentTrace() === null);

Object.assign(console, quiet);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
