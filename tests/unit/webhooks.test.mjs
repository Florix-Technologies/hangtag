// Outbound webhooks (supabase/functions/webhook-dispatch/core.js): HMAC signing a receiver can verify, the same bytes on
// every retry, back-off and when to give up, safe addresses only, and the app's rules agreeing with the function's.
import { MAX_ATTEMPTS, WEBHOOK_EVENTS, afterAttempt, checkEvents, checkUrl, deliveryHeaders, eventBody, outcome, privateAddress, retryDelay, signature, verifySignature } from '../../supabase/functions/webhook-dispatch/core.js';
import * as app from '../../src/domain/shop/webhooks.js';
import { createHmac } from 'node:crypto';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if(ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };

const secret = 'whsec_' + 'ab'.repeat(32), ts = 1790000000;
const ev = { id: '0b5c0000-0000-4000-8000-000000000001', type: 'sale.completed', payload: { id: 's1', total: 1050 }, created_at: '2026-10-03T10:00:00.000Z' };
const body = eventBody(ev), sig = await signature(secret, ts, body);
check('the signature is HMAC-SHA256 of "<timestamp>.<body>" (what any receiver computes)', sig === 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'));
check('the body is the same bytes on every retry (event id and data)', eventBody(ev) === body && JSON.parse(body).id === ev.id && JSON.parse(body).data.total === 1050);
check('headers carry the event, its id and the signature', (() => { const h = deliveryHeaders({ id: ev.id, type: ev.type, timestamp: ts, sig }); return h['X-Hangtag-Event-Id'] === ev.id && h['X-Hangtag-Signature'] === sig && h['X-Hangtag-Timestamp'] === String(ts); })());
check('a receiver accepts the right signature in time…', await verifySignature(secret, ts, body, sig, { now: ts + 30 }));
check('…and refuses a changed body, another secret, or an old timestamp (replay)', !(await verifySignature(secret, ts, body + ' ', sig, { now: ts })) && !(await verifySignature('whsec_other', ts, body, sig, { now: ts }))
  && !(await verifySignature(secret, ts, body, sig, { now: ts + 3600 })));
check('outcomes: 2xx delivered; 5xx, 408, 429 and no answer retried; other 4xx failed', outcome(200) === 'delivered' && outcome(204) === 'delivered' && outcome(500) === 'retry' && outcome(429) === 'retry'
  && outcome(408) === 'retry' && outcome(0) === 'retry' && outcome(400) === 'failed' && outcome(410) === 'failed');
check('back-off grows and stops after the last attempt', retryDelay(1) === 60 && retryDelay(2) === 300 && retryDelay(7) === 43200 && afterAttempt(1, 503).status === 'pending' && afterAttempt(1, 503).retryIn === 60
  && afterAttempt(MAX_ATTEMPTS, 503).status === 'failed' && afterAttempt(3, 200).status === 'delivered' && afterAttempt(1, 401).status === 'failed');
check('only public https addresses', !!checkUrl('http://example.com/h').error && !!checkUrl('https://localhost/h').error && !!checkUrl('https://10.0.0.5/h').error
  && !!checkUrl('https://169.254.169.254/latest').error && !!checkUrl('https://[::1]/h').error && !!checkUrl('https://user:pw@example.com/h').error && !!checkUrl('https://example.com:22/h').error
  && checkUrl('https://hooks.example.com/hangtag?x=1').url === 'https://hooks.example.com/hangtag?x=1');
check('private ranges', privateAddress('192.168.1.1') && privateAddress('172.20.0.1') && privateAddress('100.64.1.1') && privateAddress('fd00::1') && !privateAddress('8.8.8.8') && !privateAddress('2606:4700::1111'));
check('events: known ones only, at least one', !!checkEvents([]).error && !!checkEvents(['sale.deleted']).error && checkEvents(['sale.completed', 'sale.completed']).events.length === 1);
check('the app\'s rules agree with the function\'s', JSON.stringify(app.WEBHOOK_EVENTS) === JSON.stringify(WEBHOOK_EVENTS)
  && ['https://a.example.com/x', 'http://a.example.com', 'https://127.0.0.1/', 'https://a.local/x', 'https://[fe80::1]/'].every(u => JSON.stringify(app.checkUrl(u)) === JSON.stringify(checkUrl(u))));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
