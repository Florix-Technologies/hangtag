// One invoice PDF per bill, the same file on every channel (send-receipt core.js "canonical invoice", the app's
// delivery/use-cases/canonical-invoice.js). Server side: the copy a phone registers is checked against the saved bill (a
// PDF, at most 2 MB, showing the bill's number and total); the email attaches that file as its only attachment, WhatsApp
// carries it as a document (a template with a document header), the SMS carries a link to download it and never says
// "attached"; Resend gets an idempotency key; the delivery record names the invoice. App side: a bill's invoice is
// registered once however many channels ask at once; a failed channel is tried again on its own; a send whose answer
// never came back is asked about again (the same press), never sent twice. Providers are fakes here: no message is sent.
// Run: node tests/unit/canonical-invoice.test.mjs
import { readFileSync } from 'node:fs';
import * as SR from '../../supabase/functions/send-receipt/core.js';
import { sendMetaWhatsApp } from '../../supabase/functions/send-receipt/providers/meta-whatsapp.js';
import { sendResendEmail } from '../../supabase/functions/send-receipt/providers/resend.js';
import { docPdfBytes } from '../../src/shared/utils/pdf.js';
import { AppError, ERROR_CODES as C } from '../../src/shared/errors/app-error.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info).slice(0, 600) : '')); };

// ---------- the server: is this copy the bill's invoice? ----------
// a bill's A4 invoice as the app draws it (shared/utils/pdf.js docPdfBytes; ₹ is written "Rs." in the PDF's fonts)
const model = { title: 'Tax Invoice', number: 'INV-0042', meta: [['Invoice no.', 'INV-0042'], ['Date', '26 Oct 2026']], seller: { name: 'Sunrise Garments', lines: ['MG Road, Bengaluru'] },
  parties: [{ label: 'Bill to', name: 'Riya', lines: ['9876543210'] }], columns: ['#', 'Item', 'Qty', 'Rate', 'Discount', 'Amount'], left: 2,
  rows: [['1', { t: 'Linen shirt', sub: 'M / Blue' }, '2', '₹500.00', '—', '₹1,000.00'], ['2', { t: 'Belt' }, '1', '₹250.00', '—', '₹250.00']],
  totals: [['Subtotal', '₹1,250.00'], ['Grand total', '₹1,250.00', true]], words: 'One thousand two hundred fifty rupees only' };
const bytes = docPdfBytes(model, { template: 'standard' });
const SALE = { bill_no: 'INV-0042', total: 1250 };
check('the app\'s invoice PDF of a bill passes as that bill\'s invoice (its number and total are on it)', SR.checkInvoicePdf(bytes, SALE).ok === true, SR.checkInvoicePdf(bytes, SALE));
check('…its text is read back as written (the writer never compresses)', SR.pdfTexts(bytes).includes('Linen shirt') && SR.pdfTexts(bytes).includes('INV-0042'));
check('another bill\'s number: refused (invoice_mismatch)', SR.checkInvoicePdf(bytes, { bill_no: 'INV-0043', total: 1250 }).error === 'invoice_mismatch');
check('another total: refused (invoice_mismatch)', SR.checkInvoicePdf(bytes, { bill_no: 'INV-0042', total: 1300 }).error === 'invoice_mismatch');
check('a total with paise is matched by its digits (Rs. 1,250.50)', SR.checkInvoicePdf(docPdfBytes({ ...model, totals: [['Grand total', '₹1,250.50', true]] }), { bill_no: 'INV-0042', total: 1250.5 }).ok === true);
const notPdf = new TextEncoder().encode('<html>' + 'x'.repeat(400) + '</html>');
check('something that isn\'t a PDF: refused (bad_pdf)', SR.checkInvoicePdf(notPdf, SALE).error === 'bad_pdf');
const huge = new Uint8Array(2097153); huge.set(new TextEncoder().encode('%PDF-1.4'), 0); huge.set(new TextEncoder().encode('%%EOF\n'), huge.length - 6);
check('more than 2 MB: refused (too_large)', SR.checkInvoicePdf(huge, SALE).error === 'too_large');
const b64 = SR.base64Of(bytes), back = SR.pdfFromBase64(b64);
check('base64 there and back gives the same bytes; anything else isn\'t base64', back && back.length === bytes.length && back.every((x, i) => x === bytes[i]) && SR.pdfFromBase64('not base64!') === null && SR.pdfFromBase64('') === null);
const sha = await SR.sha256Hex(bytes), owner = '11111111-1111-1111-1111-111111111111';
const pathRule = new RegExp(/storage_path ~ '([^']+)'/.exec(readFileSync(new URL('../../supabase/migrations/20261026150000_hangtag_canonical_invoices.sql', import.meta.url), 'utf8'))[1]);
check('the stored file\'s path is <shop>/<sha256>.pdf, as the migration\'s rule requires', /^[0-9a-f]{64}$/.test(sha) && pathRule.test(SR.invoicePath(owner, sha)) && !pathRule.test(SR.invoicePath(owner, '../x')));
check('the file name is safe in a header and a file system', SR.invoiceFileName('INV/0042 A') === 'Invoice-INV-0042-A.pdf' && SR.invoiceFileName('') === 'Invoice-bill.pdf' && SR.invoiceFileName('Invoice-INV-1.pdf') === 'Invoice-INV-1.pdf');

