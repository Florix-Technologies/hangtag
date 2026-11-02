// Communication automation (src/domain/invoices/delivery.js receiptStateOf / receiptStatus): after a sale, where its
// receipt is — Queued, Sent, Delivered or Failed — per channel and for the bill, from what this device queued to send by
// itself and the server's record of every send. The server's record is the outcome (it also hears "delivered" from the
// provider) unless the device queued the channel again since; a bill counts as failed only when nothing reached the
// customer (a WhatsApp that failed with the SMS fallback sent is "sent"). Run: npm run test:unit
import { RECEIPT_STATES, receiptStateOf, receiptStatus } from '../../src/domain/invoices/delivery.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); } };
const J = (x) => JSON.stringify(x);

check('four states, in words', J(RECEIPT_STATES) === J({ queued: 'Queued', sent: 'Sent', delivered: 'Delivered', failed: 'Failed' }));
check('every recorded status maps to one of them (or to nothing when it says nothing about the customer)', ['queued', 'sending', 'pending'].every((s) => receiptStateOf(s) === 'queued') && receiptStateOf('sent') === 'sent'
  && receiptStateOf('delivered') === 'delivered' && receiptStateOf('read') === 'delivered' && receiptStateOf('failed') === 'failed' && receiptStateOf('opened') === null && receiptStateOf('skipped') === null);
check('nothing sent or queued: no state', J(receiptStatus({})) === J({ channels: [], state: '' }));

let R = receiptStatus({ jobs: [{ channel: 'email', status: 'queued', first: 100, t: 100, wait: 'upload' }] });
check('just sold, waiting for the bill to upload: queued (and why)', R.state === 'queued' && R.channels[0].wait === 'upload', R);
R = receiptStatus({ jobs: [{ channel: 'whatsapp', status: 'sent', first: 100, t: 130, to: '+919820000000' }] });
check('the provider accepted it: sent, to whom', R.state === 'sent' && R.channels[0].to === '+919820000000', R);
R = receiptStatus({ jobs: [{ channel: 'whatsapp', status: 'sent', first: 100, t: 130 }], history: [{ id: 'd1', channel: 'whatsapp', status: 'delivered', t: 110, to: '+919820000000' }] });
check('the server heard "delivered" from the provider: delivered (though its record started before the job finished)', R.state === 'delivered' && R.channels[0].state === 'delivered', R);
R = receiptStatus({ jobs: [{ channel: 'whatsapp', status: 'failed', first: 100, t: 120, error: 'Not on WhatsApp' }, { channel: 'sms', status: 'sent', first: 121, t: 140, after: 'whatsapp' }] });
check('WhatsApp failed, the SMS fallback went: the bill\'s receipt is sent; each channel keeps its own state', R.state === 'sent' && J(R.channels.map((c) => [c.channel, c.state])) === J([['whatsapp', 'failed'], ['sms', 'sent']]), R);
R = receiptStatus({ jobs: [{ channel: 'email', status: 'failed', first: 100, t: 120, error: 'No email' }] });
check('the only send failed: failed, with why', R.state === 'failed' && R.channels[0].error === 'No email', R);
R = receiptStatus({ jobs: [{ channel: 'email', status: 'queued', first: 300, t: 300 }], history: [{ id: 'd1', channel: 'email', status: 'failed', t: 200 }] });
check('sent again after a failure: queued again (the device\'s newer word wins)', R.state === 'queued', R);
R = receiptStatus({ history: [{ id: 'd1', channel: 'sms', status: 'sent', t: 100 }, { id: 'd2', channel: 'sms', status: 'failed', t: 50 }] });
check('a channel shows its latest record', R.channels.length === 1 && R.channels[0].state === 'sent');
R = receiptStatus({ history: [{ channel: 'whatsapp', status: 'opened', t: 100 }] });
check('WhatsApp opened on this device (not confirmed): nothing claimed', R.state === '' && !R.channels.length);
R = receiptStatus({ history: [{ channel: 'fax', status: 'sent', t: 100 }] });
check('unknown channels are left out', R.state === '');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
