// Units, decimal quantities, till-scoped document numbers and weighing (schema.sql section 3k, batch T1): the units
// module (checkQty, fmtQty, exact sums), short bill / credit note numbers with offline-safe till series,
// the scale line parser and the Web Serial provider with a fake port, bills and returns of weights (2.5 kg, 0.75 back), the
// stock ledger in thousandths, the weigh-to-cart use case and its permission, and a refused duplicate number in the sync
// review given a new one. Run: npm run test:unit
import { UNITS, checkQty, convertQty, decimalsOf, fmtQty, isDecimalUnit, isMeasured, isWeighed, perUnit, qtyText, roundQty, subQty, sumQty, unitId, unitOf } from '../../src/domain/catalog/units.js';
import { pcsOf } from '../../src/domain/sales/sale.js';
import { challanNoOf, checkNumberingSettings, formatDocNo, nextDocNo, nextDocSeq, numberingOf, splitDeviceNo, tillFor } from '../../src/domain/documents/numbering.js';
import { createManualScale, createSerialScale, createWeightScale, parseScaleLine } from '../../src/infrastructure/hardware/weight-scale.js';
import { checkScaleSettings, scaleSettingsOf } from '../../src/domain/shop/scale-settings.js';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { linePaise } from '../../src/domain/sales/paise.js';
import { quoteReturn, returnableQty } from '../../src/domain/returns/return-value.js';
import { ledgerEntries, movementTotals, onHand } from '../../src/domain/inventory/stock-ledger.js';
import { numberTaken } from '../../src/domain/sync/queue-rules.js';
import { moveRow, productRow, rowToItem, rowToMove, rowToProduct, rowToReturnItem } from '../../src/infrastructure/supabase/mappers.js';
import { gstReport } from '../../src/domain/gst/gst-report.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- units ----------
{
  check('nine units with labels, decimals and GST unit codes', eq(UNITS.map((u) => u.id + ':' + u.label + ':' + u.dp), ['pcs:Piece:0', 'box:Box:0', 'pack:Pack:0', 'dozen:Dozen:0', 'kg:Kg:3', 'g:Gram:0', 'l:Litre:3', 'ml:ml:0', 'm:Meter:2'])
    && unitOf('kg').uqc === 'KGS' && unitOf('l').uqc === 'LTR' && unitOf('m').uqc === 'MTR');
  check('unknown or missing unit is a piece', unitId(undefined) === 'pcs' && unitId('tonne') === 'pcs' && unitOf(null).id === 'pcs' && decimalsOf('x') === 0);
  check('kinds: kg/l are weighed; m is measured, not weighed; box is counted', isWeighed('kg') && isWeighed('ml') && !isWeighed('m') && isMeasured('m') && !isMeasured('box') && isDecimalUnit('m') && !isDecimalUnit('g'));
  check('roundQty: 3 decimals, half up, no float noise', roundQty(0.1 + 0.2) === 0.3 && roundQty(1.0005) === 1.001 && roundQty(2.4999999) === 2.5 && roundQty(-0.0004) === 0 && roundQty('x') === 0 && roundQty(1.25, 1) === 1.3);
  check('sums and differences in thousandths', sumQty([0.1, 0.2, 0.3]) === 0.6 && subQty(2.5, 0.75) === 1.75 && sumQty([]) === 0 && subQty(1, 0.999) === 0.001);
  check('fmtQty / qtyText / perUnit', fmtQty(2.5) === '2.5' && fmtQty(3) === '3' && fmtQty(0.1 + 0.2) === '0.3' && qtyText(2.5, 'kg') === '2.5 kg' && qtyText(3, 'pcs') === '3' && qtyText(1.5, 'l') === '1.5 L'
    && perUnit('₹40', 'kg') === '₹40/kg' && perUnit('₹40', 'pcs') === '₹40');
  check('checkQty kg: 2.5 ok, comma decimal ok, 4 decimals refused, 0 refused', checkQty('2.5', 'kg').q === 2.5 && checkQty('0,75', 'kg').q === 0.75 && /at most 3 decimal/.test(checkQty('1.2345', 'kg').error) && /more than 0/.test(checkQty('0', 'kg').error));
  check('checkQty pieces: whole numbers only', checkQty('3', 'pcs').q === 3 && /whole number/.test(checkQty('2.5', 'pcs').error) && /whole number/.test(checkQty('abc', 'pcs').error) && checkQty('3.000', 'box').q === 3);
  check('checkQty metres: 2 decimals', checkQty('1.25', 'm').q === 1.25 && /at most 2 decimal/.test(checkQty('1.255', 'm').error));
  check('checkQty caps at the stock (with the nearest usable value)', eq(checkQty('3', 'kg', { max: 2.5 }), { error: 'Only 2.5 kg in stock.', q: 2.5 }) && checkQty('1', 'kg', { max: 0 }).error === 'That one is sold out.' && checkQty('0', 'kg', { zero: true }).q === 0);
  check('convertQty: g → kg, kg → g, lb → kg, ml → l; weight ↔ volume refused', convertQty(750, 'g', 'kg') === 0.75 && convertQty(1.25, 'kg', 'g') === 1250 && convertQty(1, 'lb', 'kg') === 0.454 && convertQty(500, 'ml', 'l') === 0.5 && convertQty(1, 'kg', 'l') === null);
}

