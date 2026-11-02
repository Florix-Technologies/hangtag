// Quotations and sales orders, the customer-facing part (Wave 3): the quotation template settings and numbering, the
// document (headed by the shop's title, GST shown or not, never an invoice), sending it by email / WhatsApp through the
// server with a queue on the phone (Queued → Sent / Failed, one request id per press, never twice), duplicate, quotation →
// sales order (everything kept, Pending first) → bill, and the receipt page the owner's app keeps for invoice links.
// Run: npm run test:unit
import { QUOTE_CHANNELS, QUOTE_SEND_LABELS, quotePrefix, quoteTarget, statusLabel } from '../../src/domain/orders/orders.js';
import { checkQuotationSettings, receiptPageUrl } from '../../src/domain/shop/settings-validation.js';
import { REQUEST_ID_RE } from '../../supabase/functions/send-receipt/core.js';
import { createLocalFirstOrderRepository } from '../../src/infrastructure/repositories/local-first-order-repository.js';
import { createLocalFirstCustomerRepository } from '../../src/infrastructure/repositories/local-first-customer-repository.js';
import { orderArgs, rowToOrder } from '../../src/infrastructure/supabase/mappers.js';
import { AppError, ERROR_CODES } from '../../src/shared/errors/app-error.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- rules ----------
console.log('=== rules ===');
check('number prefix: "QUO" → "QUO-", "Q/" kept, empty → the default QT-', quotePrefix('QUO') === 'QUO-' && quotePrefix('Q/') === 'Q/' && quotePrefix('') === 'QT-' && quotePrefix(null) === 'QT-');
check('a quotation goes to its saved customer: email, or a mobile for WhatsApp', quoteTarget({ name: 'Asha', email: 'asha@example.com' }, 'email').to === 'asha@example.com'
  && quoteTarget({ name: 'Asha', phone: '098765 43210' }, 'whatsapp').to === '+919876543210' && /no email address/.test(quoteTarget({ name: 'Asha' }, 'email').error)
  && /no mobile number/.test(quoteTarget({ name: 'Asha', phone: '123' }, 'whatsapp').error) && /Choose the quotation's customer/.test(quoteTarget(null, 'email').error)
  && /email or WhatsApp/.test(quoteTarget({ name: 'A', phone: '9876543210' }, 'sms').error));
check('send states and channels are named for the shop', QUOTE_SEND_LABELS.queued === 'Queued' && QUOTE_SEND_LABELS.sent === 'Sent' && QUOTE_SEND_LABELS.failed === 'Failed' && Object.keys(QUOTE_CHANNELS).join() === 'email,whatsapp');
let r = checkQuotationSettings({ quoteTitle: '  Price quote ', quotePrefix: 'PQ', quoteFooter: 'Thanks', quoteTerms: 'Line 1\r\nLine 2', quoteSignature: 'For Ravi & Sons', quoteGst: false });
check('quotation settings: title, prefix, footer, terms (line breaks kept), signature, GST hidden', r.patch && r.patch.quoteTitle === 'Price quote' && r.patch.quotePrefix === 'PQ' && r.patch.quoteTerms === 'Line 1\nLine 2'
  && r.patch.quoteGst === false && r.patch.quoteSignature === 'For Ravi & Sons', r);
check('…a title saying invoice, a bad prefix or over-long terms are refused; an empty title is QUOTATION', /can't say invoice/.test(checkQuotationSettings({ quoteTitle: 'Tax Invoice' }).error)
  && /prefix/.test(checkQuotationSettings({ quotePrefix: 'Q T' }).error) && /2,000/.test(checkQuotationSettings({ quoteTerms: 'x'.repeat(2001) }).error)
  && checkQuotationSettings({ quoteTitle: '' }).patch.quoteTitle === 'QUOTATION' && checkQuotationSettings({}).patch.quoteGst === true);
