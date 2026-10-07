// Observability (src/shared/logging/diagnostics.js, logger.js): the on-device technical history keeps no customer, bill,
// money, contact, token or web-address details; it is bounded; repeats are counted; global errors and failed background
// work are captured; the support report has only health facts and the cleaned history. Run: npm run test:unit
import { DIAGNOSTICS_LIMIT, clearDiagnostics, diagnosticsReport, diagnosticsSummary, getDiagnostics, installGlobalDiagnostics, recordDiagnostic, sanitizeDiagnosticText } from '../../src/shared/logging/diagnostics.js';
import { logger } from '../../src/shared/logging/logger.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); } };

const raw = 'Upload failed for customer: Riya Sharma, phone +91 98765 43210, riya@example.com, bill INV-000123 of ₹1,250.50 at https://x.supabase.co/rest/v1/sales?id=eq.1 '
  + 'token=abc.def apikey: sb_secret_abcdefghij12345 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmn id 3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e GSTIN 27ABCDE1234F1Z5 sk-ant-api03-abcdefghijklmnop';
const s = sanitizeDiagnosticText(raw);
check('no names, phone numbers, emails, bill numbers, amounts, web addresses, keys, tokens, ids or GSTINs survive', !/Riya|98765|riya@|INV-000123|1,250|supabase\.co|sb_secret|eyJhbGci|3f2b8c1e|27ABCDE|sk-ant/.test(s), s);
check('...what is left still says what went wrong', /Upload failed/.test(s) && /\[redacted\]|\[email\]|\[number\]/.test(s));
check('...and it is short (at most 240 characters, no control characters)', sanitizeDiagnosticText('x'.repeat(1000)).length === 240 && !/[\u0000-\u001f]/.test(sanitizeDiagnosticText('a\u0007b\nc')));

clearDiagnostics();
const t0 = Date.parse('2026-10-05T10:00:00Z');
recordDiagnostic({ level: 'error', source: 'sync', message: 'Couldn\'t upload a bill', now: t0 });
recordDiagnostic({ level: 'error', source: 'sync', message: 'Couldn\'t upload a bill', now: t0 + 1000 });
recordDiagnostic({ level: 'error', source: 'sync', message: 'Couldn\'t upload a bill', now: t0 + 2000 });
let list = getDiagnostics();
check('the same problem again within a minute is counted, not repeated', list.length === 1 && list[0].count === 3, list);
recordDiagnostic({ level: 'warn', source: 'printer', message: 'Printer not found', error: Object.assign(new Error('timeout'), { code: 'network', status: 503 }), now: t0 + 3000 });
list = getDiagnostics();
check('an entry keeps only technical fields: when, level, source, kind, message, code, status', list.length === 2 && list[1].code === 'NETWORK' && list[1].status === 503 && list[1].level === 'warn'
  && Object.keys(list[1]).every((k) => ['at', 'level', 'source', 'kind', 'message', 'code', 'status', 'file', 'line', 'column', 'count'].includes(k)), list[1]);
for (let i = 0; i < 80; i++) recordDiagnostic({ level: 'info', source: 'test', message: 'event ' + i, now: t0 + 10000 + i * 61000 });
check(`the history is bounded (${DIAGNOSTICS_LIMIT} entries, newest kept)`, getDiagnostics().length === DIAGNOSTICS_LIMIT && getDiagnostics().at(-1).message === 'event 79');
const sum = diagnosticsSummary();
check('the summary counts problems and warnings', sum.count === DIAGNOSTICS_LIMIT && typeof sum.errors === 'number' && sum.latestAt);
const rep = diagnosticsReport({ online: true, cloud: 'connected', pending: 3, review: 1, serviceWorker: 'active', build: 'hangtag-06e6c89ef8 for riya@example.com' });
check('the support report: health facts (cleaned), the last 24 h counts, server-call timings, the Agent\'s chains and the history, nothing else', rep.schema === 3 && rep.health.cloud === 'connected' && rep.health.pending === 3 && !/riya@/.test(rep.health.build)
  && Array.isArray(rep.diagnostics) && Object.keys(rep).join() === 'schema,createdAt,health,last24h,latency,agentChains,diagnostics' && Object.values(rep.last24h).every((n) => Number.isInteger(n))
  && Number.isInteger(rep.latency.calls) && Array.isArray(rep.latency.ops) && Array.isArray(rep.agentChains));

clearDiagnostics();
const target = new EventTarget();
check('global capture installs once per window', installGlobalDiagnostics(target) === true && installGlobalDiagnostics(target) === false);
const err = new Error('Cannot read properties of undefined (reading "total") for 9876543210');
err.stack = 'Error: x\n    at renderBill (http://localhost:3210/src/features/bills/pages/bills-page.js:42:17)';
const ev = new Event('error'); Object.assign(ev, { error: err, message: err.message });
target.dispatchEvent(ev);
const rej = new Event('unhandledrejection'); Object.assign(rej, { reason: new Error('Sync request failed') });
target.dispatchEvent(rej);
list = getDiagnostics();
check('an uncaught error is recorded with where it happened (file and line, no address), cleaned', list[0].source === 'window.error' && /bills-page\.js$/.test(list[0].file) && list[0].line === 42 && !/9876543210/.test(list[0].message), list[0]);
check('a failed background task is recorded', list[1].source === 'promise' && list[1].kind === 'unhandled-rejection' && /Sync request failed/.test(list[1].message), list[1]);

const printed = [], orig = console.error; console.error = (...a) => printed.push(a.join(' '));
logger.error('Payment check failed for 98765 43210', { cust: { name: 'Riya', phone: '9876543210' } });
console.error = orig;
check('the logger prints and records the cleaned message only (never the raw object)', printed.length === 1 && /^\[Hangtag\] Payment check failed for \[number\]/.test(printed[0]) && !/Riya|9876543210/.test(printed[0])
  && /Payment check failed/.test(getDiagnostics().at(-1).message), printed);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
