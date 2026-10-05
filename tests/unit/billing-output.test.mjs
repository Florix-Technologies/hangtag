// Invoices, receipts, thermal printing and sending bills (Phases 13-16): the invoice model built from saved bills, amounts
// in words, the thermal receipt layout, delivery rules, the Epson ePOS adapter (with a fake printer), logo rasters,
// printer settings, the print and send use cases with fake ports, and the logo's upload queue. The messages themselves are
// written by the send-receipt function (tests/unit/send-receipt.test.mjs). Run: npm run test:unit
import { amountInWords, numberInWords } from '../../src/domain/invoices/amount-words.js';
import { buildInvoice, gstLines, isValidInvoice, sellerOf } from '../../src/domain/invoices/invoice.js';
import { deliveryTarget, mobileE164 } from '../../src/domain/invoices/delivery.js';
import { asciiText, columns, pair, thermalReceipt, wrap } from '../../src/domain/receipts/thermal.js';
import { checkPrinterSettings, printerOf } from '../../src/domain/shop/printer-settings.js';
import { createEpsonPrinter, eposUrl, eposXml, parseEposResponse, printerErrorMessage } from '../../src/infrastructure/printing/epson-epos.js';
import { monoRaster } from '../../src/infrastructure/printing/raster.js';
import { createDeliveryClient } from '../../src/infrastructure/messaging/delivery-client.js';
import { docPdfBytes } from '../../src/shared/utils/pdf.js';
import { createCloudGateway } from '../../src/infrastructure/supabase/cloud-gateway.js';
import { AppError, ERROR_CODES as C } from '../../src/shared/errors/app-error.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- the shop and bills as the app saves them ----------
const mem = {};
override({ storage: { get: (k, f) => (k in mem ? mem[k] : f), set: (k, v) => { mem[k] = v; return true; }, getRaw: (k) => mem[k] ?? null, setRaw: (k, v) => { mem[k] = v; }, remove: (k) => { delete mem[k]; } } });
const profile = { shop_name: 'Aura Threads', address: '12 MG Road', city: 'Pune', state: 'Maharashtra', phone: '9876543210', gstin: '27ABCDE1234F1Z5' };
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: { 'today_d1_0': { date: 'x', dev: 'd1', chunk: 0, sales: [], voids: [] } }, dirty: new Set(), returnsMap: {}, moves: {}, _d: null,
  customers: { c1: { id: 'c1', name: 'Blr Traders', phone: '98450 12345', email: 'accounts@blr.in', gstin: '29ABCDE1234F1Z5', type: 'business' }, c2: { id: 'c2', name: 'Riya', phone: '', email: '' } },
  cartCust: null, disc: null, settings: { taxOn: true, taxRate: 5, taxIncl: false, prefix: 'INV-', footer: 'Thank you!' }, profile, logo: '', sbOfflineQueue: [], deliveries: {}, channels: null, printer: printerOf(null),
  catalog: { version: 3, products: [{ id: 'p1', name: 'Kurta – Blue', price: 999, gst: 12, hsn: '6109', opts: [{ n: 'Size', v: ['M'] }], variants: [{ id: 'p1:M', o: ['M'], active: true }] },
    { id: 'p2', name: 'Cap', price: 500, gst: null, opts: [], variants: [{ id: 'p2:', o: [], active: true }] }] } });
const { newSaleRecord } = await import('../../src/features/sales/use-cases/checkout.js');
const lines = () => [{ v: 'p1:M', p: 'p1', name: 'Kurta – Blue', c: '', s: 'M', ov: [{ n: 'Size', v: 'M' }], q: 2, price: 999, disc: { type: 'percent', value: 10 } }, { v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 500 }];
const put = (s) => { store.localDays.today_d1_0.sales.push(s); store._d = null; return s; };
// B2B customer in Karnataka: IGST; split payment
store.cartCust = { id: 'c1', name: 'Blr Traders', phone: '98450 12345' };
const due1 = (() => { const s = newSaleRecord(lines(), { type: 'fixed', value: 50 }, { method: 'card', ref: 'APPR1' }); return s.total; })();
const b2b = put(newSaleRecord(lines(), { type: 'fixed', value: 50 }, [{ method: 'cash', amount: 1000, received: 1500 }, { method: 'upi', amount: due1 - 1000, ref: 'UTR998877', confirmed: true }]));
// walk-in, same state (CGST + SGST), cash
store.cartCust = null;
const walk = put(newSaleRecord([{ v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 500 }], null, 'cash'));
// no GST shop setting: a plain invoice
store.settings.taxOn = false;
const noGst = put(newSaleRecord([{ v: 'p2:', p: 'p2', name: 'Cap', q: 2, price: 500 }], null, { method: 'upi', ref: '412345678901', confirmed: true }));
store.settings.taxOn = true;
// a bill saved before line discounts / GST split (legacy shape)
const legacy = { id: 'old1', no: 'INV-250101-001', t: Date.parse('2025-01-01T10:00:00Z'), items: [{ ln: 0, p: 'p2', n: 'Cap', c: '', s: '', q: 2, price: 525 }], sub: 1050, disc: 50, tax: 48, taxRate: 5, taxIncl: true, total: 1000, credit: 0, pay: 'cash', cust: null };

