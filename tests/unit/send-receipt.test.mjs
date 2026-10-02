// send-receipt Edge Function (supabase/functions/send-receipt): request checks, which providers are set up, who may send,
// who a bill goes to, the messages written from the saved bill, the delivery record, and each provider against a fake
// fetch — never "sent" without the provider's id. Also: provider keys, hosts and the service-role key never appear in
// the app, and the app never sends message text. Run: npm run test:unit
import fs from 'fs';
import path from 'path';
import { CHANNELS, ITEM_COLUMNS, LIMITS, MAX_PER_HOUR, PAYMENT_COLUMNS, PROFILE_COLUMNS, SALE_COLUMNS, allowedToSend, billMessage, billView, configuredChannels, deliveryOutcome, deliveryRow,
  fromName, isEmail, mobileE164, providerConfig, receiptBase, recipientFor, requestedReceiptBase, reservationRow, rupees, validateRequest } from '../../supabase/functions/send-receipt/core.js';
import { deliver } from '../../supabase/functions/send-receipt/providers/index.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- requests ----------
check('channels request', eq(validateRequest({ action: 'channels' }), { ok: true, action: 'channels' }));
check('a send names only the bill and the channel', eq(validateRequest({ action: 'send', channel: 'email', sale_id: ' s1 ' }), { ok: true, action: 'send', channel: 'email', saleId: 's1', auto: false }));
check('message text, HTML, subject or a recipient in a request are ignored (the function writes the message; the customer record is the recipient)',
  eq(validateRequest({ action: 'send', channel: 'email', sale_id: 's1', to: 'x@evil.in', message: { subject: 'Account locked', html: '<a href="https://phish">', text: 'click' } }), { ok: true, action: 'send', channel: 'email', saleId: 's1', auto: false }));
check('bad requests refused', validateRequest(null).status === 400 && validateRequest({ action: 'send', channel: 'fax', sale_id: 's' }).error === 'bad_channel'
  && validateRequest({ action: 'send', channel: 'sms' }).status === 400 && validateRequest({ action: 'send', channel: 'sms', sale_id: 'x'.repeat(LIMITS.saleId + 1) }).status === 400 && validateRequest({ action: 'nope' }).status === 400);
const receiptPage = 'https://shop.example/app/receipt.html';
check('a client cannot choose the receipt page used in customer messages', eq(validateRequest({ action: 'link', sale_id: 's1', receipt_url: receiptPage }), { ok: true, action: 'link', saleId: 's1' })
  && eq(validateRequest({ action: 'send', channel: 'sms', sale_id: 's1', receipt_url: receiptPage }), { ok: true, action: 'send', channel: 'sms', saleId: 's1', auto: false }));
check('receipt page refuses credentials, query/fragment, non-receipt paths and insecure public HTTP', !requestedReceiptBase('https://u:p@shop.example/receipt.html')
  && !requestedReceiptBase('https://shop.example/receipt.html?q=1') && !requestedReceiptBase('https://shop.example/invoice.html')
  && !requestedReceiptBase('http://shop.example/receipt.html') && requestedReceiptBase('http://localhost:4173/receipt.html') === 'http://localhost:4173/receipt.html');
check('only the server-configured receipt URL is used', receiptBase({ RECEIPT_URL: 'https://bills.example/receipt.html' }) === 'https://bills.example/receipt.html'
  && receiptBase({}) === '' && validateRequest({ action: 'link', sale_id: 's1', receipt_url: 'https://evil.test/receipt.html' }).receiptUrl == null);