// ---------- professional document numbers per till ----------
{
  const t = new Date(2026, 8, 29, 10).getTime(), t2 = new Date(2027, 4, 1, 9).getTime();
  const A = 'dev-aaaa-1111', B = 'dev-bbbb-2222';
  const cfg = { prefix: 'INV-', start: 1, padding: 6, suffix: '' };
  check('format: short padded customer number; a second till gets one compact letter', formatDocNo(cfg, t, 7) === 'INV-000007' && formatDocNo(cfg, t, 7, 'B') === 'INV-B-000007');
  // Two tills keep independent consecutive series. A sync conflict moves a device to a free letter; numbers stay short.
  const billsA = [], billsB = [];
  for (let k = 0; k < 5; k++) {
    billsA.push({ no: nextDocNo(billsA, cfg, t + k), t: t + k, dev: A });
    billsB.push({ no: nextDocNo(billsB, cfg, t + k, 'B'), t: t + k, dev: B });
  }
  const all = [...billsA, ...billsB].map((b) => b.no);
  check('main and second-till offline series do not collide', new Set(all).size === 10 && billsA[4].no === 'INV-000005' && billsB[0].no === 'INV-B-000001', all);
  check('after syncing, each keeps its own series (the other till\'s bills do not move it)', nextDocSeq([...billsA, ...billsB], cfg, t + 9) === 6 && nextDocSeq([...billsA, ...billsB], cfg, t + 9, 'B') === 6);
  check('ordinary numbering continues across dates', nextDocNo(billsA, cfg, t2) === 'INV-000006');
  check('past the highest visible number in the same series', nextDocSeq([{ no: 'INV-000012', t, dev: 'someone-else' }], cfg, t) === 13);
  check('historical date/device numbers remain untouched and do not confuse the new series', nextDocSeq([{ no: 'INV-260929-K3F004', t, dev: A }], cfg, t) === 1);
  check('quotes and sales orders use separate short series', nextDocNo([], { ...cfg, prefix: 'QT-' }, t) === 'QT-000001' && nextDocNo([{ no: 'SO-000001' }], { ...cfg, prefix: 'SO-' }, t) === 'SO-000002');
  const fyCfg = { prefix: 'INV/{FY}/', start: 1, padding: 3, suffix: '' };
  check('a {FY} series restarts only when the financial year changes', nextDocNo([{ no: 'INV/26-27/009' }], fyCfg, t) === 'INV/26-27/010' && nextDocNo([{ no: 'INV/26-27/009' }], fyCfg, t2) === 'INV/27-28/001');
  check('a new device takes main when free, then the first free till letter after seeing main', tillFor({ stored: null, dev: A, docs: [] }) === ''
    && tillFor({ stored: null, dev: B, docs: [{ no: 'INV-000001', dev: A, t, cfg }] }) === 'B');
  const valid = checkNumberingSettings(cfg, { t, till: 'B' });
  check('normal settings preview is GST/e-invoice length-safe', valid.preview === 'INV-B-000001' && valid.length <= 16 && !valid.error, valid);
  const tooLongForAnotherTill = checkNumberingSettings({ prefix: 'ABCDEFGHIJ', start: 1, padding: 6, suffix: '' }, { t });
  check('settings cannot save a number that would exceed 16 characters on a second till', tooLongForAnotherTill.field === 'length' && /second till/.test(tooLongForAnotherTill.error), tooLongForAnotherTill);
  check('splitDeviceNo: series + number; other numbers null', eq(splitDeviceNo('INV-260929-K3F012'), { series: 'INV-260929-K3F', n: 12 }) && splitDeviceNo('INV-260929-012') === null && splitDeviceNo('') === null);
  { const so = numberingOf({ prefix: 'SO-' }), dc = numberingOf({ prefix: 'DC-' });
    check('a delivery challan takes the running number of its order in the DC series (SO-000127 → DC-000127, a second till SO-B-000004 → DC-B-000004); an older order keeps "<no>-DC"',
      challanNoOf('SO-000127', so, dc, Date.now()) === 'DC-000127' && challanNoOf('SO-B-000004', so, dc, Date.now()) === 'DC-B-000004' && challanNoOf('SO-260929-K3F001', so, dc, Date.now()) === 'SO-260929-K3F001-DC'); }
  check('pieces on a bill: a weighed line counts as one item', pcsOf({ items: [{ q: 2 }, { q: 2.5, u: 'kg' }, { q: 1.2, u: 'm' }] }) === 4 && pcsOf({ items: [{ q: 2 }, { q: 3, u: 'box' }] }) === 5);
}

