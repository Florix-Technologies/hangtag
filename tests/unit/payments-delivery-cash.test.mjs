// Verified payments (UPI QR / card link through the payment provider, hand-checked UPI, card machine), automatic receipt
// delivery (once per channel, retries, SMS fallback, secure invoice links, delivery status), cash without a bill and day
// close, GST filing preparation for a month (sections, checks, Excel / PDF / JSON), cancelling with a reason.
// Run: npm run test:unit
import { createHmac } from 'crypto';
import { checkLast4, checkReference, isUnverified, looksLikeCardNumber, paymentsOf, settlePayments, verificationOf } from '../../src/domain/sales/payments.js';
import { checkVpa, upiPayUri } from '../../src/domain/sales/upi.js';
import * as PG from '../../supabase/functions/payment-gateway/core.js';
import * as SR from '../../supabase/functions/send-receipt/core.js';
import { autoDeliveryPlan, nextAttemptAt, MAX_ATTEMPTS } from '../../src/domain/invoices/delivery.js';
import { INVOICE_STATUS } from '../../src/domain/invoices/invoice.js';
import { bankBook, cashBook, financialTransactions } from '../../src/domain/finance/books.js';
import { changedAfterClose, checkCashMove, checkExpenseCats, dayClose, moveDirection } from '../../src/domain/finance/cash-moves.js';
import { docSeries, filingSections, gstDigest, gstr1Json, monthRange, splitDocNo } from '../../src/domain/gst/filing.js';
import { gstReport } from '../../src/domain/gst/gst-report.js';
import { crc32, xlsxBytes } from '../../src/shared/utils/xlsx.js';
import { pdfBytes } from '../../src/shared/utils/pdf.js';
import { checkGstSettings, checkPaymentSettings } from '../../src/domain/shop/settings-validation.js';
import { cashMoveRow, dayCloseRow, paymentRows, rowToCashMove, rowToDayClose, rowToPayment } from '../../src/infrastructure/supabase/mappers.js';
import { createLocalFirstCashRepository } from '../../src/infrastructure/repositories/local-first-cash-repository.js';
import { AppError, ERROR_CODES as C } from '../../src/shared/errors/app-error.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const eq = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

// ---------- payments: verification, references, never a card number ----------
{
  check('a card number (13-19 digits passing Luhn) is recognised; a 12-digit UPI reference is not', looksLikeCardNumber('4111 1111 1111 1111') && looksLikeCardNumber('5500-0000-0000-0004') && !looksLikeCardNumber('412345678901') && !looksLikeCardNumber('4111111111111112'));
  check('a reference that looks like a card number is refused', !!checkReference('4111111111111111').error && !checkReference('UTR412345678901'));
  check('last 4 digits only: exactly 4 digits', !checkLast4('') && !checkLast4('4242') && !!checkLast4('424').error && !!checkLast4('42424').error && !!checkLast4('ab12').error);
  let S = settlePayments(500, [{ method: 'upi', amount: 500 }]);
  check('UPI checked by hand needs the cashier to mark the payment received', S.error && S.field === 'confirmed' && /Mark the UPI payment received/.test(S.error), S);
  S = settlePayments(500, [{ method: 'upi', amount: 500, confirmed: true }]);
  check('the UTR is optional; an explicitly received manual UPI payment is saved unverified', S.ok && S.payments[0].verification === 'unverified' && S.payments[0].via === 'manual' && !('ref' in S.payments[0]), S);
  S = settlePayments(500, [{ method: 'upi', amount: 500, ref: '412345678901', confirmed: true }]);
  check('an optional UTR is kept when entered', S.ok && S.payments[0].ref === '412345678901');
  S = settlePayments(800, [{ method: 'card', amount: 800 }]);
  check('card on a card machine: marked received (or its approval number typed) before the sale completes; never a required reference', S.error && S.field === 'confirmed' && /card machine/.test(S.error)
    && settlePayments(800, [{ method: 'card', amount: 800, confirmed: true }]).ok && settlePayments(800, [{ method: 'card', amount: 800, confirmed: true }]).payments[0].verification === 'recorded');
  S = settlePayments(800, [{ method: 'card', amount: 800, ref: 'APPR77', last4: '4242' }]);
  check('…then it is "recorded", with the last 4 digits kept and nothing else', S.ok && S.payments[0].verification === 'recorded' && S.payments[0].last4 === '4242' && S.payments[0].via === 'terminal');
  S = settlePayments(800, [{ method: 'card', amount: 800, ref: 'APPR77', last4: '4242424242424242' }]);
  check('a full card number in the last-4 box is refused', S.error && S.field === 'last4');
  const I = { id: 'i1', status: 'pending', amount: 500, reference: 'qr_1' };
  S = settlePayments(500, [{ method: 'upi', amount: 500, via: 'qr', intent: I }]);
  check('a QR on screen pays nothing: the part waits for the provider', S.error && S.field === 'intent' && /confirmed/.test(S.error));
  S = settlePayments(500, [{ method: 'upi', amount: 500, via: 'qr', intent: { ...I, status: 'verified', amount: 400, paymentId: 'pay_1' } }]);
  check('a verified payment of another amount doesn\'t pay the part', S.error && S.field === 'intent' && /400/.test(S.error));
  S = settlePayments(500, [{ method: 'upi', amount: 500, via: 'qr', intent: { ...I, status: 'verified', paymentId: 'pay_1' } }]);
  check('verified by the provider: the part is "verified" with the intent and the provider\'s payment id', S.ok && eq([S.payments[0].verification, S.payments[0].intent, S.payments[0].providerRef, S.payments[0].ref], ['verified', 'i1', 'pay_1', 'pay_1']), S);
  S = settlePayments(1500, [{ method: 'cash', amount: 700, received: 1000 }, { method: 'upi', amount: 800, via: 'qr', intent: { ...I, amount: 800, status: 'verified', paymentId: 'pay_2' } }]);
  check('split: cash (recorded, with change) + verified UPI', S.ok && S.change === 300 && eq(S.payments.map((p) => p.verification), ['recorded', 'verified']));
  S = settlePayments(500, [{ method: 'upi', amount: 500, via: 'bank' }]);
  check('an unknown way of taking UPI is refused', S.error && S.field === 'via');
  const legacy = { id: 's0', total: 700, pay: 'upi' };
  check('bills saved before verification count as recorded (not relabelled unverified)', verificationOf(paymentsOf(legacy)[0]) === 'recorded' && !isUnverified(legacy));
  check('a bill with hand-checked UPI is labelled unverified (not when cancelled)', isUnverified({ payments: [{ method: 'upi', amount: 1, verification: 'unverified' }] }) && !isUnverified({ void: true, payments: [{ method: 'upi', amount: 1, verification: 'unverified' }] }));
  check('shop UPI ID: name@bank', !checkVpa('') && !checkVpa('myshop@okaxis') && !!checkVpa('myshop').error && !!checkVpa('a b@x').error);
  const uri = upiPayUri({ vpa: 'myshop@okaxis', name: 'Riya Boutique', amount: 1890, note: 'Bill INV-1' });
  check('static UPI QR carries the exact amount', uri === 'upi://pay?pa=myshop%40okaxis&pn=Riya%20Boutique&am=1890.00&cu=INR&tn=Bill%20INV-1' && upiPayUri({ vpa: 'x', amount: 5 }) === '' && upiPayUri({ vpa: 'a@b', amount: 0 }) === '', uri);
}