check('the app\'s receipt page: https …/receipt.html beside the app (or http on this computer); never another scheme', receiptPageUrl('https://florix-technologies.github.io/hangtag/?a=1#x') === 'https://florix-technologies.github.io/hangtag/receipt.html'
  && receiptPageUrl('https://shop.vercel.app/index.html') === 'https://shop.vercel.app/receipt.html' && receiptPageUrl('http://localhost:3210/') === 'http://localhost:3210/receipt.html'
  && receiptPageUrl('http://shop.example/') === '' && receiptPageUrl('file:///C:/hangtag/index.html') === '' && receiptPageUrl('') === '');
check('sales order lifecycle as shown: Pending → Confirmed → Partly fulfilled → Fulfilled', statusLabel('sales', 'draft') === 'Pending' && statusLabel('sales', 'confirmed') === 'Confirmed'
  && statusLabel('sales', 'partial') === 'Partly fulfilled' && statusLabel('sales', 'completed') === 'Fulfilled' && statusLabel('quote', 'draft') === 'Draft');
const row = orderArgs({ id: 'o1', kind: 'quote', no: 'QT-1', status: 'draft', cust: { id: 'c1', name: 'A' }, items: [], t: 1, total: 1180 });
check('an order keeps its total in the cloud (what a sent quotation says it comes to)', row.p_order.total === 1180 && rowToOrder({ id: 'o1', kind: 'quote', status: 'draft', total: '1180.00', t: 1 }, []).total === 1180
  && orderArgs({ id: 'o2', kind: 'table', status: 'new', items: [], t: 1 }).p_order.total === null);

// ---------- use cases ----------
console.log('\n=== use cases ===');
const el = installFakeDom();
globalThis.window = globalThis.window || { addEventListener(){} };
globalThis.confirm = () => true;
globalThis.location = { href: 'https://florix-technologies.github.io/hangtag/' };
const ST = memStorage();
const P = await import('../../src/shared/state/persistence.js');
const OB = await import('../../src/features/sync/services/outbox.js');
const outbox = { enqueue: OB.enqueue, dropQueued: OB.dropQueued };
const { invalidate } = await import('../../src/features/inventory/services/ledger.js');
const sent = [];
let deliveryMode = 'ok';
override({
  orderRepository: createLocalFirstOrderRepository({ store, persist: { saveOrders: P.saveOrders, saveHeldCarts: P.saveHeldCarts }, outbox }),
  customerRepository: createLocalFirstCustomerRepository({ store, persist: { saveCustomers: P.saveCustomers }, outbox }),
  cloud: { auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) }, async saveOrder(o){ return { version: (+o.version || 0) + 1 }; }, async saveSale(){}, async saveSettings(){} },
  messageDelivery: {
    async channels(){ return { email: true, whatsapp: true, sms: false, quote_email: true, quote_whatsapp: true }; },
    async sendQuote(x){
      sent.push(x);
      if(deliveryMode === 'offline') throw new AppError(ERROR_CODES.NETWORK, 'No connection.');
      if(deliveryMode === 'refused') throw new AppError(ERROR_CODES.DELIVERY, 'The email service didn\'t accept the message: bad address', { details: { error: 'provider_error' } });
      if(deliveryMode === 'off') throw new AppError(ERROR_CODES.NOT_CONFIGURED, 'Sending quotations by WhatsApp isn\'t set up for this shop yet.', { details: { error: 'not_configured' } });
      return { status: 'sent', to: x.channel === 'email' ? 'asha@example.com' : '+919876543210', provider: 'resend', id: 'msg_' + sent.length };
    },
    async quoteHistory(){ return []; },
  },
});
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: {}, dirty: new Set(), returnsMap: {}, _d: null,
  customers: { c1: { id: 'c1', name: 'Asha', phone: '9876543210', email: 'asha@example.com' }, c2: { id: 'c2', name: 'Bala', phone: '' } },
  cartCust: null, cartOrder: null, disc: null, cart: [], sbOfflineQueue: [], syncReview: [], sbClient: null, sbStatus: 'disconnected', events: {}, prefs: { event: '' }, lastCheckout: 0, deliveries: {}, channels: null,
  settings: { taxOn: true, taxRate: 5, taxIncl: false, prefix: 'INV-', quotePrefix: 'PQ', quoteTerms: '50% advance', quoteTitle: 'PRICE QUOTE', quoteFooter: 'Thank you', quoteSignature: 'For Ravi & Sons', quoteGst: true },
  profile: { shop_name: 'Ravi & Sons', state: 'Maharashtra' }, moves: {}, cashMoves: {}, dayCloses: {}, deliveryQueue: [], payConfig: null, collections: {}, heldCarts: {}, orders: {}, access: null, quoteSends: [],
  catalog: { version: 3, products: [{ id: 'p1', name: 'Tee', price: 500, opts: [], variants: [{ id: 'p1:', o: [], active: true }] }, { id: 'p2', name: 'Rice', price: 60, unit: 'kg', opts: [], variants: [{ id: 'p2:', o: [], active: true }] }] } });