// ---------- the scale's lines ----------
{
  const p = (l, u) => parseScaleLine(l, u);
  check('"ST,GS,+  1.250kg" → 1.25 kg, settled', eq(p('ST,GS,+  1.250kg'), { value: 1.25, unit: 'kg', stable: true }));
  check('"US,GS,+  1.2kg" → still settling', eq(p('US,GS,+  1.2kg'), { value: 1.2, unit: 'kg', stable: false }));
  check('"W: 0.500 KG", "  750 g", "Net 2.5 lb", "1,25" (comma)', eq(p('W: 0.500 KG'), { value: 0.5, unit: 'kg', stable: true }) && eq(p('  750 g'), { value: 750, unit: 'g', stable: true })
    && eq(p('Net 2.5 lb'), { value: 2.5, unit: 'lb', stable: true }) && p('1,25').value === 1.25);
  check('a bare number is in the unit set for the scale', eq(p('0.345'), { value: 0.345, unit: 'kg', stable: true }) && p('345', 'g').unit === 'g');
  check('the last number on the line is the weight; a minus sign is kept', p('ID 12 NET 0.75kg').value === 0.75 && p('ST,GS,-  0.010kg').value === -0.01);
  check('litres and ml', eq(p('1.5 L'), { value: 1.5, unit: 'l', stable: true }) && p('250ml').unit === 'ml');
  check('no weight on the line → null; "?" marks unsettled', p('') === null && p('ST,GS') === null && p('\x02\x03') === null && p('? 1.2 kg').stable === false);
}

// ---------- scale settings ----------
{
  check('saved settings made safe (defaults: 9600 baud, kg, no command, reconnect on)', eq(scaleSettingsOf(null), { baud: 9600, unit: 'kg', request: '', auto: true }) && eq(scaleSettingsOf({ baud: '4800', unit: 'g', request: 'W\n', auto: false }), { baud: 4800, unit: 'g', request: 'W', auto: false }));
  check('checkScaleSettings: a baud rate from the list; a short plain command', checkScaleSettings({ baud: 1234 }).field === 'baud' && checkScaleSettings({ baud: 9600, request: 'TOOLONGCMD' }).field === 'request' && checkScaleSettings({ baud: 9600, request: 'P' }).scale.request === 'P');
}

