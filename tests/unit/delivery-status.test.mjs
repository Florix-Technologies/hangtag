// What happens after a provider is handed a receipt. A refusal says whether trying again helps (send-receipt core.js
// failureKind / failureAnswer, from each provider's own error code); Twilio is asked to report back; an email carries the
// shop's logo (inline, and once more without it if the email service turns the picture down). The delivery-status
// function believes a report only with the provider's signature — Meta, Twilio, Resend (Svix), each checked here against
// node:crypto, an implementation of its own — and turns it into the delivery record's change; the app asks about a
// message still "sent" when its bill is opened. Run: npm run test:unit
import crypto from 'node:crypto';
import { LOGO_CID, billMessage, emailLogo, failureAnswer, failureKind, providerConfig } from '../../supabase/functions/send-receipt/core.js';
import { deliver } from '../../supabase/functions/send-receipt/providers/index.js';
import { MAX_BODY, PROVIDERS, callbackUrl, metaChallenge, patchFor, reportsOf, sameText, verifyMeta, verifySvix, verifyTwilio } from '../../supabase/functions/delivery-status/core.js';
import { needsDeliveryCheck } from '../../src/domain/invoices/delivery.js';
import { createReport } from '../helpers/report.mjs';

const R = createReport(), { check } = R;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const calls = [];
const fakeFetch = (...answers) => async (url, opt) => {
  calls.push({ url, opt, body: typeof opt.body === 'string' && opt.body.startsWith('{') ? JSON.parse(opt.body) : opt.body });
  const [status, json, throws] = answers[Math.min(calls.length - 1, answers.length - 1)];
  if (throws) throw new TypeError('network');
  return { ok: status < 400, status, json: async () => json };
};
const env = { RESEND_API_KEY: 're_key', EMAIL_FROM: 'bills@shop.in', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SMS_FROM: '+15550001111',
  WHATSAPP_TOKEN: 'wa', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE: 'bill_ready' };
const STATUS_URL = 'https://proj.supabase.co/functions/v1/delivery-status';

R.section('a refusal: worth trying again, or not');
const refused = async (channel, answer, cfgEnv = env) => { calls.length = 0; const cfg = providerConfig(channel, cfgEnv);
  const r = await deliver(cfg, channel, channel === 'email' ? { to: 'riya@mail.in', subject: 's', text: 't', html: '<p>t</p>' } : { to: '+919845012345', text: 'x', params: ['Riya', 'Shop', 'INV-1', '₹500'] }, fakeFetch(answer));
  return { r, kind: failureKind(cfg.name, r) }; };
let x = await refused('whatsapp', [400, { error: { code: 131026, message: 'Message undeliverable' } }]);
check('WhatsApp (Meta) keeps its error code; 131026 "undeliverable" (not on WhatsApp) → the customer\'s number, final', x.r.code === '131026' && x.kind === 'recipient', x);
x = await refused('whatsapp', [400, { error: { code: 132001, message: 'Template name does not exist in the translation' } }]);
check('...132001 (the template) → the shop\'s set-up', x.kind === 'setup', x);
x = await refused('whatsapp', [400, { error: { code: 131056, message: '(Business Account, Consumer Account) pair rate limit hit' } }]);
check('...131056 (too many to this customer just now) → temporary: tried again later', x.kind === 'temporary', x);
x = await refused('whatsapp', [401, { error: { code: 190, message: 'Error validating access token' } }]);
check('...an expired token (190) → the shop\'s set-up', x.kind === 'setup', x);
x = await refused('sms', [400, { code: 21614, message: "'To' number is not a valid mobile number" }]);
check('Twilio keeps its error code; 21614 (not a mobile) → the customer\'s number', x.r.code === '21614' && x.kind === 'recipient', x);
x = await refused('sms', [400, { code: 21610, message: 'Attempt to send to unsubscribed recipient' }]);
check('...21610 (the customer opted out) → the customer\'s number, final', x.kind === 'recipient', x);
x = await refused('sms', [400, { code: 21608, message: 'The number is unverified. Trial accounts cannot send messages to unverified numbers' }]);
check('...21608 (a trial account) → the shop\'s set-up', x.kind === 'setup', x);
x = await refused('sms', [429, { code: 20429, message: 'Too Many Requests' }]);
check('...429 → temporary', x.kind === 'temporary', x);
x = await refused('email', [422, { name: 'validation_error', message: 'Invalid `to` field. The email address needs to follow the `email@example.com` format.' }]);
check('Resend keeps its error name; an invalid To address → the customer\'s email address', x.r.code === 'validation_error' && x.kind === 'recipient', x);
x = await refused('email', [403, { name: 'validation_error', message: 'The shop.in domain is not verified. Please, add and verify your domain.' }]);
check('...an unverified sending domain → the shop\'s set-up (never blamed on the customer)', x.kind === 'setup', x);
x = await refused('email', [429, { name: 'rate_limit_exceeded', message: 'Too many requests' }]);
check('...rate limited → temporary', x.kind === 'temporary', x);
x = await refused('email', [0, null, true]);
check('the service unreachable → temporary', x.r.status === 0 && x.kind === 'temporary', x);
x = await refused('sms', [503, { message: 'Service Unavailable' }]);
check('a 5xx from the provider → temporary', x.kind === 'temporary', x);
check('no approved template, or no such provider → the set-up, even though nothing was sent (status 0)',
  failureKind('meta', { ok: false, status: 0, code: 'no_template' }) === 'setup' && failureKind('twilio', { ok: false, status: 0, code: 'no_template' }) === 'setup'
  && failureKind('x', (await deliver({ name: 'x' }, 'sms', {}, fakeFetch([200, {}])))) === 'setup');