// ---------- the server: requests ----------
const v = SR.validateRequest;
check('"invoice" names the bill; the PDF is optional (without it: the bill\'s invoice, if it has one)', v({ action: 'invoice', sale_id: 's1' }).ok && v({ action: 'invoice', sale_id: 's1' }).pdf === '' && v({ action: 'invoice', sale_id: 's1', pdf: b64 }).pdf === b64);
check('…a PDF over 2 MB is refused before anything is read', v({ action: 'invoice', sale_id: 's1', pdf: 'A'.repeat(2796208) }).status === 413);
check('a send may name its press of Send (request_id) and, for a walk-in bill, a saved customer', (() => { const r = v({ action: 'send', channel: 'email', sale_id: 's1', request_id: 'rabc12345', customer_id: 'c1x' }); return r.ok && r.requestId === 'rabc12345' && r.customerId === 'c1x'; })());
check('…both are checked: a bad id is refused', v({ action: 'send', channel: 'email', sale_id: 's1', request_id: 'bad id!' }).status === 400 && v({ action: 'send', channel: 'sms', sale_id: 's1', customer_id: 'c 1;' }).status === 400);

// ---------- the server: the messages carry the one file ----------
const bill = { sale: { bill_no: 'INV-0042', total: 1250, timestamp: '2026-10-26T10:00:00Z', tax_amount: 0 }, items: [{ line_no: 1, product_name: 'Linen shirt', quantity: 2, unit_price: 500 }, { line_no: 2, product_name: 'Belt', quantity: 1, unit_price: 250 }],
  payments: [{ method: 'cash', amount: 1250 }], shop: { shop_name: 'Sunrise Garments' }, customer: { name: 'Riya' }, region: 'IN' };
const logo = { base64: 'iVBORw0KGgo=', contentType: 'image/png', ext: 'png', align: 'left' };
const email = SR.billMessage('email', { ...bill, logo, pdf: { base64: b64, filename: 'INV-0042' } });
check('email: the invoice PDF is its one attachment — the same bytes, application/pdf, named Invoice-<number>.pdf', email.attachments.length === 1 && email.attachments[0].content === b64
  && email.attachments[0].content_type === 'application/pdf' && email.attachments[0].filename === 'Invoice-INV-0042.pdf', email.attachments.map((a) => ({ ...a, content: a.content.length })));