// ---------- the scale providers ----------
{
  const m = createManualScale();
  check('manual: nothing to read until a reading is fed; then once', /Type the weight/.test((await m.read()).error) && m.feed('1.250 kg').value === 1.25 && (await m.read()).value === 1.25 && !!(await m.read()).error);
  const w = createWeightScale({});
  check('no Web Serial: not supported, connect says to type, status manual', !w.supported() && !!(await w.connect()).error && w.status().kind === 'manual' && !w.status().connected);

  function fakePort() {
    let ctl; const written = [], enc = new TextEncoder(), dec = new TextDecoder();
    const port = { opened: null, closed: false,
      readable: new ReadableStream({ start(c) { ctl = c; } }),
      writable: new WritableStream({ write(ch) { written.push(dec.decode(ch)); } }),
      async open(o) { this.opened = o; }, async close() { this.closed = true; },
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
      push: (s) => ctl.enqueue(enc.encode(s)), written };
    return port;
  }
  const port = fakePort(), settings = { baud: 4800, unit: 'kg', request: 'W' };
  const s = createSerialScale({ serial: { requestPort: async () => port, getPorts: async () => [port] }, getSettings: () => settings });
  check('serial: supported, not connected before a port is chosen', s.supported() && !s.status().connected && /No scale is connected/.test((await s.read()).error));
  const c = await s.connect();
  check('connect opens the chosen port at the saved baud rate (8N1)', c.ok && port.opened.baudRate === 4800 && port.opened.dataBits === 8 && s.status().connected && /1a86/.test(s.status().name), port.opened);
  let pr = s.read({ timeoutMs: 800 });
  await new Promise((r) => setTimeout(r, 20));
  port.push('ST,US,+  1.20'); port.push('0kg\r\nST,GS,+  1.250kg\r\n');
  let r = await pr;
  check('read: asks with the command, skips a settling reading (split over two chunks), gives the settled one', eq(r, { value: 1.25, unit: 'kg', stable: true }) && port.written.join('') === 'W\r\n', { r, written: port.written });
  const s2port = fakePort();
  const s2 = createSerialScale({ serial: { requestPort: async () => s2port, getPorts: async () => [s2port] }, getSettings: () => ({ baud: 9600 }) });
  check('reconnect opens the remembered port without asking', await s2.reconnect() && s2.status().connected);
  pr = s2.read({ timeoutMs: 150 }); s2port.push('US 0.9 kg\n');
  check('only settling readings in time → "still settling"', /still settling/.test((await pr).error));
  const s3port = fakePort();
  const s3 = createSerialScale({ serial: { requestPort: async () => s3port, getPorts: async () => [s3port] }, getSettings: () => ({}) });
  await s3.connect();
  check('nothing from the scale in time → says so (typing still possible)', /sent no weight/.test((await s3.read({ timeoutMs: 80 })).error));
  await s.disconnect(); await s2.disconnect(); await s3.disconnect();
  check('disconnect closes the port', !s.status().connected && port.closed && s3port.closed);
  const denied = createSerialScale({ serial: { requestPort: async () => { const e = new Error('none'); e.name = 'NotFoundError'; throw e; } }, getSettings: () => ({}) });
  check('no port chosen → a message, not an exception', (await denied.connect()).error === 'No port was chosen.');
}