const A1 = failureAnswer('whatsapp', 'recipient', 'Message undeliverable (131026)'), A2 = failureAnswer('email', 'recipient', 'Invalid `to` field'),
  A3 = failureAnswer('sms', 'setup', 'Template not approved'), A4 = failureAnswer('email', 'temporary', 'Too many requests');
check('the answers: the customer\'s contact → 422 bad_recipient (number / email address), the set-up → 422 provider_setup, temporary → 502 provider_error (the app retries only that)',
  A1.status === 422 && A1.body.error === 'bad_recipient' && /WhatsApp service can't deliver to this customer's number/.test(A1.body.message) && /Check the customer's details/.test(A1.body.message)
  && /customer's email address/.test(A2.body.message) && A3.status === 422 && A3.body.error === 'provider_setup' && /shop owner's attention/.test(A3.body.message)
  && A4.status === 502 && A4.body.error === 'provider_error' && A1.body.status === 'failed', [A1, A2, A3, A4]);

R.section('Twilio reports back');
check('the report address: DELIVERY_STATUS_URL with ?provider=…, the same on both sides', callbackUrl(STATUS_URL, 'twilio') === STATUS_URL + '?provider=twilio'
  && callbackUrl(STATUS_URL + '?a=1', 'twilio') === STATUS_URL + '?a=1&provider=twilio' && callbackUrl('', 'twilio') === '' && callbackUrl('  ', 'meta') === '');
calls.length = 0;
await deliver(providerConfig('sms', { ...env, DELIVERY_STATUS_URL: STATUS_URL }), 'sms', { to: '+919845012345', text: 'Bill' }, fakeFetch([201, { sid: 'SM1' }]));
const f1 = new URLSearchParams(calls[0].body);
calls.length = 0;
await deliver(providerConfig('sms', env), 'sms', { to: '+919845012345', text: 'Bill' }, fakeFetch([201, { sid: 'SM2' }]));
check('with DELIVERY_STATUS_URL set, each Twilio message asks for its report there; without it, none', f1.get('StatusCallback') === STATUS_URL + '?provider=twilio'
  && !new URLSearchParams(calls[0].body).has('StatusCallback'), f1.toString());

R.section('the shop\'s logo on an email');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
check('the logo as the shop prints it: the picture and where it goes (left unless the shop chose)', eq(emailLogo({ data: 'data:image/png;base64,' + PNG }, {}), { base64: PNG, contentType: 'image/png', ext: 'png', align: 'left' })
  && emailLogo({ data: 'data:image/jpeg;base64,' + PNG }, { docLogoAlign: 'right' }).ext === 'jpg' && emailLogo({ data: 'data:image/png;base64,' + PNG }, { docLogoAlign: 'right' }).align === 'right'
  && emailLogo({ data: 'data:image/png;base64,' + PNG }, { docLogoAlign: 'auto' }).align === 'left');