check('…no inline logo beside it, no second try without it, and the email says it is attached', !email.plainHtml && !/cid:/.test(email.html) && /attached as a PDF \(Invoice-INV-0042\.pdf\)/.test(email.html) && /attached as a PDF/.test(email.text));
check('an email of a bill without an invoice PDF is as before (the logo inline)', (() => { const m = SR.billMessage('email', { ...bill, logo }); return m.attachments.length === 1 && m.attachments[0].content_id === SR.LOGO_CID && !!m.plainHtml; })());
const sms = SR.billMessage('sms', { ...bill, link: 'https://shop.example/receipt.html#tok123', pdfLink: true });
check('SMS: one message with the link to download the invoice PDF, never "attached"', /Download your bill \(PDF\): https:\/\/shop\.example\/receipt\.html#tok123$/.test(sms.text) && !/attach/i.test(sms.text) && sms.text.length <= SR.LIMITS.sms, sms.text);
const wa = SR.billMessage('whatsapp', { ...bill, link: 'https://shop.example/receipt.html#tok123', pdfLink: true, document: { link: 'https://signed.example/f.pdf?token=x', filename: 'INV-0042' } });
check('WhatsApp: the invoice PDF as the template\'s document; the body values as before', wa.document && wa.document.link === 'https://signed.example/f.pdf?token=x' && wa.document.filename === 'Invoice-INV-0042.pdf' && wa.params.length === 4, wa);
check('the delivery record names the invoice it carried', SR.reservationRow({ ownerId: owner, saleId: 's1', invoiceId: 'inv1', requestId: 'r12345678', channel: 'email', to: 'a@b.in', provider: 'resend' }).invoice_id === 'inv1');
const metaEnv = { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_TEMPLATE: 'bill', WHATSAPP_QUOTE_TEMPLATE: 'quote' };
check('the app is told whether WhatsApp carries the PDF itself (a template with a document header) or its link',
  SR.configuredChannels({ ...metaEnv, WHATSAPP_TEMPLATE_DOCUMENT: 'on' }).whatsapp_pdf === true && SR.configuredChannels(metaEnv).whatsapp_pdf === false
  && !SR.providerConfig('whatsapp', { ...metaEnv, WHATSAPP_TEMPLATE_DOCUMENT: 'on' }, 'quote').documentHeader);

// ---------- the providers (fake fetch: nothing leaves) ----------
{
  const calls = [];
  const fake = (status, json) => async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => json }; };
  const cfg = SR.providerConfig('whatsapp', { ...metaEnv, WHATSAPP_TEMPLATE_DOCUMENT: 'on' });
  const r = await sendMetaWhatsApp(cfg, { to: '+919876543210', params: wa.params, document: wa.document }, fake(200, { messages: [{ id: 'wamid.1' }] }));
  const body = JSON.parse(calls[0].init.body), comps = body.template.components;
  check('Meta WhatsApp: the document header carries the invoice PDF\'s address and file name, then the body values',
    r.ok && comps[0].type === 'header' && comps[0].parameters[0].type === 'document' && comps[0].parameters[0].document.link === wa.document.link && comps[0].parameters[0].document.filename === 'Invoice-INV-0042.pdf' && comps[1].type === 'body', comps);
  calls.length = 0;
  const no = await sendMetaWhatsApp(cfg, { to: '+919876543210', params: wa.params }, fake(200, {}));
  check('…a template that expects the document is never sent without it', !no.ok && no.code === 'no_document' && calls.length === 0);
  calls.length = 0;
  const e1 = await sendResendEmail({ apiKey: 'k', from: 'bills@shop.in' }, { to: 'a@b.in', subject: 's', html: 'h', text: 't', attachments: email.attachments, idempotencyKey: 'shop:r123' }, fake(422, { name: 'validation_error', message: 'attachment' }));
  check('Resend: the request carries an idempotency key; an email with the invoice PDF refused is not sent again without it',
    !e1.ok && calls.length === 1 && calls[0].init.headers['Idempotency-Key'] === 'shop:r123', calls.map((c) => c.init.headers));
  calls.length = 0;
  await sendResendEmail({ apiKey: 'k', from: 'bills@shop.in' }, { ...SR.billMessage('email', { ...bill, logo }), to: 'a@b.in', idempotencyKey: 'shop:r124' }, fake(422, { name: 'validation_error' }));
  check('…the logo email\'s second try (without the picture) has a key of its own', calls.length === 2 && calls[1].init.headers['Idempotency-Key'] === 'shop:r124:plain');
}