// ---------- providers set up from secrets ----------
check('nothing set up → every channel off', eq(configuredChannels({}), { email: false, whatsapp: false, sms: false }));
const env = { RESEND_API_KEY: 're_key', EMAIL_FROM: 'bills@shop.in', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SMS_FROM: '+15550001111', WHATSAPP_TOKEN: 'wa', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE: 'bill_ready' };
check('each channel on once its secrets are there', eq(configuredChannels(env), { email: true, whatsapp: true, sms: true }));
check('email needs a From address too; SMS needs a From number', !providerConfig('email', { RESEND_API_KEY: 'k' }) && !providerConfig('sms', { TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b' }));
const twWa = { WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_WHATSAPP_FROM: '+14155238886', TWILIO_WHATSAPP_CONTENT_SID: 'HX0123' };
check('WhatsApp through Twilio when chosen, with its approved template', providerConfig('whatsapp', twWa).whatsapp === true && providerConfig('whatsapp', twWa).contentSid === 'HX0123');
check('WhatsApp without an approved template is not set up (free text a business starts is never delivered)', !providerConfig('whatsapp', { ...env, WHATSAPP_TEMPLATE: '' }) && !providerConfig('whatsapp', { ...twWa, TWILIO_WHATSAPP_CONTENT_SID: '' }));
check('an unknown provider name is not set up', !providerConfig('email', { ...env, EMAIL_PROVIDER: 'mailchimp' }));
check('channels and hourly limit', eq(CHANNELS, ['email', 'whatsapp', 'sms']) && MAX_PER_HOUR === 60);
const u = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'Owner@Shop.in' };
check('who may send: nobody until SEND_ALLOWED_USERS is set (sign-up is open); then the listed accounts, or "*" for all', !allowedToSend(u, {}) && !allowedToSend(null, { SEND_ALLOWED_USERS: '*' })
  && allowedToSend(u, { SEND_ALLOWED_USERS: 'someone@x.in, owner@shop.in' }) && allowedToSend(u, { SEND_ALLOWED_USERS: u.id }) && !allowedToSend(u, { SEND_ALLOWED_USERS: 'someone@x.in' }) && allowedToSend(u, { SEND_ALLOWED_USERS: ' * ' }));

// ---------- recipients ----------
const sale = { id: 's1', customer_name: 'Riya', customer_phone: '98450 12345' };
check('email to the customer record\'s address', recipientFor('email', { customer: { name: 'Riya', email: 'riya@mail.in' }, sale }).to === 'riya@mail.in');
check('SMS / WhatsApp to the customer record\'s mobile as +91…', recipientFor('sms', { customer: { name: 'Riya', phone: '98450 12345' }, sale }).to === '+919845012345' && recipientFor('whatsapp', { customer: { phone: '+91 91234 56789' }, sale }).to === '+919123456789');
check('never the phone copied onto the bill: a customer without a mobile in Customers can\'t be texted', recipientFor('sms', { customer: { name: 'Riya', phone: '' }, sale }).error === 'missing_contact');
check('no saved customer / no email / no mobile → 422 missing_contact', recipientFor('email', { customer: null, sale: { id: 's' } }).status === 422 && recipientFor('sms', { customer: null, sale }).status === 422
  && recipientFor('email', { customer: { name: 'Riya', email: 'not-an-email' }, sale }).error === 'missing_contact'
  && recipientFor('sms', { customer: { name: 'Riya', phone: '12' }, sale: { id: 's', customer_name: 'Riya' } }).message === 'Riya has no mobile number.');
check('phone and email rules', mobileE164('09845012345') === '+919845012345' && mobileE164('5845012345') === '' && isEmail('a@b.co') && !isEmail('a@b') && !isEmail('a b@c.in') && !isEmail('x<y>@z.in'));
check('shop name made safe for the From line', fromName('Aura "Threads" <x>\r\nBcc: y') === 'Aura Threads xBcc: y' && fromName('') === 'Hangtag');

// ---------- the message, written from the saved bill rows ----------
const saleRow = { id: 's1', bill_no: 'INV-260928-004', timestamp: Date.parse('2026-09-28T06:30:00Z'), subtotal: 2498, discount: 249.8, total: 2518, credit: 0, tax_amount: 269.8,
  tax_inclusive: false, gst_mode: 'inter', cgst_amount: 0, sgst_amount: 0, igst_amount: 269.8, round_off: 0, payment_method: 'split', is_void: false, customer_id: 'c1', customer_name: 'Blr Traders' };
const itemRows = [{ line_no: 1, product_name: 'Cap', variant_label: null, color: '', size: '', quantity: 1, unit_price: 500, discount_amount: 0 },
  { line_no: 0, product_name: 'Kurta – Blue', variant_label: 'M', quantity: 2, unit_price: 999, discount_amount: 199.8 }];
const payRows = [{ method: 'cash', amount: 1000, reference: null, change_given: 500, status: 'completed' }, { method: 'upi', amount: 1518, reference: 'UTR998877', change_given: 0, status: 'completed' }];
const shop = { shop_name: 'Aura Threads', address: '12 MG Road', city: 'Pune', state: 'Maharashtra', phone: '9876543210', gstin: '27abcde1234f1z5' };
const bill = { sale: saleRow, items: itemRows, payments: payRows, shop, customer: { name: 'Blr Traders' } };
check('it reads only the columns it needs', /bill_no/.test(SALE_COLUMNS) && /is_void/.test(SALE_COLUMNS) && /product_name/.test(ITEM_COLUMNS) && /change_given/.test(PAYMENT_COLUMNS) && /shop_name/.test(PROFILE_COLUMNS) && !/cost/.test(ITEM_COLUMNS));
check('rupees in Indian format', rupees(2518) === '₹2,518' && rupees(123456.5) === '₹1,23,456.50' && rupees(null) === '₹0');
const V = billView(bill);
check('the bill as saved: lines in order, discounts, IGST, total, each payment and the change (nothing recalculated)', eq(V.lines.map((l) => [l.name, l.detail, l.qty, l.gross, l.discount]), [['Kurta – Blue', 'M', 2, 1998, 199.8], ['Cap', '', 1, 500, 0]])
  && eq(V.rows.map(([l, v]) => l + ' ' + v), ['Subtotal ₹2,498', 'Discount −₹249.80', 'IGST ₹269.80', 'Total ₹2,518', 'Paid by Cash ₹1,000', 'Paid by UPI (ref UTR998877) ₹1,518', 'Change given ₹500'])
  && V.title === 'Tax invoice' && V.number === 'INV-260928-004' && V.shop === 'Aura Threads' && V.contact.includes('GSTIN 27ABCDE1234F1Z5') && /28 Sept? 2026/.test(V.date));
const em = billMessage('email', bill);
check('email: subject with the bill, shop and total; HTML and text with the items, GST and payments', em.subject === 'Your bill INV-260928-004 from Aura Threads — ₹2,518' && /Kurta – Blue/.test(em.html) && /IGST/.test(em.html)
  && /Paid by UPI \(ref UTR998877\)/.test(em.html) && /Hello Blr Traders/.test(em.text) && /Total: ₹2,518/.test(em.text));
const evil = billMessage('email', { ...bill, items: [{ ...itemRows[0], product_name: '<script>alert(1)</script>' }], shop: { shop_name: 'A&B <b>' }, customer: { name: '"><img src=x>' } });
check('email HTML escapes every saved text (items, shop, customer)', !/<script>|<img/.test(evil.html) && evil.html.includes('&lt;script&gt;') && evil.html.includes('A&amp;B &lt;b&gt;') && evil.html.includes('&quot;&gt;&lt;img'));
const sms = billMessage('sms', bill).text;
check('SMS: one short confirmation with the bill, total and how it was paid', sms.length <= LIMITS.sms && sms === 'Aura Threads: Bill INV-260928-004 for ₹2,518, paid by Cash ₹1,000 + UPI ₹1,518. Thank you for shopping with us!');
const waMsg = billMessage('whatsapp', bill);
check('WhatsApp: the template values {{1}} customer {{2}} shop {{3}} bill {{4}} amount, and the bill as text', eq(waMsg.params, ['Blr Traders', 'Aura Threads', 'INV-260928-004', '₹2,518']) && /\*Aura Threads\*/.test(waMsg.text) && waMsg.text.length <= LIMITS.whatsapp);
const legacySale = { ...saleRow, gst_mode: null, igst_amount: null, tax_amount: 48, tax_inclusive: true, subtotal: 1050, discount: 50, total: 1000, payment_method: 'card' };
check('a bill from before split payments / GST split: its one payment and GST as saved', eq(billView({ ...bill, sale: legacySale, payments: [] }).rows.map(([l, v]) => l + ' ' + v), ['Subtotal ₹1,050', 'Discount −₹50', 'GST (included) ₹48', 'Total ₹1,000', 'Paid by Card ₹1,000']));
check('nothing to pay (100% discount) is not called exchange credit; a covered exchange is', /nothing to pay/.test(billMessage('sms', { ...bill, sale: { ...saleRow, total: 0 }, payments: [] }).text)
  && /covered by your exchange credit/.test(billMessage('sms', { ...bill, sale: { ...saleRow, credit: 2518 }, payments: [] }).text)
  && eq(billView({ ...bill, sale: { ...saleRow, credit: 518 }, payments: [{ method: 'upi', amount: 2000, status: 'completed' }] }).rows.slice(4, 7).map(([l]) => l), ['Exchange credit', 'Amount paid', 'Paid by UPI']));
check('cancelled payments are left out; a huge bill lists the first 200 items and says how many more', billView({ ...bill, payments: [{ ...payRows[0], status: 'cancelled' }, payRows[1]] }).rows.filter(([l]) => /^Paid by/.test(l)).length === 1
  && (() => { const big = billView({ ...bill, items: Array.from({ length: 230 }, (_, k) => ({ ...itemRows[1], line_no: k })) }); return big.lines.length === 200 && big.more === 30 && /… and 30 more items/.test(billMessage('email', { ...bill, items: Array.from({ length: 230 }, (_, k) => ({ ...itemRows[1], line_no: k })) }).text); })());

// ---------- the delivery record: never "sent" without the provider's id ----------
check('an attempt is first recorded as pending (it counts toward the hourly limit before anything is sent)', eq(reservationRow({ ownerId: 'u', saleId: 's', channel: 'sms', to: '+91', provider: 'twilio' }),
  { owner_id: 'u', sale_id: 's', channel: 'sms', recipient: '+91', status: 'pending', provider: 'twilio', mode: 'manual' }));
check('…and finished as sent only with the provider\'s id', eq(deliveryOutcome({ ok: true, id: 'SM1' }), { status: 'sent', provider_message_id: 'SM1', error: null }) && deliveryOutcome({ ok: true }).status === 'failed' && deliveryOutcome(null).status === 'failed');
check('sent with the provider id', eq(deliveryRow({ ownerId: 'u', saleId: 's', channel: 'sms', to: '+91', provider: 'twilio', result: { ok: true, id: 'SM1' } }),
  { owner_id: 'u', sale_id: 's', channel: 'sms', recipient: '+91', status: 'sent', provider: 'twilio', mode: 'manual', provider_message_id: 'SM1', error: null }));
check('ok without an id is recorded as failed', deliveryRow({ ownerId: 'u', saleId: 's', channel: 'sms', to: '+91', provider: 'twilio', result: { ok: true } }).status === 'failed');
check('failure keeps the provider\'s reason (cut to 300)', (() => { const r = deliveryRow({ ownerId: 'u', saleId: 's', channel: 'email', to: 'a@b.in', provider: 'resend', result: { ok: false, message: 'x'.repeat(400) } }); return r.status === 'failed' && r.error.length === 300 && r.provider_message_id === null; })());

// ---------- providers (fake fetch) ----------
const calls = [];
const fakeFetch = (status, json, throws) => async (url, opt) => { calls.push({ url, opt }); if (throws) throw new TypeError('network'); return { ok: status < 400, status, json: async () => json }; };
const email = { to: 'riya@mail.in', subject: 'Your bill', html: '<p>Bill</p>', text: 'Bill', fromName: 'Aura Threads' };
let r = await deliver(providerConfig('email', env), 'email', email, fakeFetch(200, { id: 're_123' }));
const body = JSON.parse(calls[0].opt.body);
check('Resend: POST with the key, From named after the shop, the customer as To; sent with its id', r.ok && r.id === 're_123' && calls[0].url === 'https://api.resend.com/emails'
  && calls[0].opt.headers.Authorization === 'Bearer re_key' && body.from === 'Aura Threads <bills@shop.in>' && eq(body.to, ['riya@mail.in']) && body.html === '<p>Bill</p>');
r = await deliver(providerConfig('email', env), 'email', email, fakeFetch(422, { message: 'The from address is not verified' }));
check('Resend refused → not sent, its reason kept', !r.ok && r.status === 422 && /not verified/.test(r.message));
r = await deliver(providerConfig('email', env), 'email', email, fakeFetch(200, {}));
check('Resend 200 without an id → not sent', !r.ok);
r = await deliver(providerConfig('email', env), 'email', email, fakeFetch(0, null, true));
check('email service unreachable → not sent', !r.ok && /couldn't be reached/.test(r.message));
calls.length = 0;
r = await deliver(providerConfig('sms', env), 'sms', { to: '+919845012345', text: 'Bill INV-1' }, fakeFetch(201, { sid: 'SM123', status: 'queued' }));
const form = new URLSearchParams(calls[0].opt.body);
check('Twilio SMS: basic auth, From, To, Body; sent with its SID', r.ok && r.id === 'SM123' && calls[0].url === 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json'
  && calls[0].opt.headers.Authorization === 'Basic ' + Buffer.from('AC1:tok').toString('base64') && form.get('To') === '+919845012345' && form.get('From') === '+15550001111' && form.get('Body') === 'Bill INV-1');
calls.length = 0;
await deliver(providerConfig('sms', { ...env, TWILIO_SMS_FROM: 'MG0123456789abcdef0123456789abcdef' }), 'sms', { to: '+919845012345', text: 'x' }, fakeFetch(201, { sid: 'SM1' }));
check('Twilio Messaging Service SID is used as a service, not a number', new URLSearchParams(calls[0].opt.body).get('MessagingServiceSid') === 'MG0123456789abcdef0123456789abcdef');
r = await deliver(providerConfig('sms', env), 'sms', { to: '+919845012345', text: 'x' }, fakeFetch(201, { sid: 'SM2', status: 'failed' }));
check('Twilio "failed" status → not sent', !r.ok);
r = await deliver(providerConfig('sms', env), 'sms', { to: '+919845012345', text: 'x' }, fakeFetch(400, { message: 'The To number is not a valid mobile number' }));
check('Twilio refused → not sent, reason kept', !r.ok && /not a valid/.test(r.message));
calls.length = 0;
await deliver(providerConfig('whatsapp', twWa), 'whatsapp', { to: '+919845012345', text: 'x', params: ['Riya', 'Aura', 'INV-1', '₹500'] }, fakeFetch(201, { sid: 'SM3' }));
const twf = new URLSearchParams(calls[0].opt.body);
check('Twilio WhatsApp: whatsapp: prefixes, the approved template and its values, no free text', twf.get('To') === 'whatsapp:+919845012345' && twf.get('From') === 'whatsapp:+14155238886'
  && twf.get('ContentSid') === 'HX0123' && eq(JSON.parse(twf.get('ContentVariables')), { 1: 'Riya', 2: 'Aura', 3: 'INV-1', 4: '₹500' }) && !twf.has('Body'));
calls.length = 0;
await deliver(providerConfig('whatsapp', { ...twWa, TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886' }), 'whatsapp', { to: '+919845012345', params: [] }, fakeFetch(201, { sid: 'SM4' }));
check('a Twilio WhatsApp sender already written as whatsapp:+1… isn\'t prefixed twice', new URLSearchParams(calls[0].opt.body).get('From') === 'whatsapp:+14155238886');
calls.length = 0;
r = await deliver(providerConfig('whatsapp', env), 'whatsapp', { to: '+919845012345', text: 'Bill', params: ['Riya', 'Aura', 'INV-1', '₹500'] }, fakeFetch(200, { messages: [{ id: 'wamid.1' }] }));
const wa = JSON.parse(calls[0].opt.body);
check('Meta WhatsApp: the approved template with the bill\'s values; sent with its id', r.ok && r.id === 'wamid.1' && calls[0].url === 'https://graph.facebook.com/v21.0/123/messages' && wa.to === '919845012345'
  && wa.type === 'template' && wa.template.name === 'bill_ready' && eq(wa.template.components[0].parameters.map((p) => p.text), ['Riya', 'Aura', 'INV-1', '₹500']));
calls.length = 0;
r = await deliver({ ...providerConfig('whatsapp', env), template: '' }, 'whatsapp', { to: '+919845012345', text: 'Bill text' }, fakeFetch(200, { messages: [{ id: 'wamid.2' }] }));
check('Meta WhatsApp never sends free text (not delivered): without a template nothing is sent', !r.ok && calls.length === 0);
r = await deliver(providerConfig('whatsapp', env), 'whatsapp', { to: '+919845012345', text: 'x' }, fakeFetch(400, { error: { message: 'Template name does not exist' } }));
check('Meta refused → not sent, reason kept', !r.ok && /does not exist/.test(r.message));
r = await deliver({ name: 'pigeon' }, 'sms', { to: '+91', text: 'x' }, fakeFetch(200, {}));
check('an unknown provider never sends', !r.ok);

// ---------- no provider secrets or hosts in the app ----------
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../..');
const walk = (d) => fs.readdirSync(d).flatMap((f) => { const p = path.join(d, f); return fs.statSync(p).isDirectory() ? walk(p) : /\.(js|html)$/.test(f) ? [p] : []; });
const app = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'index.html'), path.join(ROOT, 'config.js')].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
check('the app never talks to a messaging provider directly or holds its keys', !/api\.resend\.com|api\.twilio\.com|graph\.facebook\.com|RESEND_API_KEY|TWILIO_AUTH_TOKEN|WHATSAPP_TOKEN/.test(app));
check('the app never writes the message: the send request carries no text, HTML or subject', !/message:\s*messageFor|message-templates/.test(app)
  && /send\(\{\s*channel,\s*saleId,\s*auto\s*\}\)/.test(fs.readFileSync(path.join(ROOT, 'src/infrastructure/messaging/delivery-client.js'), 'utf8'))
  && /sendReceipt\(\{ channel, sale_id: saleId, \.\.\.\(auto \? \{ auto: true \} : \{\}\) \}\)/.test(fs.readFileSync(path.join(ROOT, 'src/infrastructure/messaging/delivery-client.js'), 'utf8')));
const fn = fs.readFileSync(path.join(ROOT, 'supabase/functions/send-receipt/index.ts'), 'utf8');
check('the function takes a place under the limit before sending, counts it, and fails closed', fn.indexOf('reservationRow(') < fn.indexOf('count: "exact"') && fn.indexOf('count: "exact"') < fn.indexOf('await deliver(')
  && /countErr \|\| count == null/.test(fn) && /saleErr\) \{[^}]*unavailable\(\)/.test(fn) && /custErr\) \{[^}]*unavailable\(\)/.test(fn) && /count > MAX_PER_HOUR/.test(fn) && /billMessage\(r\.channel/.test(fn) && !/body\.message|\.\.\.r\.message/.test(fn));
check('the service-role key is only used inside the Edge Function', !/SERVICE_ROLE|service_role/.test(app) && /SUPABASE_SERVICE_ROLE_KEY/.test(fs.readFileSync(path.join(ROOT, 'supabase/functions/send-receipt/index.ts'), 'utf8')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