store.moves = { m1: { id: 'm1', v: 'p1:', p: 'p1', q: 10, type: 'in', t: 1 }, m2: { id: 'm2', v: 'p2:', p: 'p2', q: 20, type: 'in', t: 1 } };
invalidate();
const OU = await import('../../src/features/orders/use-cases/orders.js');
const SQ = await import('../../src/features/orders/use-cases/send-quotation.js');
const QD = await import('../../src/features/orders/components/quotation-document.js');
const RP = await import('../../src/features/shop/use-cases/receipt-page.js');
const member = (role, perms) => { store.access = { role, perms, shopId: 'owner1' }; };
const ownerAgain = () => { store.access = null; };

// a new quotation: the shop's prefix, default terms, the saved total
const d = OU.newOrderDraft('quote', { cust: { id: 'c1', name: 'Asha', phone: '9876543210' } });
check('a new quotation starts with the shop\'s default terms', d.terms === '50% advance');
d.items = [OU.orderLine('p1:', 2), { ...OU.orderLine('p2:', 2.5), disc: { type: 'percent', value: 10 } }];
d.notes = 'Deliver Friday';
let s = OU.saveOrder(d);
const quote = s.order;
check('saved with the shop\'s short professional number prefix and the total from the one bill calculation', !s.error && /^PQ-(?:[B-HJ-NP-Z]-)?\d{6}$/.test(quote.no) && quote.total === OU.orderTotals(quote).total && quote.total > 0
  && quote.items[1].u === 'kg' && quote.cust.email === 'asha@example.com', s);
// the document
let html = QD.quotationHTML(quote);
check('the document: the shop\'s title, number, validity, GST columns, terms, signature, footer — and it says it is not a bill', /<h1>PRICE QUOTE<\/h1>/.test(html) && html.includes(quote.no) && /Valid until/.test(html)
  && /<th>GST<\/th>/.test(html) && /50% advance/.test(html) && /For Ravi &amp; Sons/.test(html) && /<footer>Thank you<\/footer>/.test(html) && /not a bill/.test(html) && !/invoice/i.test(html));
store.settings.quoteGst = false;
html = QD.quotationHTML(quote);
check('GST hidden by the template: no GST or taxable columns, the total stays', !/<th>GST<\/th>/.test(html) && !/<th>Taxable<\/th>/.test(html) && /q-grand/.test(html));
store.settings.quoteGst = true;
// duplicate
const dup = OU.duplicateQuotation(quote.id);
check('duplicate: a new draft quotation with its own number, the same customer, lines, prices, discounts and terms', !dup.error && dup.order.id !== quote.id && dup.order.no !== quote.no && dup.order.status === 'draft'
  && dup.order.cust.id === 'c1' && dup.order.items.length === 2 && dup.order.items[1].disc.value === 10 && dup.order.terms === '50% advance' && dup.order.total === quote.total, dup);