// ---------- the app: one registration per bill, channels on their own ----------
installFakeDom();
globalThis.window = globalThis.window || { addEventListener(){} };
memStorage();
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: {}, dirty: new Set(), returnsMap: {}, _d: null, customers: { c1: { id: 'c1', name: 'Riya', phone: '9876543210', email: 'riya@mail.in' } },
  cartCust: null, disc: null, cart: [], sbOfflineQueue: [], syncReview: [], sbClient: {}, sbStatus: 'connected', events: {}, prefs: { event: '' }, lastCheckout: 0, deliveries: {},
  channels: { email: true, whatsapp: true, sms: true }, settings: { taxOn: false, prefix: 'INV-' }, profile: { shop_name: 'Sunrise Garments' }, moves: {}, cashMoves: {}, dayCloses: {}, deliveryQueue: [],
  catalog: { version: 3, products: [{ id: 'p1', name: 'Tee', price: 500, opts: [], variants: [{ id: 'p1:', o: [], active: true }] }] } });
override({ cloud: { async saveSale(){}, async setSaleVoid(){} } });
const { newSaleRecord, recordSale } = await import('../../src/features/sales/use-cases/checkout.js');
const CI = await import('../../src/features/delivery/use-cases/canonical-invoice.js');
const SI = await import('../../src/features/delivery/use-cases/send-invoice.js');
const server = { invoices: {}, registrations: 0, asks: 0, sends: [], fail: {} };
override({ messageDelivery: {
  async channels(){ return store.channels; },
  async invoice({ saleId, pdf }){
    server.asks++;
    await new Promise((r) => setTimeout(r, 30));   // slow enough for two channels to ask at once
    if (server.invoices[saleId]) return { invoice: server.invoices[saleId], url: 'https://files.example/x', already: true };
    if (!pdf) throw new AppError(C.VALIDATION, 'This bill has no invoice PDF yet.', { details: { error: 'no_invoice' } });
    if (server.netDown) throw new AppError(C.NETWORK, 'offline');
    server.registrations++;
    const head = Buffer.from(pdf, 'base64').subarray(0, 5).toString('latin1');
    return { invoice: (server.invoices[saleId] = { id: 'inv' + server.registrations, number: 'x', sha256: 'h', filename: 'Invoice-x.pdf', head }), url: 'https://files.example/x' };
  },
  async send(r){
    server.sends.push(r);
    const f = server.fail[r.channel];
    if (f === 'provider') throw new AppError(C.DELIVERY, "The SMS service didn't accept the message", { details: { error: 'provider_error' } });
    if (f === 'lost') throw new AppError(C.NETWORK, 'No internet connection.');
    return { status: 'sent', to: r.channel === 'email' ? 'riya@mail.in' : '+919876543210', provider: 'fake', id: 'm' + server.sends.length, invoiceId: server.invoices[r.saleId] && server.invoices[r.saleId].id, format: r.channel === 'email' ? 'attachment' : 'pdf_link' };
  },
} });
const sale = newSaleRecord([{ v: 'p1:', p: 'p1', name: 'Tee', q: 1, price: 500 }], null, 'cash', { cust: { id: 'c1', name: 'Riya', phone: '9876543210' } });
recordSale(sale); store.sbOfflineQueue = [];
const [a, b] = await Promise.all([CI.ensureInvoice(sale.id), CI.ensureInvoice(sale.id)]);
check('two channels asking at once: one invoice registered (one upload), both get it', server.registrations === 1 && a.invoice && b.invoice && a.invoice.id === b.invoice.id, { registrations: server.registrations, a, b });
check('…the file registered is this phone\'s own invoice PDF of the bill (a PDF)', server.invoices[sale.id].head === '%PDF-');
const asksBefore = server.asks;
const [e, s, w] = await Promise.all([SI.sendInvoice(sale.id, 'email'), SI.sendInvoice(sale.id, 'sms'), SI.sendInvoice(sale.id, 'whatsapp')]);
check('email, SMS and WhatsApp all go, each with the one invoice: none registered again', e.ok && s.ok && w.ok && server.registrations === 1 && server.asks === asksBefore && server.sends.length === 3, { e, s, w, sends: server.sends.length });
check('each send is one press of its own (its own request id); none carries a recipient or a message', new Set(server.sends.map((x) => x.requestId)).size === 3 && server.sends.every((x) => /^[A-Za-z0-9_-]{8,64}$/.test(x.requestId) && !('to' in x) && !('message' in x)));
check('what the customer got is kept per channel (email: PDF attached; SMS: link to the PDF)', SI.deliveriesOf(sale.id).find((x) => x.channel === 'email').format === 'attachment' && SI.deliveriesOf(sale.id).find((x) => x.channel === 'sms').format === 'pdf_link');