check('none when the shop switched it off, there is none, it isn\'t a picture (SVG, HTML) or it is too big', emailLogo({ data: 'data:image/png;base64,' + PNG }, { docLogo: false }) === null
  && emailLogo(null, {}) === null && emailLogo({ data: 'data:image/svg+xml;base64,' + PNG }, {}) === null && emailLogo({ data: 'data:text/html;base64,' + PNG }, {}) === null
  && emailLogo({ data: 'data:image/png;base64,' + 'A'.repeat(400004) }, {}) === null && emailLogo({ data: 'data:image/png;base64,AA"><script>' }, {}) === null);
const bill = { sale: { id: 's1', bill_no: 'INV-000001', timestamp: Date.parse('2026-10-08T06:30:00Z'), subtotal: 500, discount: 0, total: 500, credit: 0, tax_amount: 0, tax_inclusive: true,
  gst_mode: 'none', round_off: 0, payment_method: 'cash', is_void: false, customer_id: 'c1', customer_name: 'Riya' },
  items: [{ line_no: 0, product_name: 'Tee', variant_label: 'M', quantity: 1, unit_price: 500, discount_amount: 0 }],
  payments: [{ method: 'cash', amount: 500, reference: null, change_given: 0, status: 'completed' }], shop: { shop_name: 'Aura Threads' }, customer: { name: 'Riya' } };
const plain = billMessage('email', bill), withLogo = billMessage('email', { ...bill, logo: emailLogo({ data: 'data:image/png;base64,' + PNG }, { docLogoAlign: 'center' }) });
check('an email with the logo: the picture inline (cid), placed as chosen, attached as that inline picture — and the same email without it kept aside',
  new RegExp(`<img src="cid:${LOGO_CID}"`).test(withLogo.html) && /text-align:center/.test(withLogo.html) && eq(withLogo.attachments, [{ filename: 'logo.png', content: PNG, content_type: 'image/png', content_id: LOGO_CID }])
  && !/cid:/.test(withLogo.plainHtml) && withLogo.plainHtml === plain.html && withLogo.text === plain.text && withLogo.subject === plain.subject, withLogo.attachments);
check('...without a logo: no picture, nothing attached', !/cid:|<img/.test(plain.html) && !plain.attachments && !plain.plainHtml);
const mail = { to: 'riya@mail.in', fromName: 'Aura Threads', ...withLogo };
calls.length = 0;
let r = await deliver(providerConfig('email', env), 'email', mail, fakeFetch([422, { name: 'validation_error', message: 'Invalid attachment' }], [200, { id: 're_2' }]));
check('Resend turns the picture down (422): the same email goes once more without it — sent', r.ok && r.id === 're_2' && calls.length === 2
  && calls[0].body.attachments[0].content_id === LOGO_CID && /cid:/.test(calls[0].body.html) && !calls[1].body.attachments && !/cid:/.test(calls[1].body.html) && calls[1].body.to[0] === 'riya@mail.in', calls.map((c) => Object.keys(c.body)));
calls.length = 0;
r = await deliver(providerConfig('email', env), 'email', mail, fakeFetch([500, { name: 'internal_server_error' }], [200, { id: 're_3' }]));
check('...a 500 isn\'t a refusal of the picture: no second email now (the app\'s queue tries again later)', !r.ok && r.status === 500 && calls.length === 1);
calls.length = 0;
r = await deliver(providerConfig('email', env), 'email', { to: 'riya@mail.in', ...plain }, fakeFetch([422, { name: 'validation_error', message: 'Invalid `to` field' }], [200, { id: 're_4' }]));
check('...an email without a logo refused (422): sent once, refused once (never twice)', !r.ok && calls.length === 1 && !('attachments' in calls[0].body));

R.section('delivery-status: nothing believed without the provider\'s signature');
const META_SECRET = 'app-secret-1', TW_TOKEN = 'tw-token-1', SVIX = 'whsec_' + Buffer.from('resend-signing-key-0123456789').toString('base64');
const metaBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
  statuses: [{ id: 'wamid.A', status: 'delivered', timestamp: '1760000000', recipient_id: '919845012345' }, { id: 'wamid.B', status: 'sent' },
    { id: 'wamid.C', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }, { id: 'wamid.D', status: 'read' }] } }] }] });