// sending: offline first → queued
s = SQ.sendQuotation(quote.id, 'email');
check('offline: the send is queued on this phone (Queued), with a request id the server accepts', !s.error && s.job.status === 'queued' && REQUEST_ID_RE.test(s.job.requestId) && s.job.to === 'asha@example.com', s);
await SQ.processQuoteSends(); await tick();
check('…it waits for the internet; nothing was sent', SQ.quoteSendsOf(quote.id)[0].status === 'queued' && SQ.quoteSendsOf(quote.id)[0].wait === 'offline' && sent.length === 0);
check('the same quotation and channel isn\'t queued twice', /already waiting/.test(SQ.sendQuotation(quote.id, 'email').error));
check('kept across restarts (rc_quote_sends)', JSON.parse(ST.mem.rc_quote_sends || '[]').length === 1 && JSON.parse(ST.mem.rc_quote_sends)[0].status === 'queued');
// online, but the quotation is still uploading
store.sbClient = {}; store.sbStatus = 'connected';
store.sbOfflineQueue = [{ type: 'order', id: quote.id }];
await SQ.processQuoteSends();
check('online but the quotation is still uploading: it waits (the server writes the message from the saved quotation)', SQ.quoteSendsOf(quote.id)[0].wait === 'upload' && sent.length === 0);
store.sbOfflineQueue = [];
await SQ.processQuoteSends();
let job = SQ.quoteSendsOf(quote.id)[0];
check('uploaded: sent once with its request id; Sent; the draft quotation becomes "sent"', job.status === 'sent' && sent.length === 1 && sent[0].requestId === job.requestId && sent[0].orderId === quote.id
  && OU.orderById(quote.id).status === 'sent', { job, sent });