// a failed channel is tried again on its own: the others aren't sent again, no new invoice, no new sale
server.sends.length = 0; server.fail = { sms: 'provider' };
const f1 = await SI.sendInvoice(sale.id, 'sms');
check('the SMS provider refuses: shown as not sent (failed), nothing claimed', !f1.ok && SI.deliveriesOf(sale.id)[0].status === 'failed' && server.sends.length === 1);
server.fail = {};
const f2 = await SI.sendInvoice(sale.id, 'sms');
check('Try again sends the SMS only — a new press (new request id), the same invoice, the email not sent again', f2.ok && server.sends.length === 2 && server.sends.every((x) => x.channel === 'sms') && server.sends[0].requestId !== server.sends[1].requestId && server.registrations === 1);
const bills = Object.values(store.localDays).flatMap((d) => d.sales).filter((x) => x.id === sale.id).length;
check('…and the bill is still one bill (no sale made again)', bills === 1, bills);

// no answer came back: "unknown", and trying again asks about the same press (the server answers what happened to it)
server.sends.length = 0; server.fail = { email: 'lost' };
const u1 = await SI.sendInvoice(sale.id, 'email');
const lost = SI.deliveriesOf(sale.id)[0];
check('the connection drops mid-send: "unknown" (it may have gone out), never "failed" or "sent"', !u1.ok && lost.status === 'unknown' && lost.channel === 'email');
server.fail = {};
await SI.sendInvoice(sale.id, 'email');
check('…trying again is the same press (same request id): the server can answer with the first result instead of sending twice', server.sends.length === 2 && server.sends[0].requestId === server.sends[1].requestId);

// the invoice can't be had (offline at the server): nothing is sent, and it says why
const sale2 = newSaleRecord([{ v: 'p1:', p: 'p1', name: 'Tee', q: 2, price: 500 }], null, 'cash', { cust: { id: 'c1', name: 'Riya', phone: '9876543210' } });
recordSale(sale2); store.sbOfflineQueue = [];
server.sends.length = 0; server.netDown = true;
const n1 = await SI.sendInvoice(sale2.id, 'email');
check('the invoice PDF can\'t be registered: nothing is sent, the bill says it wasn\'t', !n1.ok && server.sends.length === 0 && SI.deliveriesOf(sale2.id)[0].status === 'failed');
server.netDown = false;

// a server that keeps no invoice PDFs (an older function): the message goes as before, never claimed as carrying a PDF
CI.resetInvoices();
override({ messageDelivery: { async channels(){ return store.channels; }, async send(r){ server.sends.push(r); return { status: 'sent', to: 'riya@mail.in', provider: 'fake', id: 'old1' }; } } });
server.sends.length = 0;
const o1 = await SI.sendInvoice(sale2.id, 'email');
check('an older server (no "invoice"): the email goes as before, and the bill doesn\'t say a PDF went', o1.ok && server.sends.length === 1 && !o1.format);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