// ---------- bills and returns of weights ----------
{
  check('line amount in paise without float drift: 2.5 kg × ₹43 = ₹107.50; 0.335 kg × ₹43 = ₹14.41', linePaise(2.5, 43) === 10750 && linePaise(0.335, 43) === 1441 && linePaise(0.1 + 0.2, 10) === 300);
  const T = computeCheckout({ lines: [{ q: 2.5, price: 43, rate: 5 }, { q: 2, price: 100, rate: 5 }], billDisc: null, gst: { mode: 'intra', inclusive: false } });
  check('checkout of 2.5 kg + 2 pieces: subtotal ₹307.50 with GST on top, rounded to the rupee', T.sub === 307.5 && T.lines[0].taxable === 107.5 && Number.isInteger(T.total), T);
  const sale = { id: 's', total: 108, roundOff: 0.5, items: [{ ln: 0, n: 'Rice', q: 2.5, u: 'kg', price: 43, lt: 107.5, tx: 107.5, cgst: 0, sgst: 0, igst: 0, gst: 0 }] };
  const a = quoteReturn(sale, { 0: 0.75 }, []);
  check('return 0.75 kg of 2.5 kg: 30% of the line (₹32.25)', !a.error && a.lines[0].q === 0.75 && a.value === 32.25 && !a.whole, a);
  const prior = [{ items: [{ ln: 0, q: 0.75, value: 32.25, tx: 32.25, cgst: 0, sgst: 0, igst: 0 }] }];
  check('what is left to return: 1.75 kg', returnableQty(sale, sale.items[0], 0, prior) === 1.75);
  check('more than is left is refused, in kg', quoteReturn(sale, { 0: 1.8 }, prior).error === 'Only 1.75 kg of Rice can still be returned.');
  const b = quoteReturn(sale, { 0: 1.75 }, prior);
  check('the rest (1.75 kg) finishes the line and brings the round off: both parts = the bill', b.whole && Math.round((a.value + b.value) * 100) === 10800, b);
  // stock ledger in thousandths
  const moves = { o: { id: 'o', v: 'rice', p: 'r', type: 'OPENING', q: 10, t: 1 }, r1: { id: 'r1', v: 'rice', p: 'r', type: 'RESTOCK', q: 0.1, t: 2 }, r2: { id: 'r2', v: 'rice', p: 'r', type: 'RESTOCK', q: 0.2, t: 3 } };
  const L = ledgerEntries({ moves, sales: [{ id: 's', no: 'B', t: 4, items: [{ ln: 0, v: 'rice', p: 'r', q: 2.5, u: 'kg' }] }], returns: [{ id: 'x', sale: 's', t: 5, items: [{ ln: 0, v: 'rice', p: 'r', q: 0.75 }] }] });
  check('stock: 10 + 0.1 + 0.2 − 2.5 + 0.75 = 8.55 kg exactly', onHand(L).rice === 8.55, onHand(L));
  const M = movementTotals(L);
  check('movement totals keep the decimals', M.inPieces === 11.05 && M.outPieces === 2.5 && M.net === 8.55, M);
  // GST: HSN summary by unit code
  const g = gstReport({ sales: [{ id: 's1', no: 'INV-1', t: 1790000000000, total: 108, items: [{ ln: 0, q: 2.5, u: 'kg', price: 43, hsn: '1006', gst: 5, lt: 112.88, tx: 107.5, cgst: 2.69, sgst: 2.69, igst: 0 }], gst: { mode: 'intra' } }], returns: [], saleById: {} });
  const h = g.hsn || (g.sections && g.sections.hsn) || [];
  check('GST HSN summary: quantity 2.5 in KGS', JSON.stringify(g).includes('"uqc":"KGS"') && JSON.stringify(g).includes('2.5'), h);
}

// ---------- mappers: unit and decimal quantities ----------
{
  check('product unit to and from the database (pieces: no field)', productRow({ id: 'p', name: 'Rice', price: 43, unit: 'kg' }, 0).unit === 'kg' && productRow({ id: 'p', name: 'Tee', price: 1 }, 0).unit === 'pcs'
    && rowToProduct({ id: 'p', name: 'Rice', price: 43, unit: 'kg' }).unit === 'kg' && rowToProduct({ id: 'p', name: 'Tee', price: 1, unit: 'pcs' }).unit === undefined);
  check('bill and return lines: NUMERIC strings → numbers, unit kept', eq([rowToItem({ product_id: 'r', product_name: 'Rice', quantity: '2.500', unit: 'kg', unit_price: 43, line_no: 0 }).q, rowToItem({ quantity: '2.500', unit: 'kg' }).u], [2.5, 'kg'])
    && rowToReturnItem({ sale_line_no: 0, quantity: '0.750', unit: 'kg' }).q === 0.75 && rowToItem({ quantity: 2, unit: 'pcs' }).u === undefined);
  check('stock records keep 3 decimals and who made them', moveRow({ id: 'm', v: 'v', p: 'p', type: 'RESTOCK', q: 0.1 + 0.2, t: 1, dev: 'd' }).qty === 0.3 && rowToMove({ id: 'm', qty: '12.345', t: '1', user_id: 'u1' }).q === 12.345 && rowToMove({ id: 'm', qty: '1', t: '1', user_id: 'u1' }).user === 'u1');
}