// ---------- the invoice: built from the saved bill, nothing recalculated ----------
const inv = buildInvoice(b2b, { profile, customer: store.customers.c1, returns: [], footer: 'Thank you!', logo: 'data:image/png;base64,AAA' });
check('seller from the shop profile (name, address, phone, GSTIN, state code)', eq(inv.seller, { name: 'Aura Threads', address: '12 MG Road, Pune, Maharashtra', phone: '9876543210', gstin: '27ABCDE1234F1Z5', stateCode: '27', stateName: 'Maharashtra' }));
check('buyer from the bill and the customer record (GSTIN, email, business)', inv.buyer.name === 'Blr Traders' && inv.buyer.gstin === '29ABCDE1234F1Z5' && inv.buyer.email === 'accounts@blr.in' && inv.buyer.business);
check('a GST bill is a Tax Invoice with IGST and the place of supply', inv.title === 'Tax Invoice' && inv.gstMode === 'inter' && eq(inv.placeOfSupply, { code: '29', name: 'Karnataka' }) && inv.totals.igst > 0 && inv.totals.cgst === 0);
check('every total is the one saved on the bill', inv.totals.subtotal === b2b.sub && inv.totals.discount === b2b.disc && inv.totals.itemDiscount === b2b.itemDisc && inv.totals.billDiscount === b2b.billDiscAmt
  && inv.totals.taxable === b2b.taxable && inv.totals.tax === b2b.tax && inv.totals.igst === b2b.igst && inv.totals.roundOff === b2b.roundOff && inv.totals.total === b2b.total);
check('lines carry their variant, HSN, line discount, taxable value, rate, IGST and total as saved', (() => { const l = inv.lines[0], i = b2b.items[0]; return l.name === 'Kurta – Blue' && l.variant === 'M' && l.hsn === '6109' && l.discount === i.dAmt && l.discountLabel === '10%' && l.taxable === i.tx && l.gstRate === 12 && l.igst === i.igst && l.total === i.lt && l.gross === 1998; })());
check('GST by rate adds up the saved lines (12% and the shop\'s 5%)', eq(inv.taxSummary.map((r) => r.rate), [5, 12]) && Math.round(inv.taxSummary.reduce((a, r) => a + r.tax, 0) * 100) === Math.round(b2b.tax * 100));
check('split payments: each part, cash received and change; paid = due, nothing left', eq(inv.payments.map((p) => [p.label, p.amount, p.received, p.change, p.ref]), [['Cash', 1000, 1500, 500, ''], ['UPI', due1 - 1000, null, 0, 'UTR998877']])
  && inv.paid === inv.totals.due && inv.balance === 0 && inv.change === 500);
check('amount in words for the total', inv.amountInWords === amountInWords(b2b.total) && /^Rupees .+ Only$/.test(inv.amountInWords));
check('logo and footer come along', inv.logo === 'data:image/png;base64,AAA' && inv.footer === 'Thank you!');
const walkInv = buildInvoice(walk, { profile });
check('walk-in: no buyer, CGST + SGST halves, place of supply the shop\'s state', walkInv.buyer === null && walkInv.gstMode === 'intra' && walkInv.totals.cgst === walkInv.totals.sgst && walkInv.placeOfSupply.code === '27');
check('GST lines name the rate when the bill has one (CGST 2.5% + SGST 2.5%)', eq(gstLines(walkInv).map((g) => g.label), ['CGST 2.5%', 'SGST 2.5%']));
const noGstInv = buildInvoice(noGst, { profile });
check('non-GST bill: an Invoice with no GST rows and no GST summary', noGstInv.title === 'Invoice' && gstLines(noGstInv).length === 0 && noGstInv.taxSummary.length === 0 && noGstInv.totals.tax === 0);
const legInv = buildInvoice(legacy, { profile });
check('a bill saved before line GST: totals as saved, GST as CGST + SGST halves, one summary row, lines without line tax', legInv.lineTax === false && legInv.totals.cgst === 24 && legInv.totals.sgst === 24
  && legInv.totals.taxable === 952 && legInv.totals.billDiscount === 50 && legInv.taxSummary.length === 1 && legInv.taxSummary[0].rate === 5 && legInv.payments[0].amount === 1000);
check('a cancelled bill is not a valid invoice', buildInvoice({ ...walk, void: true }, { profile }).status === 'cancelled' && !isValidInvoice(buildInvoice({ ...walk, void: true }, { profile })) && isValidInvoice(walkInv));
const exch = { ...walk, id: 'x1', kind: 'exchange', credit: 300, payments: [{ id: 'x1:cash', method: 'cash', amount: walk.total - 300, received: walk.total - 300, change: 0 }] };
const exInv = buildInvoice(exch, { profile, returns: [{ id: 'r1', kind: 'return', t: 1, value: 200, refund: 200, pay: 'cash', items: [{ n: 'Cap', q: 1 }] }] });
check('exchange: credit, amount due and what was paid; returns listed with the refund', exInv.kind === 'exchange' && exInv.totals.credit === 300 && exInv.totals.due === walk.total - 300 && exInv.paid === exInv.totals.due
  && exInv.returned === 200 && exInv.refunded === 200 && exInv.returns[0].label === 'Cash');