const metaSig = 'sha256=' + crypto.createHmac('sha256', META_SECRET).update(metaBody).digest('hex');
check('Meta: X-Hub-Signature-256 over the raw body with the App Secret → believed', await verifyMeta(META_SECRET, metaBody, metaSig) && await verifyMeta(META_SECRET, metaBody, metaSig.toUpperCase().replace('SHA256=', 'sha256=')));
check('...the body changed, another secret, no secret, no or a malformed header → refused', !(await verifyMeta(META_SECRET, metaBody.replace('delivered', 'failed'), metaSig))
  && !(await verifyMeta('other', metaBody, metaSig)) && !(await verifyMeta('', metaBody, metaSig)) && !(await verifyMeta(META_SECRET, metaBody, '')) && !(await verifyMeta(META_SECRET, metaBody, 'sha1=' + metaSig.slice(7))));
check('Meta\'s set-up check: the agreed token gets its challenge back; any other gets nothing', metaChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=tok-9&hub.challenge=1158201444'), 'tok-9') === '1158201444'
  && metaChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1'), 'tok-9') === null && metaChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=&hub.challenge=1'), '') === null
  && metaChallenge({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'tok-9', 'hub.challenge': '1' }, 'tok-9') === null);
const twUrl = callbackUrl(STATUS_URL, 'twilio'), twForm = new URLSearchParams({ MessageSid: 'SM9', MessageStatus: 'undelivered', ErrorCode: '30005', AccountSid: 'AC1', To: '+919845012345', ApiVersion: '2010-04-01' });
const twSig = crypto.createHmac('sha1', TW_TOKEN).update(twUrl + [...twForm.keys()].sort().map((k) => k + twForm.get(k)).join('')).digest('base64');
check('Twilio: X-Twilio-Signature over the address it was given and the fields sorted by name → believed', await verifyTwilio(TW_TOKEN, twUrl, twForm, twSig) && await verifyTwilio(TW_TOKEN, twUrl, Object.fromEntries(twForm), twSig));
check('...a field changed, another address (the server\'s own), another token → refused', !(await verifyTwilio(TW_TOKEN, twUrl, new URLSearchParams({ ...Object.fromEntries(twForm), MessageStatus: 'delivered' }), twSig))
  && !(await verifyTwilio(TW_TOKEN, 'http://localhost:9000/delivery-status?provider=twilio', twForm, twSig)) && !(await verifyTwilio('other', twUrl, twForm, twSig)) && !(await verifyTwilio(TW_TOKEN, twUrl, twForm, '')));