// ---------- on this device: weigh to cart, numbers, the sync review ----------
installFakeDom();
const storage = memStorage();
const { createWeightScale: cws } = await import('../../src/infrastructure/hardware/weight-scale.js');
const scalePort = cws({});
override({ weightScale: scalePort });
const { newSaleRecord, recordSale } = await import('../../src/features/sales/use-cases/checkout.js');
const { addWeighed } = await import('../../src/features/sales/use-cases/weigh-to-cart.js');
const { addToLines, setLineQty, cartPcs, availOf } = await import('../../src/features/sales/services/cart.js');
const { readScaleFor } = await import('../../src/features/hardware/services/scale.js');
const { saveScaleSettings } = await import('../../src/features/hardware/use-cases/scale.js');
const { renumberReview } = await import('../../src/features/sync/services/outbox.js');
const { D } = await import('../../src/features/inventory/services/ledger.js');
const { stockOf } = await import('../../src/features/inventory/services/stock.js');
const { scanToCart } = await import('../../src/features/sales/use-cases/scan-to-cart.js');
Object.assign(store, { dev: 'dev-aaaa-1111', remoteDays: {}, localDays: {}, dirty: new Set(), returnsMap: {}, _d: null, customers: {}, cart: [], cartCust: null, disc: null, sbOfflineQueue: [], syncReview: [],
  sbClient: null, sbStatus: 'disconnected', events: {}, prefs: { event: '' }, lastCheckout: 0, access: null, authUser: { id: 'owner-1' }, scale: scaleSettingsOf(null),
  settings: { taxOn: false, prefix: 'INV-' }, profile: {},
  moves: { o1: { id: 'o1', v: 'rice:', p: 'rice', type: 'OPENING', q: 10, t: 1 }, o2: { id: 'o2', v: 'tee:', p: 'tee', type: 'OPENING', q: 5, t: 1 } },
  catalog: { version: 3, products: [{ id: 'rice', name: 'Rice', price: 43, unit: 'kg', opts: [], variants: [{ id: 'rice:', o: [], bc: '8901234567890', active: true }] },
    { id: 'tee', name: 'Tee', price: 500, opts: [], variants: [{ id: 'tee:', o: [], active: true }] }] } });
{
  check('scanning a product sold by the kg asks for its weight (nothing added yet)', scanToCart('8901234567890').status === 'weigh' && store.cart.length === 0);
  let r = addWeighed('rice:', '2.5', null);
  check('weigh to cart: 2.5 kg on the bill as one line with its unit', r.ok && r.text === '2.5 kg' && store.cart.length === 1 && store.cart[0].q === 2.5 && store.cart[0].u === 'kg', store.cart);
  check('more than the stock is refused, nothing changes', /Only 7.5 kg in stock/.test(addWeighed('rice:', '8', null).error) && store.cart[0].q === 2.5);
  r = addWeighed('rice:', '1.25', 0);
  check('weighing the line again replaces its quantity', r.ok && store.cart.length === 1 && store.cart[0].q === 1.25);
  check('typing a quantity: decimals for kg; whole numbers for pieces', setLineQty(0, '2.5').ok && store.cart[0].q === 2.5 && (addToLines(store.cart, 'tee:', 1), !setLineQty(1, '1.5').ok) && store.cart[1].q === 1);
  check('items on the bill: the weighed line counts once', cartPcs() === 2 && availOf('rice:') === 7.5);
  scalePort.feed('ST,GS,+  0.750kg');
  const rs = await readScaleFor('kg');
  check('read the scale (a reading fed to the manual provider) in the product\'s unit', rs.q === 0.75 && rs.text === '0.75 kg', rs);
  scalePort.feed('750 g');
  check('a reading in grams for a product sold by the kg is converted', (await readScaleFor('kg')).q === 0.75);
  scalePort.feed('1.5 L');
  check('a reading in litres for a product sold by the kg is refused', /Type the quantity/.test((await readScaleFor('kg')).error));
  // a team member without the right to sell
  store.access = { userId: 'm1', shopId: 'owner-1', role: 'custom', perms: ['view_reports'], overrides: {} };
  const before = JSON.stringify(store.cart);
  check('a member who may not sell can\'t weigh onto the bill (refused before anything changes)', /can't sell/.test(addWeighed('rice:', '1', null).error) && JSON.stringify(store.cart) === before);
  check('…nor set up the scale', /can't set up the scale/.test(saveScaleSettings({ baud: 9600 }).error));
  store.access = null;
  check('the owner saves the scale settings on this device', saveScaleSettings({ baud: 2400, unit: 'g', request: 'P', auto: true }).ok && store.scale.baud === 2400 && JSON.parse(storage.mem.hangtag_scale).request === 'P');

  // bills: this device's series, the user noted
  const s1 = newSaleRecord([{ v: 'rice:', p: 'rice', name: 'Rice', q: 2.5, u: 'kg', price: 43 }], null, 'cash', { cust: null });
  recordSale(s1);
  const s2 = newSaleRecord([{ v: 'tee:', p: 'tee', name: 'Tee', q: 1, price: 500 }], null, 'cash', { cust: null });
  recordSale(s2);
  check('bills get short consecutive customer-facing numbers', s1.no === 'INV-000001' && s2.no === 'INV-000002', [s1.no, s2.no]);
  check('the bill line keeps its unit and weight; the bill notes who made it', s1.items[0].q === 2.5 && s1.items[0].u === 'kg' && s1.user === 'owner-1' && s1.sub === 107.5);
  check('stock after selling 2.5 kg: 7.5 kg', stockOf('rice:') === 7.5);
  // another phone of the shop, same day, offline: its own series
  storage.remove('hangtag_till');
  store.dev = 'dev-bbbb-2222';
  const s3 = newSaleRecord([{ v: 'tee:', p: 'tee', name: 'Tee', q: 1, price: 500 }], null, 'cash', { cust: null });
  check('a second device that knows the main series starts its compact B series at 000001', s3.no === 'INV-B-000001' && s3.no !== s1.no, s3.no);
  store.dev = 'dev-aaaa-1111';
  storage.set('hangtag_till', '');

  // the database refused a number (two phones with the same code): the review gives it the next one
  const taken = { item: { type: 'sale', id: s2.id, sale: { ...s2 } }, err: `Bill number ${s2.no} is already used by another bill of this shop.`, code: 'CONFLICT', t: Date.now() };
  check('a refused number is recognised in the review (and nothing else is)', numberTaken(taken) && !numberTaken({ ...taken, code: 'VALIDATION' }) && !numberTaken({ ...taken, item: { type: 'product' } }));
  store.syncReview = [taken]; store.sbOfflineQueue = [];
  store.access = { userId: 'm1', shopId: 'owner-1', role: 'custom', perms: ['view_reports'], overrides: {} };
  check('a member who may not sell can\'t renumber a bill', /can't renumber bills/.test(renumberReview(0).error) && store.syncReview.length === 1);
  store.access = null;
  const rn = renumberReview(0);
  check('a number collision moves this device to a free till series, saves the bill and queues it again', rn.ok && rn.no === 'INV-B-000001' && D().saleById[s2.id].no === rn.no && store.syncReview.length === 0
    && store.sbOfflineQueue.some((q) => q.type === 'sale' && q.sale && q.sale.no === rn.no), { rn, q: store.sbOfflineQueue });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