check('an exchange fully covered by its credit has no payments and nothing due', (() => { const I = buildInvoice({ ...walk, kind: 'exchange', credit: walk.total, payments: [] }, { profile }); return I.totals.due === 0 && I.payments.length === 0 && I.balance === 0; })());
const edited = buildInvoice({ ...walk, cust: { id: 'c1', name: 'Blr Traders', phone: '98450 12345' } }, { profile, customer: store.customers.c1 });
check('the buyer\'s GSTIN and type are the ones the bill was made with (a customer edited later doesn\'t change the invoice)', edited.buyer.gstin === '' && !edited.buyer.business && edited.buyer.email === 'accounts@blr.in');
check('shop without a GSTIN: state from its name', eq(sellerOf({ shop_name: 'X', state: 'Karnataka' }).stateCode, '29') && sellerOf({}).name === 'My shop');

// ---------- amounts in words (Indian numbering) ----------
check('words: zero, teens, hundreds, thousand, lakh, crore', numberInWords(0) === 'Zero' && numberInWords(15) === 'Fifteen' && numberInWords(105) === 'One Hundred Five'
  && numberInWords(2098) === 'Two Thousand Ninety Eight' && numberInWords(150000) === 'One Lakh Fifty Thousand' && numberInWords(12345678) === 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
check('rupees and paise', amountInWords(1048.5) === 'Rupees One Thousand Forty Eight and Fifty Paise Only' && amountInWords(1) === 'Rupees One Only');

// ---------- the thermal receipt ----------
const th = thermalReceipt(inv, { cols: 48 });
const text = th.lines.map((l) => l.text);
check('every line fits the paper width (48 columns)', text.every((t) => t.length <= 48), text.filter((t) => t.length > 48));
check('plain ASCII only (the printer has no ₹ or dashes)', text.every((t) => /^[\x20-\x7E]*$/.test(t)) && asciiText('Kurta – Blue ₹10 × 2') === 'Kurta - Blue Rs.10 x 2');
check('header: shop name big and bold, address, phone, GSTIN, TAX INVOICE', th.lines[0].text === 'Aura Threads' && th.lines[0].big && th.lines[0].bold && text.includes('GSTIN: 27ABCDE1234F1Z5') && text.includes('TAX INVOICE'));
check('bill number, customer, place of supply', text.some((t) => t.startsWith('Bill: ' + b2b.no)) && text.includes('Customer: Blr Traders') && text.includes('Place of supply: Karnataka (29)'));
check('items with quantity × price, the line amount and the discount', text.some((t) => /^  2 x 999\.00 +1,998\.00$/.test(t)) && text.some((t) => /^  Discount 10% +-199\.80$/.test(t)));
check('totals: subtotal, discounts, taxable, IGST, TOTAL (bold, big)', text.some((t) => /^Subtotal +2,498\.00$/.test(t)) && text.some((t) => t.startsWith('IGST')) && th.lines.some((l) => /^TOTAL +Rs\./.test(l.text) && l.bold && l.big));
check('split payment lines with received / change and the UPI reference', text.some((t) => /^Paid by Cash +1,000\.00$/.test(t)) && text.some((t) => /Received 1,500\.00 +Change 500\.00/.test(t)) && text.includes('  Ref: UTR998877'));
check('footer and logo flag', text.includes('Thank you!') && th.logo === 'data:image/png;base64,AAA');
check('58 mm paper: 32 columns', thermalReceipt(inv, { cols: 32 }).lines.every((l) => l.text.length <= 32) && thermalReceipt(inv, { cols: 99 }).cols === 48);
check('a cancelled bill prints CANCELLED', thermalReceipt(buildInvoice({ ...walk, void: true }, { profile })).lines.some((l) => l.text === '*** CANCELLED ***'));
check('wrap and pair', eq(wrap('aaa bbb ccc', 7), ['aaa bbb', 'ccc']) && eq(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']) && pair('Left side long', '99.00', 12) === 'Left s 99.00');
check('columns: one line when it fits, otherwise the left text wrapped and the right text below — nothing cut', eq(columns('Total', '9.00', 12), ['Total   9.00'])
  && eq(columns('  Received 12,000.00', 'Change 1,499.50', 32), ['  Received 12,000.00', '                 Change 1,499.50'])
  && eq(columns('  Discount Festive offer for loyal customers only', '-1,234.00', 32), ['  Discount Festive offer for', '  loyal customers only', '                       -1,234.00']));
const narrow = thermalReceipt({ ...inv, placeOfSupply: { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' }, payments: [{ ...inv.payments[1], ref: 'UTR-0123456789-ABCDEFGHIJ-0123456789' }] }, { cols: 32 }).lines.map((l) => l.text);
check('58 mm: a long place of supply and a long payment reference wrap instead of running off the paper', narrow.every((t) => t.length <= 32) && narrow.join(' ').includes('Daman and Diu (26)') && narrow.join('').includes('UTR-0123456789-ABCDEFGHIJ-0123456789'.slice(0, 20)));
// the A4 PDF: a long place of supply wraps in the header instead of losing its state code
const a4pdf = Buffer.from(docPdfBytes({ seller: { name: 'Aura Threads', lines: ['12 MG Road'] }, title: 'Tax Invoice',
  meta: [['Invoice no.', 'INV-1'], ['Date', '25 September 2026'], ['Place of supply', 'Dadra and Nagar Haveli and Daman and Diu (26)']],
  parties: [], columns: ['#', 'Item', 'Amount'], left: 2, rows: [['1', { t: 'Kurta' }, 'Rs 999']], totals: [['Total', 'Rs 999', true]] })).toString('latin1');
check('A4 PDF: a long place of supply wraps and keeps its code (26), nothing cut off', a4pdf.startsWith('%PDF') && a4pdf.includes('(Daman and Diu \\(26\\))') && !/Dadra and Nagar[^)]*\.\.\./.test(a4pdf), a4pdf.match(/\((?:Dadra|Haveli|Daman)[^)]*\)/g));
const onAcct = { ...inv, payments: [{ ...inv.payments[0], amount: 1000, received: 1000, change: 0 }], paid: 1000, balance: inv.totals.due - 1000 };
const acctLines = thermalReceipt(onAcct, { cols: 48 }).lines.map((l) => l.text);
check('printed receipt of a bill left partly on account: what was paid, then BALANCE DUE (on account) — never "Paid" for the whole bill', acctLines.some((t) => /Paid by Cash\s+1,000\.00/.test(t))
  && acctLines.some((t) => /BALANCE DUE \(on account\)\s+[\d,]+\.\d\d/.test(t)) && !acctLines.some((t) => /Nothing to pay/.test(t)), acctLines.slice(-12));
const allAcct = thermalReceipt({ ...inv, payments: [], paid: 0, balance: inv.totals.due }, { cols: 48 }).lines.map((l) => l.text);
check('...and of a bill all on account: no "Nothing to pay", only the balance due', !allAcct.some((t) => /Nothing to pay/.test(t)) && allAcct.some((t) => /BALANCE DUE/.test(t)), allAcct.slice(-8));
const longNo = thermalReceipt({ ...inv, number: 'INV-260925-001' }, { cols: 32 }).lines.map((l) => l.text), cashBig = { ...inv, payments: [{ ...inv.payments[0], received: 12000, change: 1499.5 }] };
check('58 mm: the bill number and the cash received are printed whole', longNo.some((t) => t.includes('Bill: INV-260925-001')) && longNo.every((t) => t.length <= 32)
  && thermalReceipt(cashBig, { cols: 32 }).lines.some((l) => l.text.includes('Received 12,000.00')));
check('double-width lines (shop name, TOTAL) are laid out at half the columns', [48, 42, 32].every((c) => thermalReceipt({ ...inv, seller: { ...inv.seller, name: 'Aura Threads Fashion House Pune' } }, { cols: c }).lines.filter((l) => l.big).every((l) => l.text.length <= c / 2))
  && thermalReceipt(inv, { cols: 48 }).lines.filter((l) => l.big && /TOTAL|Rs\./.test(l.text)).length >= 1);
const zero = put(newSaleRecord([{ v: 'p2:', p: 'p2', name: 'Cap', q: 1, price: 500 }], { type: 'percent', value: 100 }, 'cash'));
check('a bill with nothing to pay (100% discount, no exchange) says so — not "covered by credit"', zero.total === 0 && thermalReceipt(buildInvoice(zero, { profile })).lines.some((l) => l.text === 'Nothing to pay')
  && !thermalReceipt(buildInvoice(zero, { profile })).lines.some((l) => /credit/.test(l.text)));
const { receiptHTML } = await import('../../src/features/receipts/components/receipt-view.js');
const { receiptText } = await import('../../src/features/receipts/services/receipt-model.js');
check('…on the receipt and in the WhatsApp text too', /Nothing to pay/.test(receiptHTML(zero, '80mm')) && !/exchange credit/.test(receiptHTML(zero, '80mm')) && /Nothing to pay/.test(receiptText(zero)));

// ---------- who a bill can be sent to ----------
check('mobile numbers: 10 digits, +91, 0 prefix; landlines and junk refused', mobileE164('98450 12345') === '+919845012345' && mobileE164('+91-98450-12345') === '+919845012345' && mobileE164('09845012345') === '+919845012345'
  && mobileE164('0201234567') === '' && mobileE164('12345') === '');
check('email to the customer\'s saved address; SMS / WhatsApp to their mobile', deliveryTarget(inv, 'email').to === 'accounts@blr.in' && deliveryTarget(inv, 'sms').to === '+919845012345' && deliveryTarget(inv, 'whatsapp').to === '+919845012345');
check('walk-in bills can\'t be sent (no customer)', /walk-in/.test(deliveryTarget(walkInv, 'email').error) && /walk-in/.test(deliveryTarget(walkInv, 'sms').error));
const riya = buildInvoice({ ...walk, cust: { id: 'c2', name: 'Riya', phone: '' } }, { profile, customer: store.customers.c2 });
check('missing contact details are named', /Riya has no email address/.test(deliveryTarget(riya, 'email').error) && /Riya has no mobile number/.test(deliveryTarget(riya, 'sms').error));
const riyaBillPhone = buildInvoice({ ...walk, cust: { id: 'c2', name: 'Riya', phone: '98450 11111' } }, { profile, customer: store.customers.c2 });
check('texts go to the mobile saved in Customers, not the copy on the bill (as the server does)', riyaBillPhone.buyer.phone === '98450 11111' && /Riya has no mobile number/.test(deliveryTarget(riyaBillPhone, 'sms').error));
check('cancelled bills can\'t be sent; unknown channels refused', /cancelled/.test(deliveryTarget(buildInvoice({ ...b2b, void: true }, { profile, customer: store.customers.c1 }), 'email').error) && !!deliveryTarget(inv, 'fax').error);

// ---------- printer settings ----------
check('printer: browser by default', printerOf(null).kind === 'browser' && checkPrinterSettings({}).printer.kind === 'browser');
check('Epson needs an address; http(s):// and slashes are tidied; bad addresses and device IDs refused', !!checkPrinterSettings({ kind: 'epson' }).error && checkPrinterSettings({ kind: 'epson', host: 'https://192.168.1.50/' }).printer.host === '192.168.1.50'
  && checkPrinterSettings({ kind: 'epson', host: 'bad host!' }).field === 'host' && checkPrinterSettings({ kind: 'epson', host: '10.0.0.9', devid: 'x y' }).field === 'devid'
  && checkPrinterSettings({ kind: 'epson', host: 'tm-m30.local:8043', cols: '32', https: false }).printer.cols === 32 && checkPrinterSettings({ kind: 'epson', host: '10.0.0.9', https: false }).printer.https === false);

// ---------- Epson ePOS adapter ----------
const doc = thermalReceipt(inv);
const x = eposXml(doc, { logo: { width: 16, height: 1, base64: 'AAA=' } });
check('ePOS-Print request: SOAP envelope, text per line with alignment / bold / double size, logo image, feed and cut', /^<\?xml/.test(x) && x.includes('<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">')
  && x.includes('<text align="center" em="true" dw="true" dh="true">Aura Threads&#10;</text>') && x.includes('<image width="16" height="1" color="color_1" mode="mono">AAA=</image>') && x.includes('<cut type="feed"/>'));
check('ePOS text is XML-escaped', eposXml({ lines: [{ text: 'A&B <c>' }] }).includes('A&amp;B &lt;c&gt;'));
check('printer address: https by default, device id and timeout', eposUrl({ host: '192.168.1.50', devid: 'local_printer' }) === 'https://192.168.1.50/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000'
  && eposUrl({ host: 'p', https: false, devid: 'a b' }).startsWith('http://p/cgi-bin/epos/service.cgi?devid=a%20b'));
check('the printer\'s answer is read', eq(parseEposResponse('<s:Envelope><s:Body><response success="true" code="" status="251658262" xmlns="x"/></s:Body></s:Envelope>'), { success: true, code: '', status: 251658262 })
  && eq(parseEposResponse('<response success="false" code="EPTR_REC_EMPTY" status="8"/>'), { success: false, code: 'EPTR_REC_EMPTY', status: 8 }) && parseEposResponse('garbage').code === 'BadResponse');
const answer = (xmlBody, status = 200) => async (url, opt) => { sent.push({ url, opt }); return { ok: status < 400, status, text: async () => xmlBody }; };
let sent = [];
const cfg = { kind: 'epson', host: '192.168.1.50', https: true, devid: 'local_printer', cols: 48 };
let printer = createEpsonPrinter({ fetch: answer('<response success="true" code="" status="2"/>'), rasterize: async () => ({ width: 8, height: 1, base64: 'gA==' }) });
let res = await printer.print(doc, cfg);
check('print success only when the printer answers success="true"', res.ok === true && sent.length === 1 && sent[0].opt.method === 'POST' && /text\/xml/.test(sent[0].opt.headers['Content-Type']) && sent[0].opt.body.includes('<image width="8"'));
const fails = async (p, d = doc) => { try { await p.print(d, cfg); return null; } catch (e) { return e; } };
let err = await fails(createEpsonPrinter({ fetch: answer('<response success="false" code="EPTR_REC_EMPTY" status="0"/>') }));
check('out of paper → an error saying so, never a success', err instanceof AppError && err.code === C.PRINTER && /out of paper/.test(err.message) && err.details.retry && err.details.code === 'EPTR_REC_EMPTY');
err = await fails(createEpsonPrinter({ fetch: answer('<response success="false" code="EPTR_COVER_OPEN" status="0"/>') }));
check('cover open → error', /cover is open/.test(err && err.message));
err = await fails(createEpsonPrinter({ fetch: async () => { throw new TypeError('Failed to fetch'); } }));
check('printer unreachable → error with the address and the certificate hint', err && err.code === C.PRINTER && /Can't reach the printer at 192\.168\.1\.50/.test(err.message) && /accept its certificate/.test(err.message) && err.details.reason === 'unreachable');
err = await fails(createEpsonPrinter({ fetch: answer('', 500) }));
check('HTTP error from the printer → error', err && /HTTP 500/.test(err.message));
err = await fails(createEpsonPrinter({ fetch: answer('<html>not a printer</html>') }));
check('an answer that isn\'t ePOS → not treated as printed', err && /may not have printed/.test(err.message));
res = await createEpsonPrinter({ fetch: answer('<response success="true" code="" status="2"/>'), rasterize: async () => { throw new Error('bad image'); } }).print(doc, cfg);
check('a logo that can\'t be read prints without it', res.ok === true);
check('unknown printer codes are named, not hidden', /EX_WEIRD/.test(printerErrorMessage('EX_WEIRD')));
check('test print sends a short receipt', await (async () => { sent = []; await createEpsonPrinter({ fetch: answer('<response success="true"/>') }).test(cfg); return sent[0].opt.body.includes('Hangtag test print'); })());

// ---------- logo raster ----------
const px = (vals, w) => ({ width: w, height: vals.length / w, data: Uint8ClampedArray.from(vals.flatMap((v) => (v === 'T' ? [0, 0, 0, 0] : [v, v, v, 255]))) });
const r1 = monoRaster(px([0, 255, 0, 'T', 0, 0, 0, 0, 0], 9));
check('mono raster: dark pixels are dots, light and transparent are not, rows padded to whole bytes', r1.width === 16 && r1.height === 1 && eq([...Buffer.from(r1.base64, 'base64')], [0b10101111, 0b10000000]));

// ---------- the delivery client and the gateway: never "sent" without the provider's id ----------
let invokeAnswer;
const fnClient = { functions: { invoke: async (name, { body }) => { fnCalls.push({ name, body }); return invokeAnswer; } } };
let fnCalls = [];
const gw = createCloudGateway({ getClient: () => fnClient, url: 'https://x.supabase.co', key: 'pk', storageKey: 'k' });
const dc = createDeliveryClient({ cloud: gw });
invokeAnswer = { data: { ok: true, status: 'sent', recipient: 'a@b.in', provider: 'resend', provider_message_id: 're_1' }, error: null };
const okSend = await dc.send({ channel: 'email', saleId: 's1' });
check('sent: the provider\'s id comes back; the request names only the bill and channel (the server writes the message)', eq(okSend, { status: 'sent', to: 'a@b.in', provider: 'resend', id: 're_1', again: false }) && eq(fnCalls[0], { name: 'send-receipt', body: { action: 'send', channel: 'email', sale_id: 's1' } }));
const sendErr = async () => { try { await dc.send({ channel: 'sms', saleId: 's1' }); return null; } catch (e) { return e; } };
invokeAnswer = { data: { ok: true, status: 'sent' }, error: null };
check('an answer without a message id is not a send', (await sendErr()).code === C.DELIVERY);
const errWith = (status, body) => ({ data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { status, json: async () => body } } });
invokeAnswer = errWith(503, { ok: false, error: 'not_configured', message: "Sending by SMS isn't set up for this shop yet." });
check('no provider → NOT_CONFIGURED with the server\'s reason', (await sendErr()).code === C.NOT_CONFIGURED);
invokeAnswer = errWith(422, { ok: false, error: 'missing_contact', message: 'Riya has no mobile number.' });
check('no contact → VALIDATION with the reason', await (async () => { const e = await sendErr(); return e.code === C.VALIDATION && e.message === 'Riya has no mobile number.'; })());
invokeAnswer = errWith(502, { ok: false, status: 'failed', error: 'provider_error', message: "The SMS service didn't accept the message: invalid number" });
check('provider refused → DELIVERY, with its reason', await (async () => { const e = await sendErr(); return e.code === C.DELIVERY && /invalid number/.test(e.message); })());
invokeAnswer = errWith(429, { ok: false, error: 'rate_limited', message: 'Too many messages in the last hour.' });
check('too many → VALIDATION', (await sendErr()).code === C.VALIDATION);
invokeAnswer = errWith(401, { ok: false, error: 'unauthorized', message: 'Sign in again.' });
check('signed out → AUTH (not "it will try again")', (await sendErr()).code === C.AUTH);
invokeAnswer = errWith(401, { code: 401, message: 'Invalid JWT' });
check('sign-in rejected by the platform → AUTH', (await sendErr()).code === C.AUTH);
invokeAnswer = errWith(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
check('send-receipt not deployed → NOT_CONFIGURED (not "it will try again")', (await sendErr()).code === C.NOT_CONFIGURED);
invokeAnswer = { data: { ok: true, channels: { email: true, whatsapp: false, sms: true } }, error: null };
check('channels: which providers the server has', eq(await dc.channels(), { email: true, whatsapp: false, sms: true }));
invokeAnswer = { data: null, error: { message: 'Failed to send a request to the Edge Function' } };
check('channels unknown (offline / not deployed) → null', (await dc.channels()) === null);

// ---------- SendInvoice use case (fake port) ----------
const { sendInvoice, deliveriesOf } = await import('../../src/features/delivery/use-cases/send-invoice.js');
let portCalls = [], portAnswer;
override({ messageDelivery: { channels: async () => ({ email: true, whatsapp: false, sms: true }), history: async () => [], send: async (req) => { portCalls.push(req); if (portAnswer instanceof Error) throw portAnswer; return portAnswer; } } });
store.sbClient = {}; store.sbStatus = 'connected';
portAnswer = { status: 'sent', to: 'accounts@blr.in', provider: 'resend', id: 're_9' };
let r = await sendInvoice(b2b.id, 'email');
check('send by email: the bill and channel go to the server and it is noted as sent', r.ok && r.to === 'accounts@blr.in' && eq(portCalls[0], { channel: 'email', saleId: b2b.id })
  && deliveriesOf(b2b.id)[0].status === 'sent' && deliveriesOf(b2b.id)[0].providerId === 're_9');
portAnswer = new AppError(C.DELIVERY, "The SMS service didn't accept the message: invalid number");
r = await sendInvoice(b2b.id, 'sms');
check('provider failure: reported and noted as failed, never sent', r.error && /didn't accept/.test(r.error) && deliveriesOf(b2b.id)[0].status === 'failed' && deliveriesOf(b2b.id)[0].channel === 'sms');
portAnswer = new AppError(C.NOT_CONFIGURED, "Sending by SMS isn't set up for this shop yet.");
r = await sendInvoice(b2b.id, 'sms');
check('no provider: said plainly, noted as unavailable', /isn't set up/.test(r.error) && r.code === C.NOT_CONFIGURED && deliveriesOf(b2b.id)[0].status === 'unavailable');
portCalls = [];
r = await sendInvoice(walk.id, 'email');
check('walk-in bill: refused before anything is sent', /walk-in/.test(r.error) && portCalls.length === 0 && deliveriesOf(walk.id)[0].status === 'refused');
store.sbStatus = 'error';
r = await sendInvoice(b2b.id, 'email');
check('offline: refused, nothing sent', /offline/.test(r.error) && portCalls.length === 0);
store.sbStatus = 'connected';
store.sbOfflineQueue = [{ type: 'sale', sale: { id: b2b.id } }];
r = await sendInvoice(b2b.id, 'email');
check('a bill still uploading waits (the server must have it to look up the customer)', /still uploading/.test(r.error) && portCalls.length === 0);
store.sbOfflineQueue = [{ type: 'cust', id: 'c1', cust: store.customers.c1 }];
r = await sendInvoice(b2b.id, 'sms');
check('a customer change still uploading waits too (the server sends to the customer as saved in the cloud)', /customer's details are still uploading/.test(r.error) && portCalls.length === 0);
store.sbOfflineQueue = [];
store.localDays.today_d1_0.voids.push(b2b.id); store._d = null;
r = await sendInvoice(b2b.id, 'email');
check('a cancelled bill is never sent', /cancelled/.test(r.error) && portCalls.length === 0);
store.localDays.today_d1_0.voids = []; store._d = null;

// ---------- PrintReceipt use case (fake printer) ----------
const { printReceipt, savePrinterSettings, testPrinter } = await import('../../src/features/printing/use-cases/print-receipt.js');
let printed = [], printerAnswer = null;
override({ receiptPrinter: { print: async (d, c) => { printed.push({ d, c }); if (printerAnswer) throw printerAnswer; return { ok: true }; }, test: async () => { if (printerAnswer) throw printerAnswer; return { ok: true }; } } });
check('printer settings saved on this device', savePrinterSettings({ kind: 'epson', host: '192.168.1.50', cols: 32 }).ok && store.printer.cols === 32 && mem.rc_printer.host === '192.168.1.50');
r = await printReceipt(b2b.id);
check('Epson: the invoice as a thermal receipt for this paper width; confirmed', r.ok && r.confirmed && r.via === 'epson' && printed[0].d.cols === 32 && printed[0].d.lines.every((l) => l.text.length <= 32) && printed[0].c.host === '192.168.1.50');
printerAnswer = new AppError(C.PRINTER, 'The printer is out of paper. Load a roll and print again.', { details: { retry: true } });
r = await printReceipt(b2b.id);
check('printer failure: the reason and a retry, never a success', r.error === 'The printer is out of paper. Load a roll and print again.' && r.retry && !r.ok);
check('test print reports failure too', /out of paper/.test((await testPrinter({ host: '192.168.1.50' })).error));
check('a bill not on this device can\'t be printed', !!(await printReceipt('nope')).error);
check('saving a bad printer is refused', !!savePrinterSettings({ kind: 'epson', host: '' }).error && store.printer.host === '192.168.1.50');

// ---------- the logo's upload and download don't lose a newer logo ----------
const { enqueue } = await import('../../src/features/sync/services/outbox.js');
store.sbOfflineQueue = [];
enqueue({ type: 'logo' }); enqueue({ type: 'logo' });
check('one waiting logo upload is enough', store.sbOfflineQueue.filter((q) => q.type === 'logo').length === 1);
store.sbOfflineQueue[0].sending = true; enqueue({ type: 'logo' });
check('a logo changed while the old one is uploading gets its own upload', store.sbOfflineQueue.filter((q) => q.type === 'logo').length === 2);
const { pullSettings } = await import('../../src/features/sync/services/pull.js');
store.sbOfflineQueue = []; store.logo = 'data:old';
const IMGS = { signature: 'data:image/jpeg;base64,U0lH', stamp: '' };
override({ cloud: { fetchSettings: async () => null, fetchDocImages: async () => IMGS, fetchLogo: async () => { store.logo = 'data:new'; enqueue({ type: 'logo' }); return 'data:cloud'; } } });
await pullSettings();
check('a logo picked while the cloud copy was downloading is kept (not replaced by the older cloud copy)', store.logo === 'data:new');
store.sbOfflineQueue = [];
override({ cloud: { fetchSettings: async () => null, fetchDocImages: async () => IMGS, fetchLogo: async () => 'data:cloud' } });
await pullSettings();
check('otherwise the cloud logo is brought down', store.logo === 'data:cloud');
check('...and the signature and stamp with it', store.docImages && store.docImages.signature === IMGS.signature && store.docImages.stamp === '');
// a signature picked on this device while the cloud copy was downloading is kept
store.docImages = { signature: 'data:image/jpeg;base64,TUlORQ==', stamp: '' }; store.sbOfflineQueue = [];
enqueue({ type: 'docimg', kind: 'signature' }); enqueue({ type: 'docimg', kind: 'signature' }); enqueue({ type: 'docimg', kind: 'stamp' });
check('one waiting upload per picture (the signature twice → once; the stamp its own)', store.sbOfflineQueue.filter((q) => q.type === 'docimg').map((q) => q.kind).join() === 'signature,stamp');
await pullSettings();
check('a signature not yet uploaded is not replaced by the older copy in the cloud', store.docImages.signature === 'data:image/jpeg;base64,TUlORQ==');


// ---------- document templates: Standard, Classic, Modern, Compact; the authorised signature and the company stamp ----------
{
  const { DOC_TEMPLATES, checkDocSettings, docSettingsOf, docImagesOf } = await import('../../src/domain/documents/doc-settings.js');
  const { documentHTML } = await import('../../src/features/receipts/components/doc-render.js');
  check('templates: Standard, Classic, Modern and Compact', DOC_TEMPLATES.map((t) => t.key).join() === 'standard,classic,modern,compact');
  check('a shop that chose "Minimal" before gets Standard (the same look under its new name)', docSettingsOf({ docTpl: 'minimal' }).template === 'standard' && checkDocSettings({ docTpl: 'minimal', docAccent: '#1D5BBF' }).patch.docTpl === 'standard');
  const saved = checkDocSettings({ docTpl: 'compact', docAccent: '#0B6B35', docGst: true, docTerms: '', docSign: '', docBank: '', docSignImg: false, docStampImg: true }).patch;
  check('the signature and stamp are printed unless switched off (each on its own)', docSettingsOf({}).signImg && docSettingsOf({}).stampImg && saved.docSignImg === false && saved.docStampImg === true
    && docSettingsOf(saved).signImg === false && docSettingsOf(saved).template === 'compact');
  check('only pictures are kept as the signature or stamp (anything else from a device or backup is dropped)', docImagesOf({ signature: 'data:image/jpeg;base64,AAAA', stamp: 'javascript:alert(1)' }).stamp === '' && docImagesOf(null).signature === '');
  // a tiny JPEG header (enough for the PDF writer to read its size)
  const jpg = (w, h) => 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]).toString('base64');
  const M = { seller: { name: 'Aura Threads', lines: ['12 MG Road'] }, title: 'Tax Invoice', meta: [['Invoice no.', 'INV-000001']], parties: [], columns: ['#', 'Item', 'Amount'], left: 2,
    rows: [['1', { t: 'Kurta' }, 'Rs 999']], totals: [['Total', 'Rs 999', true]], signImg: jpg(300, 90), stampImg: jpg(200, 200) };
  const html = documentHTML(M, { template: 'compact' });
  check('the A4 document (preview, print) carries the signature above "Authorised signatory" and the stamp beside it, in the Compact template',
    /class="doc t-compact/.test(html) && /<img class="d-signimg" src="data:image\/jpeg;base64,[^"]+" alt="Authorised signature">/.test(html) && /<img class="d-stamp" src="data:image\/jpeg;base64,[^"]+" alt="Company stamp">/.test(html)
    && html.indexOf('d-signimg') < html.indexOf('Authorised signatory'));
  check('...and without them, neither picture is drawn', !/d-signimg|d-stamp/.test(documentHTML({ ...M, signImg: '', stampImg: '' }, { template: 'standard' })));
  const pdf = Buffer.from(docPdfBytes(M, { template: 'compact', accent: '#1D5BBF' })).toString('latin1');
  check('the PDF embeds the signature and stamp once each (Im2, Im3) and draws them on the page', /\/XObject << \/Im2 \d+ 0 R \/Im3 \d+ 0 R >>/.test(pdf) && /\/Im2 Do/.test(pdf) && /\/Im3 Do/.test(pdf)
    && (pdf.match(/\/Subtype \/Image/g) || []).length === 2, pdf.match(/\/XObject << [^>]+>>/));
  const plain = Buffer.from(docPdfBytes({ ...M, signImg: '', stampImg: '' }, { template: 'standard' })).toString('latin1');
  check('...a PDF without them has no pictures (and still the signatory line)', !/\/Subtype \/Image/.test(plain) && /Authorised signatory/.test(plain));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