// ---------- payment-gateway (Edge Function core) ----------
{
  const env = { RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 's3cret', PAYMENT_ALLOWED_USERS: 'shop@x.in' };
  const cfg = PG.razorpayConfig(env);
  check('provider set up only with both keys; the card link can be turned off', !!cfg && cfg.cardLink && !PG.razorpayConfig({ RAZORPAY_KEY_ID: 'x' }) && !PG.razorpayConfig({ ...env, PAYMENT_CARD_LINK: 'off' }).cardLink);
  check('only the accounts named may take provider payments (unset = off)', PG.allowedToPay({ id: 'u1', email: 'shop@x.in' }, env) && !PG.allowedToPay({ id: 'u2', email: 'x@y.z' }, env) && !PG.allowedToPay({ id: 'u1' }, {}) && PG.allowedToPay({ id: 'u9' }, { PAYMENT_ALLOWED_USERS: '*' }));
  check('config: all off unless set up and allowed; keys never in the answer', eq(PG.configView(cfg, false), { ok: true, provider: null, upi: false, cardLink: false }) && eq(PG.configView(cfg, true), { ok: true, provider: 'razorpay', upi: true, cardLink: true }) && !JSON.stringify(PG.configView(cfg, true)).includes('s3cret'));
  let v = PG.validateRequest({ action: 'create', method: 'upi', amount: 1890.5, sale_id: 's1', note: 'Bill <INV-1>', expiry_min: 99 });
  check('create: amount, bill id, note cleaned, expiry kept within 2-30 minutes', v.ok && v.amount === 1890.5 && v.note === 'Bill INV-1' && v.expiryMin === 30);
  check('create refuses a bad amount, method or missing bill', !PG.validateRequest({ action: 'create', method: 'upi', amount: 0, sale_id: 's1' }).ok && !PG.validateRequest({ action: 'create', method: 'upi', amount: 1.001, sale_id: 's1' }).ok
    && !PG.validateRequest({ action: 'create', method: 'cash', amount: 1, sale_id: 's1' }).ok && !PG.validateRequest({ action: 'create', method: 'upi', amount: 1 }).ok);
  check('refund of a return: needs the return id', PG.validateRequest({ action: 'refund_return', return_id: 'r1' }).returnId === 'r1' && !PG.validateRequest({ action: 'refund_return' }).ok);
  check('status / cancel need an intent id; verify needs the bill and its reference', !PG.validateRequest({ action: 'status', id: 'x' }).ok && PG.validateRequest({ action: 'status', id: '0b8e1f3e-1111-4111-8111-111111111111' }).ok
    && PG.validateRequest({ action: 'verify', sale_id: 's1', reference: '4123' }).paymentId === 's1:upi' && !PG.validateRequest({ action: 'verify', sale_id: 's1' }).ok);
  const now = 1_800_000_000_000;
  const qb = PG.createQrBody({ amount: 1890, note: 'Bill INV-1', closeBy: now + 300000, intentId: 'i1', saleId: 's1' });
  check('UPI QR: single use, fixed amount in paise, closes at the expiry', qb.type === 'upi_qr' && qb.usage === 'single_use' && qb.fixed_amount === true && qb.payment_amount === 189000 && qb.close_by === (now + 300000) / 1000 && qb.notes.sale_id === 's1');
  const lb = PG.createLinkBody({ amount: 800, note: 'Bill INV-2', expireBy: PG.expiresAt('card', 5, now), intentId: '0b8e1f3e-1111-4111-8111-111111111111', saleId: 's2' });
  check('card link: exact amount, no partial payment, card only, at least 16 minutes open', lb.amount === 80000 && lb.accept_partial === false && lb.options.checkout.method.card === '1' && lb.options.checkout.method.upi === '0' && lb.expire_by === (now + 16 * 60000) / 1000 && lb.reference_id.length <= 40);
  check('QR states: active = pending; paid (by payments or amount received) = paid; closed on demand = cancelled; past its time = expired',
    PG.qrView({ id: 'q', status: 'active', close_by: now / 1000 + 60 }, [], now).state === 'pending'
    && PG.qrView({ id: 'q', status: 'active', payments_amount_received: 189000 }, [], now).state === 'paid'
    && PG.qrView({ id: 'q', status: 'closed', close_reason: 'paid' }, [{ id: 'pay_1', amount: 189000, status: 'captured', method: 'upi', acquirer_data: { rrn: '412345678901' } }], now).paymentId === 'pay_1'
    && PG.qrView({ id: 'q', status: 'closed', close_reason: 'on_demand' }, [], now).state === 'cancelled'
    && PG.qrView({ id: 'q', status: 'active', close_by: now / 1000 - 1 }, [], now).state === 'expired' && PG.qrView(null).state === 'failed');
  check('link states: paid / expired / cancelled / pending', PG.linkView({ id: 'l', status: 'paid', amount_paid: 80000, payments: [{ payment_id: 'pay_9', amount: 80000, status: 'captured', method: 'card' }] }, now).paymentId === 'pay_9'
    && PG.linkView({ id: 'l', status: 'expired' }, now).state === 'expired' && PG.linkView({ id: 'l', status: 'cancelled' }, now).state === 'cancelled' && PG.linkView({ id: 'l', status: 'created', expire_by: now / 1000 + 60 }, now).state === 'pending');
  const pend = { status: 'pending', amount: 1890, method: 'upi' }, paid = { state: 'paid', paid: 189000, paymentId: 'pay_1', method: 'upi' };
  check('the exact amount paid on an open intent → verified', eq(PG.nextIntent(pend, paid), { status: 'verified', paid_amount: 1890, provider_payment_id: 'pay_1' }));
  check('a different amount → unmatched (never verified)', PG.nextIntent(pend, { ...paid, paid: 100000 }).status === 'unmatched');
  check('paid after it was cancelled or expired → unmatched receipt', PG.nextIntent({ ...pend, status: 'cancelled' }, paid).status === 'unmatched' && PG.nextIntent({ ...pend, status: 'expired' }, paid).status === 'unmatched');
  check('the same confirmation twice changes nothing the second time', PG.nextIntent({ ...pend, status: 'verified' }, paid) === null && PG.nextIntent({ ...pend, status: 'unmatched' }, paid) === null);
  check('pending → expired / cancelled; nothing new → no change', PG.nextIntent(pend, { state: 'expired' }).status === 'expired' && PG.nextIntent(pend, { state: 'pending' }) === null && PG.nextIntent({ ...pend, status: 'verified' }, { state: 'expired' }) === null);
  check('a card link paid by another method is not a verified card payment', PG.nextIntent({ status: 'pending', amount: 800, method: 'card' }, { state: 'paid', paid: 80000, method: 'upi' }).status === 'unmatched');
  const pays = [{ id: 'pay_a', method: 'upi', status: 'captured', amount: 70000, acquirer_data: { rrn: '412345678901' } }, { id: 'pay_b', method: 'upi', status: 'captured', amount: 70000, acquirer_data: { rrn: '499999999999' } }, { id: 'pay_c', method: 'card', status: 'captured', amount: 70000 }];
  check('a hand-checked UPI payment matches the provider\'s by amount and bank reference only', PG.matchManual(pays, { amount: 700, reference: '412345678901' }).id === 'pay_a' && PG.matchManual(pays, { amount: 701, reference: '412345678901' }) === null && PG.matchManual(pays, { amount: 700, reference: '1111' }) === null && PG.matchManual(pays, { amount: 700, reference: '' }) === null);
  const body = JSON.stringify({ event: 'qr_code.credited', payload: { qr_code: { entity: { id: 'qr_1', status: 'closed', close_reason: 'paid', payments_amount_received: 189000 } }, payment: { entity: { id: 'pay_1', amount: 189000, status: 'captured', method: 'upi' } } } });
  const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
  check('webhook signature: HMAC-SHA256 of the raw body with the secret', await PG.verifySignature(body, sig, 'whsec') && !(await PG.verifySignature(body, sig, 'other')) && !(await PG.verifySignature(body + ' ', sig, 'whsec')) && !(await PG.verifySignature(body, '', 'whsec')));
  const tgt = PG.webhookTarget(JSON.parse(body), now);
  check('webhook: which QR and what it says', tgt.kind === 'qr' && tgt.providerIntentId === 'qr_1' && tgt.view.state === 'paid' && tgt.view.paymentId === 'pay_1');
  const lt = PG.webhookTarget({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', status: 'paid', amount_paid: 80000 } }, payment: { entity: { id: 'pay_9', amount: 80000, status: 'captured', method: 'card' } } } }, now);
  check('webhook: a paid card link', lt.kind === 'link' && lt.view.state === 'paid' && lt.view.paymentId === 'pay_9' && PG.webhookTarget({ event: 'order.paid', payload: {} }) === null);
  const R = PG.intentReply({ id: 'i', method: 'upi', kind: 'qr', status: 'pending', amount: '1890.00', reference: 'qr_1', qr_url: 'https://rzp.io/q', expires_at: new Date(now).toISOString(), provider_response: { secret: 1 } });
  check('the app\'s view of an intent: no provider response inside', R.amount === 1890 && R.qrUrl === 'https://rzp.io/q' && R.expiresAt === now && !('provider_response' in R));
}

// ---------- send-receipt: auto (once), secure links, delivery status ----------
{
  check('send: auto is kept; refresh and link need a bill', SR.validateRequest({ action: 'send', channel: 'sms', sale_id: 's1', auto: true }).auto === true && SR.validateRequest({ action: 'send', channel: 'sms', sale_id: 's1' }).auto === false
    && SR.validateRequest({ action: 'refresh', sale_id: 's1' }).ok && !SR.validateRequest({ action: 'link' }).ok);
  check('the reservation row says whether it went by itself', SR.reservationRow({ ownerId: 'o', saleId: 's', channel: 'sms', to: '+91', provider: 'twilio', auto: true }).mode === 'auto' && SR.reservationRow({ ownerId: 'o', saleId: 's', channel: 'sms', to: '+91' }).mode === 'manual');
  const tok = SR.newToken();
  check('invoice link token: 43 unguessable URL-safe characters (fresh each time)', /^[A-Za-z0-9_-]{43}$/.test(tok) && tok !== SR.newToken());
  check('RECEIPT_URL must be https without a query; the token goes after "#"', SR.receiptBase({ RECEIPT_URL: 'https://shop.example/receipt.html' }) === 'https://shop.example/receipt.html' && SR.receiptBase({ RECEIPT_URL: 'http://x/r' }) === '' && SR.receiptBase({}) === ''
    && SR.linkUrl('https://s/r.html', 'abc') === 'https://s/r.html#abc' && SR.linkUrl('', 'abc') === '');
  const row = SR.linkRow({ ownerId: 'o', saleId: 's1', token: tok, now: 0 });
  check('a link lives 12 months; revoked or expired links don\'t work', Date.parse(row.expires_at) === 366 * 864e5 && SR.liveLink(row, 1) && !SR.liveLink({ ...row, revoked_at: 'x' }, 1) && !SR.liveLink(row, 367 * 864e5));
  const data = { sale: { bill_no: 'INV-250925-004', total: 1890, payment_method: 'upi', timestamp: 0 }, items: [], payments: [{ method: 'upi', amount: 1890 }], shop: { shop_name: 'Riya Boutique' } };
  const link = 'https://shop.example/receipt.html#' + tok;
  const sms = SR.billMessage('sms', { ...data, link }).text;
  check('SMS: shop, bill number, amount and the secure link, in one message', sms.includes('Riya Boutique') && sms.includes('INV-250925-004') && sms.includes('₹1,890') && sms.endsWith(link) && sms.length <= SR.LIMITS.sms, sms);
  const long = SR.billMessage('sms', { ...data, shop: { shop_name: 'X'.repeat(400) }, link }).text;
  check('…a long shop name is shortened, the link kept whole', long.length <= SR.LIMITS.sms && long.endsWith(link));
  check('SMS without a link keeps the thank-you', SR.billMessage('sms', data).text.endsWith('Thank you for shopping with us!'));
  const wa = SR.billMessage('whatsapp', { ...data, link, linkParam: true });
  check('WhatsApp: the link in the text, and as the 5th template value only when the template has it', wa.text.includes(link) && wa.params.length === 5 && wa.params[4] === link && SR.billMessage('whatsapp', { ...data, link }).params.length === 4);
  check('delivery status: Twilio delivered / undelivered; Resend delivered / bounced; otherwise nothing new', SR.providerStatus('twilio', { status: 'delivered' }) === 'delivered' && SR.providerStatus('twilio', { status: 'undelivered' }) === 'failed'
    && SR.providerStatus('twilio', { status: 'sent' }) === null && SR.providerStatus('resend', { last_event: 'delivered' }) === 'delivered' && SR.providerStatus('resend', { last_event: 'bounced' }) === 'failed' && SR.providerStatus('meta', { status: 'delivered' }) === null);
}

// ---------- automatic delivery rules ----------
{
  const inv = (buyer) => ({ status: INVOICE_STATUS.VALID, buyer });
  const both = { name: 'Riya', mobile: '9876543210', email: 'riya@mail.in' };
  check('WhatsApp on (with SMS as its fallback) + email', eq(autoDeliveryPlan(inv(both), { whatsapp: true, sms: true, email: true }), [{ channel: 'whatsapp', fallback: 'sms' }, { channel: 'email' }]));
  check('WhatsApp off: SMS', eq(autoDeliveryPlan(inv(both), { sms: true }), [{ channel: 'sms' }]));
  check('a channel the server can\'t send is left out', eq(autoDeliveryPlan(inv(both), { whatsapp: true, sms: true }, { whatsapp: false, sms: true }), [{ channel: 'sms' }]));
  check('no mobile: no WhatsApp/SMS; no email: no email; walk-in or cancelled: nothing', eq(autoDeliveryPlan(inv({ name: 'A', mobile: '', email: 'a@b.co' }), { whatsapp: true, sms: true, email: true }), [{ channel: 'email' }])
    && eq(autoDeliveryPlan(inv({ name: 'A', mobile: '9876543210', email: '' }), { email: true }), []) && eq(autoDeliveryPlan(inv(null), { sms: true }), []) && eq(autoDeliveryPlan({ status: INVOICE_STATUS.CANCELLED, buyer: both }, { sms: true }), []));
  check('retries: 1, 2, 5, 10 minutes, at most 5 tries, within 30 minutes', nextAttemptAt({ attempts: 1, first: 0 }, 0) === 60e3 && nextAttemptAt({ attempts: 2, first: 0 }, 60e3) === 180e3 && nextAttemptAt({ attempts: 4, first: 0 }, 8 * 60e3) === 18 * 60e3
    && nextAttemptAt({ attempts: MAX_ATTEMPTS, first: 0 }, 0) === null && nextAttemptAt({ attempts: 3, first: 0 }, 29 * 60e3) === null);
}

// ---------- cash without a bill, the books, day close ----------
{
  check('cash entry rules: type, amount, reason, category', !!checkCashMove({ type: 'loan', amount: 1 }).error && checkCashMove({ type: 'in', amount: 0, reason: 'float' }).field === 'amount'
    && checkCashMove({ type: 'out', amount: 100, reason: 'x' }).field === 'reason' && checkCashMove({ type: 'expense', amount: 100, reason: 'Tea' }).field === 'category' && checkCashMove({ type: 'expense', amount: 100, category: 'Food' }).field === 'reason'
    && checkCashMove({ type: 'expense', amount: 100, reason: 'Tea', category: 'Food' }).move.category === 'Food' && checkCashMove({ type: 'opening', amount: 1000 }).move.reason === 'Opening float'
    && checkCashMove({ type: 'in', amount: 1.005, reason: 'odd' }).field === 'amount');
  const byId = { m1: { id: 'm1', type: 'expense', amount: 200, category: 'Food', reason: 'Lunch' } };
  check('a reversal is for the whole entry, once, with a reason; never of a reversal', checkCashMove({ type: 'reversal', reverses: 'm1', reason: 'Typed twice' }, { byId }).move.amount === 200
    && !!checkCashMove({ type: 'reversal', reverses: 'm1', reason: 'no' }, { byId }).error && !!checkCashMove({ type: 'reversal', reverses: 'm9', reason: 'gone' }, { byId }).error
    && !!checkCashMove({ type: 'reversal', reverses: 'm1', reason: 'again' }, { byId: { ...byId, r1: { id: 'r1', type: 'reversal', reverses: 'm1', amount: 200 } } }).error
    && !!checkCashMove({ type: 'reversal', reverses: 'r1', reason: 'undo undo' }, { byId: { r1: { id: 'r1', type: 'reversal', reverses: 'm1', amount: 200 } } }).error);
  check('money direction: float/in into the drawer; out/expense out; a reversal the other way', moveDirection({ type: 'opening' }) === 'in' && moveDirection({ type: 'expense' }) === 'out' && moveDirection({ type: 'reversal', reverses: 'm1' }, byId) === 'in');
  check('expense categories: trimmed, no repeats, at least one', eq(checkExpenseCats([' Tea ', 'tea', 'Rent']).cats, ['Tea', 'Rent']) && !!checkExpenseCats(['', ' ']).error);
  const T0 = 1_790_000_000_000;
  const sales = [{ id: 's1', no: 'INV-1', t: T0 + 1000, total: 1000, payments: [{ id: 's1:cash', method: 'cash', amount: 1000, received: 1000, change: 0 }] },
    { id: 's2', no: 'INV-2', t: T0 + 2000, total: 700, payments: [{ id: 's2:upi', method: 'upi', amount: 700, ref: '4123', verification: 'unverified' }] },
    { id: 's3', no: 'INV-3', t: T0 + 3000, total: 500, payments: [{ id: 's3:upi', method: 'upi', amount: 500, ref: 'pay_1', verification: 'verified', intent: 'i1' }] }];
  const moves = [{ id: 'm0', type: 'opening', amount: 2000, reason: 'Opening float', t: T0 }, { id: 'm1', type: 'expense', amount: 200, category: 'Food', reason: 'Lunch', t: T0 + 4000 },
    { id: 'm2', type: 'out', amount: 1500, reason: 'Banked', t: T0 + 5000 }, { id: 'm3', type: 'reversal', reverses: 'm1', amount: 200, reason: 'Paid by owner', t: T0 + 6000 },
    { id: 'm4', type: 'in', amount: 300, reason: 'Change from bank', t: T0 + 7000 }];
  const tx = financialTransactions(sales, [{ id: 'r1', sale: 's1', t: T0 + 8000, refund: 100, pay: 'cash' }], moves);
  const cb = cashBook(tx, { from: T0, to: T0 + 9000 });
  check('cash book: opening float, cash sales, cash in, cash out, expenses, reversal and refunds, each apart',
    cb.openingFloat === 2000 && cb.cashSales === 1000 && cb.cashIn === 300 && cb.cashOut === 1500 && cb.expenses === 200 && cb.reversals === 200 && cb.refunds === 100, cb);
  check('expected closing cash = float + cash sales − refunds + in − out − expenses (+ reversed expense)', cb.closing === 2000 + 1000 - 100 + 300 - 1500 - 200 + 200, cb.closing);
  check('entries carry the reason and category; ids follow the entry', cb.entries.some((e) => e.id === 'cb:ft:m1' && e.type === 'expense' && e.category === 'Food' && e.reason === 'Lunch'));
  const bb = bankBook(tx);
  check('bank book: unverified UPI shown apart within UPI; verified amount', bb.upiIn === 1200 && bb.upiUnverified === 700 && bb.verifiedIn === 500 && bb.entries.find((e) => e.saleId === 's2').verification === 'unverified');
  check('cash entries never reach the bank book', !bb.entries.some((e) => e.moveId));
  const dc = dayClose({ day: '2026-09-28', scope: 'shop', expected: 1700, counted: '1650', note: 'short' });
  check('day close: expected, counted, difference', dc.ok && dc.close.diff === -50 && dc.close.counted === 1650 && !!dayClose({ day: '2026-09-28', expected: 1, counted: '-1' }).error && !!dayClose({ day: 'x', expected: 1, counted: 1 }).error);
  check('changed after close: the expected cash moved since', changedAfterClose(dc.close, 1800) && !changedAfterClose(dc.close, 1700) && !changedAfterClose(null, 5));
}

// ---------- GST filing preparation ----------
{
  check('month range', eq(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28', label: 'February 2026', fp: '022026', month: '2026-02' }) && monthRange('2026-13') === null && monthRange('x') === null);
  check('document series and numbers', eq(splitDocNo('INV-250925-004'), { series: 'INV-250925', n: 4 }) && eq(splitDocNo('CN-250925-012'), { series: 'CN-250925', n: 12 }));
  const S = docSeries([{ no: 'INV-250925-001', t: 1 }, { no: 'INV-250925-002', t: 3, cancelled: true }, { no: 'INV-250925-004', t: 2 }, { no: 'INV-250925-004', t: 4 }]);
  check('documents issued per series: from, to, count, cancelled; gaps, duplicates and out-of-order numbers', S.length === 1 && S[0].from === 'INV-250925-001' && S[0].to === 'INV-250925-004' && S[0].total === 4 && S[0].cancelled === 1
    && eq(S[0].missing, [3]) && eq(S[0].duplicates, ['INV-250925-004']) && eq(S[0].outOfOrder, ['INV-250925-002']), S);
  // bills: B2B intra (Maharashtra), B2C intra small, B2C inter large (Karnataka, 1.5 lakh), B2C inter small, nil-rated, a cancelled one; a return on the large one and on the B2B one
  const T = Date.UTC(2026, 8, 10);
  const L = (p) => ({ ln: 0, q: p.q || 1, gst: p.rate, hsn: p.hsn ?? '6109', tx: p.tx, cgst: p.c || 0, sgst: p.c || 0, igst: p.i || 0, lt: p.tx + 2 * (p.c || 0) + (p.i || 0), price: p.tx });
  const bills = [
    { id: 'b1', no: 'INV-260910-001', t: T, total: 1120, disc: 0, gst: { mode: 'intra', pos: '27' }, cust: { name: 'Acme', type: 'business', gstin: '27ABCDE1234F1Z5' }, items: [L({ rate: 12, tx: 1000, c: 60 })] },
    { id: 'b2', no: 'INV-260910-002', t: T + 1, total: 525, disc: 25, gst: { mode: 'intra', pos: '27' }, cust: null, items: [L({ rate: 5, tx: 500, c: 12.5 })] },
    { id: 'b3', no: 'INV-260910-003', t: T + 2, total: 168000, gst: { mode: 'inter', pos: '29' }, cust: { name: 'Kiran' }, items: [L({ rate: 12, tx: 150000, i: 18000, q: 10 })] },
    { id: 'b4', no: 'INV-260910-004', t: T + 3, total: 1050, gst: { mode: 'inter', pos: '29' }, cust: null, items: [L({ rate: 5, tx: 1000, i: 50 })] },
    { id: 'b5', no: 'INV-260910-005', t: T + 4, total: 300, gst: { mode: 'intra', pos: '27' }, cust: null, items: [L({ rate: 0, tx: 300, hsn: '' })] },
    { id: 'b6', no: 'INV-260910-006', t: T + 5, total: 999, void: true, gst: { mode: 'intra', pos: '27' }, cust: null, items: [L({ rate: 12, tx: 891.96, c: 53.52 })] }];
  const byId = Object.fromEntries(bills.map((b) => [b.id, b]));
  const rets = [{ id: 'r1', no: 'CN-260912-001', sale: 'b3', t: T + 86400000 * 2, value: 16800, items: [{ ln: 0, q: 1, value: 16800, tx: 15000, cgst: 0, sgst: 0, igst: 1800, gst: 12, hsn: '6109' }] },
    { id: 'r2', no: 'CN-260912-002', sale: 'b1', t: T + 86400000 * 2 + 1, value: 560, items: [{ ln: 0, q: 1, value: 560, tx: 500, cgst: 30, sgst: 30, igst: 0, gst: 12, hsn: '6109' }] }];
  const G = gstReport({ sales: bills, returns: rets, saleById: byId });
  const F = filingSections(G, { b2clLimit: 100000 });
  check('B2B invoice-wise with the customer GSTIN', F.b2b.length === 1 && F.b2b[0].gstin === '27ABCDE1234F1Z5' && F.b2b[0].rates[0].cgst === 60);
  check('B2C large: inter-state, no GSTIN, above the limit (limit from settings)', F.b2cl.length === 1 && F.b2cl[0].no === 'INV-260910-003' && filingSections(G, { b2clLimit: 200000 }).b2cl.length === 0);
  const cs = Object.fromEntries(F.b2cs.map((x) => [x.pos + '|' + x.rate + '|' + x.supply, x]));
  check('B2C others by place of supply and rate (large and B2B left out)', cs['27|5|INTRA'].taxable === 500 && cs['29|5|INTER'].igst === 50 && !cs['29|12|INTER'] && cs['27|0|INTRA'].taxable === 300, F.b2cs);
  check('credit notes: registered (CDNR) with the invoice; unregistered on a large invoice (CDNUR)', F.cdnr.length === 1 && F.cdnr[0].invoiceNo === 'INV-260910-001' && F.cdnr[0].taxable === 500 && F.cdnr[0].rates[0].cgst === 30
    && F.cdnur.length === 1 && F.cdnur[0].invoiceNo === 'INV-260910-003' && F.cdnur[0].rates[0].igst === 1800);
  check('nil rated split by supply type', eq(F.nil, [{ type: 'INTRAB2C', taxable: 300 }]));
  const h = Object.fromEntries(F.hsn.map((x) => [x.hsn + '|' + x.rate, x]));
  check('HSN summary by rate, net of credit notes', h['6109|12'].taxable === 1000 + 150000 - 15000 - 500 && h['6109|5'].taxable === 1500 && h['|0'].taxable === 300, F.hsn);
  check('cancelled invoices left out of every section, listed in documents', !F.b2b.concat(F.b2cl).some((x) => x.no === 'INV-260910-006') && F.series.invoices[0].cancelled === 1 && F.series.invoices[0].net === 5 && F.totals.cancelled === 1);
  check('totals: net taxable, GST, discounts', F.totals.taxable === G.totals.net.taxable && F.totals.discounts === 25 && F.totals.invoices === 5);
  check('checks: the nil-rated line without HSN isn\'t flagged (no tax); a B2B without GSTIN would be', !F.checks.some((c) => c.kind === 'hsn'));
  const J = gstr1Json(F, { gstin: '27AAAAA0000A1Z5', period: monthRange('2026-09') });
  check('structured dataset: GSTR-1 sections with the same figures', J.fp === '092026' && J.b2b[0].ctin === '27ABCDE1234F1Z5' && J.b2b[0].inv[0].itms[0].itm_det.camt === 60 && J.b2cl[0].pos === '29'
    && J.cdnr[0].nt[0].nt_num === 'CN-260912-002' && J.cdnur[0].typ === 'B2CL' && J.nil.inv[0].sply_ty === 'INTRAB2C' && J.hsn.data.length === F.hsn.length && J.doc_issue.doc_det[0].docs[0].cancel === 1 && /does not file/.test(J._note));
  const d1 = gstDigest(G), G2 = gstReport({ sales: bills.map((b) => (b.id === 'b2' ? { ...b, void: true } : b)), returns: rets, saleById: byId });
  check('fingerprint: the same documents give the same one; a cancel changes it; flagged after an export', d1 === gstDigest(G) && d1 !== gstDigest(G2) && filingSections(G2, { lastExport: { digest: d1 } }).checks.some((c) => c.kind === 'changed') && !filingSections(G, { lastExport: { digest: d1 } }).checks.some((c) => c.kind === 'changed'));
}

// ---------- stock in: supplier, reference, date received ----------
{
  const { stockInNote } = await import('../../src/domain/inventory/stock-operation.js');
  check('stock-in note keeps supplier, reference and a past date received', stockInNote({ supplier: ' Surat  Textiles ', ref: 'ST-991', received: '2026-09-20', note: '2 boxes', today: '2026-09-28' }) === 'From Surat Textiles · Ref ST-991 · Received 2026-09-20 · 2 boxes'
    && stockInNote({ received: '2026-09-28', today: '2026-09-28' }) === '');
}

// ---------- Excel and PDF files ----------
{
  const x = xlsxBytes([{ name: 'B2B', rows: [['GSTIN', 'Value'], ['27ABCDE1234F1Z5', 1120.5], ['A & B <co>', 7]] }, { name: 'B2B', rows: [['x']] }]);
  const txt = Buffer.from(x).toString('latin1');
  check('xlsx: a ZIP (PK) with the workbook, the sheets and their names (duplicates renamed)', txt.startsWith('PK\u0003\u0004') && txt.includes('xl/workbook.xml') && txt.includes('xl/worksheets/sheet2.xml') && txt.includes('name="B2B 2"'));
  check('xlsx: numbers stay numbers, text is escaped', txt.includes('<v>1120.5</v>') && txt.includes('A &amp; B &lt;co&gt;'));
  // every stored entry's CRC matches its data
  let p = 0, ok = true, n = 0;
  while (x[p] === 0x50 && x[p + 1] === 0x4b && x[p + 2] === 3) { const crc = x.readUInt32LE ? 0 : 0; const b = Buffer.from(x); const c = b.readUInt32LE(p + 14), size = b.readUInt32LE(p + 18), nl = b.readUInt16LE(p + 26); const data = b.subarray(p + 30 + nl, p + 30 + nl + size); if (crc32(data) !== c) ok = false; p += 30 + nl + size; n++; }
  check('xlsx: every part stored with the right CRC (the file opens)', ok && n === 7, n);
  const pdf = pdfBytes({ title: 'GST filing preparation · September 2026', subtitle: 'Riya · ₹', footer: 'Hangtag does not file returns.', blocks: [{ heading: 'B2B', head: ['Invoice', 'Value'], rows: Array.from({ length: 80 }, (_, i) => ['INV-' + i, 1000 + i]) }] });
  const ptxt = Buffer.from(pdf).toString('latin1');
  check('pdf: a PDF with pages, the fonts and the text (₹ written as Rs., its plain form, by the shared formatter)', ptxt.startsWith('%PDF-1.4') && ptxt.trim().endsWith('%%EOF') && /\/Count 2/.test(ptxt) && ptxt.includes('(GST filing preparation') && ptxt.includes('Rs.') && !ptxt.includes('₹') && ptxt.includes('Page 2 of 2'));
  const xref = +/startxref\n(\d+)/.exec(ptxt)[1], offs = [...ptxt.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => +m[1]);
  check('pdf: the cross-reference table points at each object', offs.length > 3 && offs.every((o, i) => ptxt.slice(o).startsWith(`${i + 1} 0 obj`)));
}

// ---------- settings ----------
{
  check('payments and receipts settings', checkPaymentSettings({ upiId: 'shop@upi', payExpiry: '5', sms: 'on' }, { sms: true }).patch.autoSend.sms === true && !!checkPaymentSettings({ upiId: 'bad', payExpiry: 5 }).error
    && !!checkPaymentSettings({ payExpiry: 1 }).error && !!checkPaymentSettings({ payExpiry: 5, whatsapp: 'on' }, { whatsapp: false }).error);
  check('GST: B2C large limit', checkGstSettings({ b2clLimit: '250000' }).patch.b2clLimit === 250000 && !!checkGstSettings({ b2clLimit: '-1' }).error);
}

// ---------- cloud rows ----------
{
  store.dev = 'd1';
  const sale = { id: 's1', t: 5, dev: 'd1', payments: [{ id: 's1:upi', method: 'upi', amount: 500, ref: 'pay_1', verification: 'verified', via: 'qr', intent: 'i1', providerRef: 'pay_1' },
    { id: 's1:card', method: 'card', amount: 300, ref: 'APPR', verification: 'recorded', via: 'terminal', last4: '4242' }, { id: 's1:cash', method: 'cash', amount: 200, received: 500, change: 300, verification: 'recorded' }] };
  const rows = paymentRows(sale);
  check('payment rows carry verification, the way it was taken, the intent and the last 4 (cash: none)', rows[0].verification === 'verified' && rows[0].intent_id === 'i1' && rows[0].via === 'qr' && rows[1].card_last4 === '4242' && rows[2].via === null && rows[2].card_last4 === null);
  const back = rows.map((r) => rowToPayment({ ...r, amount: String(r.amount) }));
  check('…and come back the same', back[0].verification === 'verified' && back[0].intent === 'i1' && back[0].providerRef === 'pay_1' && back[1].last4 === '4242' && back[2].change === 300);
  const m = { id: 'cm1', type: 'expense', amount: 200, reason: 'Lunch', category: 'Food', t: 9, dev: 'd1', event: 'e1' };
  check('cash entry rows round trip', eq(rowToCashMove({ ...cashMoveRow(m), amount: '200.00' }), m));
  const c = { id: 'dc:2026-09-28:shop', day: '2026-09-28', scope: 'shop', expected: 1700, counted: 1650, diff: -50, note: '', t: 3, dev: 'd1' };
  check('day close rows round trip', eq(rowToDayClose(dayCloseRow(c)), c));
}

// ---------- use cases on this device: provider payment, automatic delivery, cash, cancelling ----------
installFakeDom();
globalThis.window = globalThis.window || { addEventListener(){} };
const storage = memStorage();
const { saveCashMoves, saveDayCloses } = await import('../../src/shared/state/persistence.js');
const { enqueue } = await import('../../src/features/sync/services/outbox.js');
override({ cashRepository: createLocalFirstCashRepository({ store, persist: { saveCashMoves, saveDayCloses }, outbox: { enqueue } }), cloud: { async saveSale(){}, async setSaleVoid(){}, async saveCashMove(){}, async saveDayClose(){} } });
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: {}, dirty: new Set(), returnsMap: {}, _d: null, customers: { c1: { id: 'c1', name: 'Riya', phone: '9876543210', email: 'riya@mail.in' } },
  cartCust: null, disc: null, cart: [], sbOfflineQueue: [], syncReview: [], sbClient: {}, sbStatus: 'connected', events: {}, prefs: { event: '' }, lastCheckout: 0, deliveries: {}, channels: null,
  settings: { taxOn: false, prefix: 'INV-', autoSend: { whatsapp: true, sms: true, email: false } }, profile: {}, moves: {}, cashMoves: {}, dayCloses: {}, deliveryQueue: [], payConfig: null,
  catalog: { version: 3, products: [{ id: 'p1', name: 'Tee', price: 500, opts: [], variants: [{ id: 'p1:', o: [], active: true }] }] } });
const { newSaleRecord, recordSale, voidSale } = await import('../../src/features/sales/use-cases/checkout.js');
const { D, invalidate } = await import('../../src/features/inventory/services/ledger.js');

// provider payment: a QR, polled until the provider says verified; a cancel that finds the money already there
{
  const calls = [];
  let statusAnswer = 'pending';
  override({ paymentGateway: {
    async config(){ return { provider: 'razorpay', upi: true, cardLink: false }; },
    async create(r){ calls.push(['create', r]); return { id: 'i1', method: r.method, status: 'pending', amount: r.amount, qrUrl: 'https://rzp.io/q', reference: 'qr_1', expiresAt: Date.now() + 300000 }; },
    async status(id){ calls.push(['status', id]); return { id, method: 'upi', status: statusAnswer, amount: 500, paidAmount: statusAnswer === 'verified' ? 500 : null, paymentId: statusAnswer === 'verified' ? 'pay_1' : null, reference: 'qr_1' }; },
    async cancel(id){ calls.push(['cancel', id]); return { id, method: 'upi', status: 'verified', amount: 500, paidAmount: 500, paymentId: 'pay_1', reference: 'qr_1' }; },
    async verify({ saleId, reference }){ calls.push(['verify', saleId, reference]); return reference === '412345678901' ? { status: 'verified', paymentId: 'pay_m', intentId: 'im' } : { status: 'not_found' }; },
  } });
  const PP = await import('../../src/features/sales/use-cases/provider-payment.js');
  await PP.loadPayConfig(true);
  check('provider set up: UPI can be verified, card link can\'t', PP.providerReady('upi') && !PP.providerReady('card'));
  store.cart = [{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }];
  store.payState = { mode: 'single', method: 'upi', pi: {}, via: { upi: 'qr', card: 'terminal' }, amt: {} };
  const I = await PP.startIntent('upi', 500);
  check('a QR for the exact amount, tied to a bill id fixed before payment, and kept for a restart', I.status === 'pending' && calls[0][1].amount === 500 && calls[0][1].saleId === store.payState.saleId && store.payPending.pi.upi.id === 'i1' && JSON.parse(storage.mem.hangtag_pay_pending).pi.upi.id === 'i1');
  await PP.checkIntent('upi');
  check('still pending: nothing changes', store.payState.pi.upi.status === 'pending');
  statusAnswer = 'verified'; await PP.checkIntent('upi');
  check('the provider confirms: the part is verified with the provider\'s payment id', store.payState.pi.upi.status === 'verified' && store.payState.pi.upi.paymentId === 'pay_1');
  const sale = newSaleRecord(store.cart, null, [{ method: 'upi', amount: 500, via: 'qr', intent: store.payState.pi.upi }], { id: store.payState.saleId });
  check('the bill is saved with the id the provider knows, and a verified payment', sale.id === store.payState.saleId && sale.payments[0].verification === 'verified' && sale.payments[0].intent === 'i1');
  store.payState = { mode: 'single', method: 'upi', pi: { upi: { id: 'i2', status: 'pending', amount: 500 } }, via: { upi: 'qr' }, amt: {} };
  const c = await PP.cancelIntent('upi');
  check('cancel finds the money arrived first: kept as verified (not lost, not charged twice)', c.status === 'verified' && store.payState.pi.upi.status === 'verified');
  const kept = await PP.abandonIntents({ saleId: 'sX', mode: 'split', method: 'cash', via: {}, amt: { upi: '500' }, pi: { upi: { id: 'i9', status: 'verified', amount: 500 }, card: { id: 'i8', status: 'pending', amount: 300 } } }, { keepVerified: true });
  check('screen closed after the provider confirmed a part: that money stays with the bill; the open link is closed', kept.length === 1 && store.payPending.pi.upi.id === 'i9' && !store.payPending.pi.card && calls.some((x) => x[0] === 'cancel' && x[1] === 'i8'));
  store.payState = null; PP.persistPending();
  check('nothing open: the kept payment is cleared', store.payPending === null && !('hangtag_pay_pending' in storage.mem));
  // later: a hand-checked UPI bill is matched with the provider once uploaded
  const s = newSaleRecord([{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }], null, [{ method: 'upi', amount: 500, ref: '412345678901', confirmed: true }]);
  recordSale(s);
  let n = await PP.verifyManualUpi(D().sales);
  check('hand-checked UPI waits while its bill is still uploading', n === 0 && !calls.some((x) => x[0] === 'verify'));
  store.sbOfflineQueue = [];
  n = await PP.verifyManualUpi(D().sales);
  check('once uploaded it is matched and upgraded to verified on this device', n === 1 && D().saleById[s.id].payments[0].verification === 'verified' && D().saleById[s.id].payments[0].providerRef === 'pay_m');
  n = await PP.verifyManualUpi(D().sales);
  check('…and not asked about again', n === 0 && calls.filter((x) => x[0] === 'verify').length === 1);
}

// automatic receipt: queued at checkout, waits for the upload, retries, WhatsApp falls back to SMS, once per channel
{
  const sent = [];
  let mode = 'fail-wa';
  override({ messageDelivery: {
    async channels(){ return { whatsapp: true, sms: true, email: true }; },
    async send(r){ sent.push(r); if(r.channel === 'whatsapp' && mode === 'fail-wa') throw new AppError(C.DELIVERY, 'Not on WhatsApp');
      if(mode === 'network') throw new AppError(C.NETWORK, 'offline'); return { status: 'sent', to: '+919876543210', provider: 'twilio', id: 'SM1' }; },
  } });
  const AD = await import('../../src/features/delivery/use-cases/auto-delivery.js');
  store.deliveryQueue = [];
  const s = newSaleRecord([{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }], null, 'cash', { cust: { id: 'c1', name: 'Riya', phone: '9876543210' } });
  recordSale(s);
  const jobs = AD.queueAutoDelivery(s);
  check('checkout queues the receipt on the channels turned on (WhatsApp, SMS as fallback)', jobs.length === 1 && jobs[0].channel === 'whatsapp' && jobs[0].fallback === 'sms' && JSON.parse(storage.mem.hangtag_delivery_queue).length === 1);
  check('the same bill is never queued twice for a channel', AD.queueAutoDelivery(s).length === 0);
  await AD.processDeliveryQueue();
  check('the bill is still uploading: the receipt waits', sent.length === 0 && store.deliveryQueue[0].wait === 'upload');
  store.sbOfflineQueue = [];
  await AD.processDeliveryQueue(); await new Promise((r) => setTimeout(r, 600)); await AD.processDeliveryQueue();
  const wa = store.deliveryQueue.find((j) => j.channel === 'whatsapp'), sms = store.deliveryQueue.find((j) => j.channel === 'sms');
  check('WhatsApp refused by the provider → SMS goes instead, marked auto (the server sends each once)', wa.status === 'failed' && sms && sms.status === 'sent' && sms.after === 'whatsapp' && sent.every((r) => r.auto === true), store.deliveryQueue);
  mode = 'network'; store.deliveryQueue = [];
  const s2 = newSaleRecord([{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }], null, 'cash', { cust: { id: 'c1', name: 'Riya', phone: '9876543210' } });
  recordSale(s2); store.sbOfflineQueue = []; store.settings.autoSend = { sms: true };
  AD.queueAutoDelivery(s2); await AD.processDeliveryQueue();
  const j = store.deliveryQueue[0];
  check('a network failure is tried again later (attempt counted, next time set)', j.status === 'queued' && j.attempts === 1 && j.nextAt > Date.now() && j.error === 'offline');
  store.sbStatus = 'disconnected'; j.nextAt = 0; await AD.processDeliveryQueue();
  check('offline: it waits, shown as queued', j.status === 'queued' && j.wait === 'offline' && j.attempts === 1);
  store.sbStatus = 'connected'; mode = 'ok'; await AD.processDeliveryQueue();
  check('back online: sent', j.status === 'sent' && j.attempts === 2);
  const s3 = newSaleRecord([{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }], null, 'cash', { cust: null });
  check('walk-in bills are not sent automatically', AD.queueAutoDelivery(s3).length === 0);
}

// cash entries and closing the day; cancelling a bill needs a reason
{
  const CM = await import('../../src/features/finance/use-cases/cash-moves.js');
  store.localDays = {}; store.remoteDays = {}; store._d = null; invalidate(); store.cashMoves = {}; store.dayCloses = {}; store.sbOfflineQueue = [];
  const day = (await import('../../src/shared/formatting/dates.js')).dayKey(Date.now());   // this device's day (not UTC's)
  let r = CM.recordCashMove({ type: 'opening', amount: 1000 });
  check('opening float saved on this device and queued for upload', r.move && store.cashMoves[r.move.id] && store.sbOfflineQueue.some((q) => q.type === 'cashmove' && q.id === r.move.id) && JSON.parse(storage.mem.rc_cash_moves)[r.move.id]);
  const e = CM.recordCashMove({ type: 'expense', amount: 150, reason: 'Tea for staff', category: 'Food' }).move;
  check('an expense needs a category from the shop\'s list', !!CM.recordCashMove({ type: 'expense', amount: 1, reason: 'abc', category: 'Nope' }).error && e.category === 'Food');
  const s = newSaleRecord([{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }], null, 'cash', { cust: null }); recordSale(s);
  check('the day\'s expected cash: float + cash sales − expenses', CM.dayCash(day).closing === 1000 + 500 - 150, CM.dayCash(day));
  r = CM.closeDay({ day, counted: '1340', note: 'coins short' });
  check('day closed: expected, counted, difference, queued', r.close.expected === 1350 && r.close.diff === -10 && store.sbOfflineQueue.some((q) => q.type === 'dayclose'));
  CM.recordCashMove({ type: 'reversal', reverses: e.id, reason: 'Owner paid it' });
  check('an entry after the close: "changed after close"', CM.closeState(day).changed && CM.closeState(day).expectedNow === 1500);
  check('a device\'s own close counts only its entries', CM.dayCash(day, 'other-device').closing === 0);
  let v = await voidSale(s.id, '');
  check('cancelling a bill without a reason is refused', v.error && !D().saleById[s.id].void);
  v = await voidSale(s.id, 'Duplicate bill');
  check('with a reason: cancelled, reason kept and sent with it', v.ok && D().saleById[s.id].void && D().saleById[s.id].voidReason === 'Duplicate bill' && store.sbOfflineQueue.some((q) => q.type === 'void' && q.reason === 'Duplicate bill'));
}

// the payment function not deployed / not set up: known for the session (UPI is checked by hand), no call on every payment
{
  let asked = 0;
  override({ paymentGateway: { async config(){ asked++; throw new AppError(C.NOT_CONFIGURED, 'Verified payments are not set up yet.'); } } });
  const PP = await import('../../src/features/sales/use-cases/provider-payment.js');
  store.sbStatus = 'connected'; await PP.loadPayConfig(true); await PP.loadPayConfig();
  check('provider not set up: remembered for the session, UPI offered by hand', asked === 1 && store.payConfig.upi === false && !PP.providerReady('upi'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