await SQ.processQuoteSends();
check('running the queue again never sends it twice', sent.length === 1);
// WhatsApp refused by the provider → Failed, then tried again with a new press
deliveryMode = 'refused';
s = SQ.sendQuotation(quote.id, 'whatsapp'); await SQ.processQuoteSends();
job = SQ.quoteSendsOf(quote.id).find((j) => j.channel === 'whatsapp');
check('a provider refusal is Failed with its reason (never shown as sent)', job.status === 'failed' && /bad address/.test(job.error), job);
deliveryMode = 'ok';
const again = SQ.retryQuoteSend(job.id); await SQ.processQuoteSends();
const j2 = SQ.quoteSendsOf(quote.id).find((x) => x.id === again.job.id);
check('Try again: a new press with a new request id, then Sent', !again.error && again.job.requestId !== job.requestId && j2.status === 'sent');
// a network error mid-send: queued again for a retry, same request id
deliveryMode = 'offline';
s = SQ.sendQuotation(dup.order.id, 'email'); await SQ.processQuoteSends();
job = SQ.quoteSendsOf(dup.order.id)[0];
check('a network error mid-send: back to Queued to try again (same request id, so the server sends it at most once)', job.status === 'queued' && job.wait === 'retry' && job.attempts === 1, job);
deliveryMode = 'ok'; await SQ.processQuoteSends();
check('…and then Sent with the same request id', SQ.quoteSendsOf(dup.order.id)[0].status === 'sent' && sent[sent.length - 1].requestId === job.requestId);
// refused before anything is queued
check('no contact for the channel: refused, nothing queued', /no mobile number/.test(SQ.sendQuotation((OU.saveOrder({ ...OU.newOrderDraft('quote', { cust: { id: 'c2', name: 'Bala' } }), items: [OU.orderLine('p1:', 1)] }).order || {}).id, 'whatsapp').error));
store.channels = { quote_email: true, quote_whatsapp: false };
check('a channel the server can\'t send quotations on is refused (Share PDF instead)', /isn't set up on the server yet/.test(SQ.sendQuotation(quote.id, 'whatsapp').error));
store.channels = null;
member('kitchen', ['manage_kitchen']);
check('a role without create_order can\'t send quotations', /send quotations/.test(SQ.sendQuotation(quote.id, 'email').error || ''));
ownerAgain();
store.settings.caps = { uses_quotations: false };
check('quotations switched off: sending is refused', /switched off/.test(SQ.sendQuotation(quote.id, 'email').error));
delete store.settings.caps;
// the send sheet
await QD.openQuotationSend(quote.id);
check('the send sheet: Email, WhatsApp, Share PDF, and each send with its status', /data-qsend="email"/.test(el.innerHTML) && /data-qsend="whatsapp"/.test(el.innerHTML) && /data-qdoc="share"/.test(el.innerHTML)
  && /Sent/.test(el.innerHTML) && /qs-job/.test(el.innerHTML), el.innerHTML.slice(0, 300));

// quotation → sales order → bill
const fresh = OU.saveOrder({ ...OU.newOrderDraft('quote', { cust: { id: 'c1', name: 'Asha' } }), items: [{ ...OU.orderLine('p1:', 3), disc: { type: 'fixed', value: 50 } }], notes: 'Gift wrap', terms: 'Net 7' }).order;
const cv = OU.convertToSalesOrder(fresh.id);
const so = cv.order;
check('quotation → sales order keeps customer, items, variants, quantities, prices, discounts, GST, notes, terms and the quotation reference; Pending first',
  !cv.error && so.kind === 'sales' && so.status === 'draft' && statusLabel('sales', so.status) === 'Pending' && so.cust.id === 'c1' && so.items[0].v === 'p1:' && so.items[0].q === 3
  && so.items[0].price === 500 && so.items[0].disc.value === 50 && so.items[0].gst === fresh.items[0].gst && so.notes === 'Gift wrap' && so.terms === 'Net 7' && so.quoteId === fresh.id && so.quoteNo === fresh.no
  && so.total === fresh.total && OU.orderById(fresh.id).status === 'converted' && OU.orderById(fresh.id).convertedTo === so.id, cv);
check('a Pending sales order isn\'t billed until confirmed', /Confirm the sales order first/.test(OU.orderToCart(so.id).error || ''));
const conf = OU.setOrderStatus(so.id, 'confirmed');
check('…Confirmed', !conf.error && OU.orderById(so.id).status === 'confirmed');
const toCart = OU.orderToCart(so.id);
check('Confirmed → its lines go on the bill at the order\'s prices and discounts, for its customer, linked to it', !toCart.error && store.cart.length === 1 && store.cart[0].price === 500 && store.cart[0].disc.value === 50
  && store.cartOrder.id === so.id && store.cartCust.id === 'c1');
store.cart = []; store.cartOrder = null; store.cartCust = null;

// the receipt page the owner's app keeps
store.settings.receiptUrl = '';
check('the owner\'s app sets the shop\'s invoice-link page once, to its own receipt page', RP.rememberReceiptPage(false) === true && store.settings.receiptUrl === 'https://florix-technologies.github.io/hangtag/receipt.html'
  && store.sbOfflineQueue.some((x) => x.type === 'settings'));
globalThis.location = { href: 'https://hangtag.vercel.app/' };
check('…another app address doesn\'t change it by itself; "Use this app\'s page" does', RP.rememberReceiptPage(false) === false && RP.rememberReceiptPage(true) === true && store.settings.receiptUrl === 'https://hangtag.vercel.app/receipt.html');
member('manager', ['manage_settings', 'create_sale']);
store.settings.receiptUrl = '';
check('a team member\'s phone never sets it', RP.rememberReceiptPage(true) === false && store.settings.receiptUrl === '');
ownerAgain();
globalThis.location = { href: 'http://192.168.1.5:3210/' };
check('an address that isn\'t https (a laptop on the shop Wi-Fi) is never used', RP.rememberReceiptPage(true) === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