const now = Date.parse('2026-10-08T10:00:00Z'), ts = String(now / 1000), rsBody = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-08T10:00:00.000Z', data: { email_id: 're_2', to: ['riya@mail.in'] } });
const svixSig = (body, t = ts, id = 'msg_1') => 'v1,' + crypto.createHmac('sha256', Buffer.from(SVIX.slice(6), 'base64')).update(`${id}.${t}.${body}`).digest('base64');
const hdr = (sig, t = ts, id = 'msg_1') => new Headers({ 'svix-id': id, 'svix-timestamp': t, 'svix-signature': sig });
check('Resend (Svix): the id, time and body signed with the endpoint\'s secret → believed, also among several signatures', await verifySvix(SVIX, hdr(svixSig(rsBody)), rsBody, now)
  && await verifySvix(SVIX, hdr('v1,AAAA ' + svixSig(rsBody)), rsBody, now) && await verifySvix(SVIX, { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': svixSig(rsBody) }, rsBody, now));
check('...older than 5 minutes (a replay), another body, another message id, another secret → refused', !(await verifySvix(SVIX, hdr(svixSig(rsBody)), rsBody, now + 301e3))
  && !(await verifySvix(SVIX, hdr(svixSig(rsBody)), rsBody.replace('delivered', 'bounced'), now)) && !(await verifySvix(SVIX, hdr(svixSig(rsBody), ts, 'msg_2'), rsBody, now))
  && !(await verifySvix('whsec_' + Buffer.from('another').toString('base64'), hdr(svixSig(rsBody)), rsBody, now)) && !(await verifySvix(SVIX, hdr('v2,' + svixSig(rsBody).slice(3)), rsBody, now)));
check('comparisons: same text only (length and every character)', sameText('abc', 'abc') && !sameText('abc', 'abd') && !sameText('abc', 'abcd') && !sameText('', '') && !sameText(null, null));
check('the three providers, and a body limit', eq(PROVIDERS, ['meta', 'twilio', 'resend']) && MAX_BODY === 262144);

R.section('delivery-status: what a report changes');
check('Meta: delivered and read → Delivered; failed → Failed with WhatsApp\'s reason; sent → nothing', eq(reportsOf('meta', JSON.parse(metaBody)), [
  { provider: 'meta', id: 'wamid.A', state: 'delivered' }, { provider: 'meta', id: 'wamid.C', state: 'failed', error: "WhatsApp couldn't deliver it: Message undeliverable (131026)." },
  { provider: 'meta', id: 'wamid.D', state: 'delivered' }]), reportsOf('meta', JSON.parse(metaBody)));
check('Twilio: undelivered → Failed with its error code; delivered → Delivered; queued / sent → nothing', eq(reportsOf('twilio', twForm), [{ provider: 'twilio', id: 'SM9', state: 'failed', error: "The message couldn't be delivered (Twilio error 30005)." }])
  && eq(reportsOf('twilio', new URLSearchParams('MessageSid=SM1&MessageStatus=delivered')), [{ provider: 'twilio', id: 'SM1', state: 'delivered' }])
  && reportsOf('twilio', new URLSearchParams('MessageSid=SM1&MessageStatus=sent')).length === 0);
check('Resend: email.delivered → Delivered; email.bounced → Failed; opened / delayed → nothing', eq(reportsOf('resend', JSON.parse(rsBody)), [{ provider: 'resend', id: 're_2', state: 'delivered' }])
  && reportsOf('resend', { type: 'email.bounced', data: { email_id: 're_5' } })[0].state === 'failed' && reportsOf('resend', { type: 'email.opened', data: { email_id: 're_5' } }).length === 0
  && reportsOf('resend', { type: 'email.delivery_delayed', data: { email_id: 're_5' } }).length === 0);
check('nonsense reports change nothing (no id, no list, another shape)', reportsOf('meta', { entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] }).length === 0
  && reportsOf('meta', null).length === 0 && reportsOf('meta', { entry: 'x' }).length === 0 && reportsOf('twilio', {}).length === 0 && reportsOf('resend', { type: 'email.delivered' }).length === 0
  && reportsOf('other', JSON.parse(metaBody)).length === 0);
const long = reportsOf('meta', { entry: [{ changes: [{ value: { statuses: [{ id: 'w', status: 'failed', errors: [{ code: 1, title: 'x'.repeat(500) + '\nline' }] }] } }] }] })[0];
check('a provider\'s reason is kept on one line and short enough for the record (300)', long.error.length <= 280 && !/\n/.test(long.error));
const at = Date.parse('2026-10-08T10:00:05Z'), iso = new Date(at).toISOString();
check('the record\'s change: found by provider and message id, only from pending or sent (a delivered receipt never turns failed; a repeat changes nothing more)',
  eq(patchFor({ provider: 'resend', id: 're_2', state: 'delivered' }, at), { match: { provider: 'resend', provider_message_id: 're_2', from: ['pending', 'sent'] }, set: { status: 'delivered', delivered_at: iso, checked_at: iso } })
  && eq(patchFor({ provider: 'twilio', id: 'SM9', state: 'failed', error: 'Twilio error 30005' }, at).set, { status: 'failed', error: 'Twilio error 30005', checked_at: iso })
  && patchFor({ provider: 'meta', id: 'w', state: 'failed' }, at).set.error.length > 0);

R.section('the app asks about a message still "sent" when its bill is opened');
const T = Date.parse('2026-10-08T10:00:00Z'), msg = { id: 'd1', status: 'sent', provider: 'twilio', t: T - 5 * 60e3 };
check('an SMS / WhatsApp through Twilio or an email through Resend, sent over a minute ago and not checked lately → asked', needsDeliveryCheck(msg, T) && needsDeliveryCheck({ ...msg, provider: 'resend' }, T)
  && needsDeliveryCheck({ ...msg, checkedAt: T - 11 * 60e3 }, T));
check('...not: through Meta (it reports by itself), just sent, checked in the last 10 minutes, a week old, already delivered or failed, or only this phone\'s note',
  !needsDeliveryCheck({ ...msg, provider: 'meta' }, T) && !needsDeliveryCheck({ ...msg, t: T - 30e3 }, T) && !needsDeliveryCheck({ ...msg, checkedAt: T - 5 * 60e3 }, T)
  && !needsDeliveryCheck({ ...msg, t: T - 8 * 864e5 }, T) && !needsDeliveryCheck({ ...msg, status: 'delivered' }, T) && !needsDeliveryCheck({ ...msg, status: 'failed' }, T)
  && !needsDeliveryCheck({ ...msg, id: undefined }, T) && !needsDeliveryCheck(null, T));

await R.done();
