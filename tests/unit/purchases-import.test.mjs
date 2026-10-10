// Suppliers, purchases, what suppliers are owed, stock count, factory barcode intake, bulk product import (CSV and Excel)
// and the outbox rules of section 3l. Run: npm run test:unit
import { buildPurchase, checkSupplier, checkSupplierPayment, lineError, purchaseDue, purchaseTotals, supplierAccount, purchaseCashMove, cancelPurchaseMoves } from '../../src/domain/inventory/purchase.js';
import { countDiffs, countMoves, countNote } from '../../src/domain/inventory/stock-count.js';
import { lookupCode, quickProduct } from '../../src/domain/inventory/barcode-intake.js';
import { importPlan, importTemplateRows, mapImportHeader, validateImport } from '../../src/domain/catalog/product-import.js';
import { parseCsv, csvText } from '../../src/shared/utils/csv.js';
import { readXlsx } from '../../src/shared/utils/xlsx-read.js';
import { dependsOn, UPLOAD_PERMISSIONS as queuePermissions } from '../../src/domain/sync/queue-rules.js';
import { purchaseArgs, rowToPurchase, supplierRow } from '../../src/infrastructure/supabase/mappers.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}

// ---------- suppliers ----------
const sups = [{ id: 's1', name: 'Asha Traders', gstin: '27ABCDE1234F1Z5' }];
check('supplier needs a name', checkSupplier({}).field === 'name');
check('supplier details are cleaned', checkSupplier({ id: 's2', name: '  New   Mills ', gstin: '29abcde1234f1z5' }).supplier.name === 'New Mills' && checkSupplier({ id: 's2', name: 'x', gstin: '29abcde1234f1z5' }).supplier.gstin === '29ABCDE1234F1Z5');
check('duplicate supplier name or GSTIN refused', checkSupplier({ id: 's2', name: 'asha traders' }, sups).field === 'name' && checkSupplier({ id: 's2', name: 'B', gstin: '27ABCDE1234F1Z5' }, sups).field === 'gstin');
check('editing a supplier is not its own duplicate', !!checkSupplier({ id: 's1', name: 'Asha Traders', gstin: '27ABCDE1234F1Z5' }, sups).supplier);
check('bad phone / email / GSTIN refused', checkSupplier({ name: 'A', phone: '12' }).field === 'phone' && checkSupplier({ name: 'A', email: 'x' }).field === 'email' && checkSupplier({ name: 'A', gstin: '27AB' }).field === 'gstin');

// ---------- purchases ----------
const line = (o) => Object.assign({ p: 'p1', v: 'v1', n: 'Tee', q: '10', cost: '100', gst: '5' }, o);
check('line needs a product and a quantity', /choose the product/.test(lineError({ q: 1 }, 1)) && /quantity more than 0/.test(lineError(line({ q: '0' }), 1)));
check('whole pieces unless the unit allows decimals', /whole number/.test(lineError(line({ q: '1.5' }), 1)) && lineError(line({ q: '1.25', dec: 3 }), 1) === null && /3 decimal/.test(lineError(line({ q: '1.2345', dec: 3 }), 1)));
check('cost has at most 2 decimals, GST 0-100', /2 decimal/.test(lineError(line({ cost: '1.234' }), 1)) && /GST/.test(lineError(line({ gst: '120' }), 1)));
const T = purchaseTotals([line(), line({ q: '2', cost: '50.50', gst: '12' })]);
check('totals in paise: taxable, GST, total, pieces', T.sub === 1101 && T.tax === 62.12 && T.total === 1163.12 && T.pieces === 12, T);
const base = { id: 'pu1', supplierId: 's1', supplierName: 'Asha Traders', invoiceNo: 'INV-9', invoiceDate: '2026-09-20', lines: [line(), line({ v: 'v2', q: '2.5', dec: 3, cost: '40' })], paid: '0', t: 1000, dev: 'D1' };
const B = buildPurchase(base, { today: '2026-09-30' });
check('purchase builds stock-in records (RESTOCK, cost, note, points at the purchase)', B.purchase && B.moves.length === 2 && B.moves.every((m) => m.type === 'RESTOCK' && m.imp === 'pu1') && B.moves[1].q === 2.5 && /Purchase INV-9 · Asha Traders/.test(B.moves[0].note), B);
check('purchase totals and status', B.purchase.total === 1155 && B.purchase.status === 'posted' && B.purchase.paid === 0, B.purchase);
check('no lines / future date refused', buildPurchase({ ...base, lines: [] }).field === 'lines' && buildPurchase({ ...base, invoiceDate: '2026-10-05' }, { today: '2026-09-30' }).field === 'invoiceDate');
check('paying more than the total refused; paying needs a method', buildPurchase({ ...base, paid: '2000', method: 'cash' }).field === 'paid' && buildPurchase({ ...base, paid: '100' }).field === 'method');
check('unpaid purchase needs a supplier', buildPurchase({ ...base, supplierId: null }).field === 'supplier' && !!buildPurchase({ ...base, supplierId: null, paid: '1155', method: 'upi' }).purchase);
check('same invoice from the same supplier twice is flagged (allowed when confirmed)', buildPurchase(base, { purchases: [{ id: 'old', supplierId: 's1', invoiceNo: 'inv-9', status: 'posted' }] }).duplicate === true
  && !!buildPurchase(base, { purchases: [{ id: 'old', supplierId: 's1', invoiceNo: 'inv-9' }], allowDuplicate: true }).purchase
  && !!buildPurchase(base, { purchases: [{ id: 'old', supplierId: 's1', invoiceNo: 'inv-9', status: 'cancelled' }] }).purchase);
const paidCash = buildPurchase({ ...base, paid: '500', method: 'cash' }, {}).purchase;
check('cash paid on a purchase is a cash book "out" entry', (() => { const m = purchaseCashMove(paidCash); return m && m.amount === 500; })() && !purchaseCashMove(B.purchase));

// ---------- what suppliers are owed ----------
const pays = [{ id: 'y1', supplierId: 's1', purchaseId: 'pu1', amount: 200, t: 5 }, { id: 'y2', supplierId: 's1', amount: 100, t: 6 }, { id: 'y3', supplierId: 's1', purchaseId: 'pu1', amount: 200, reverses: 'y1', t: 7 }];
check('due on a purchase: total − paid − later payments (a reversal takes one back)', purchaseDue(paidCash, pays) === 655 && purchaseDue({ ...paidCash, status: 'cancelled' }, pays) === 0);
const A = supplierAccount('s1', [paidCash, { ...B.purchase, id: 'pu2', status: 'cancelled', t: 2 }], pays);
check('supplier account: cancelled purchases owe nothing, advances count', A.count === 1 && A.total === 1155 && A.paid === 600 && A.outstanding === 555, A);
check('supplier payment checked', !!checkSupplierPayment({ supplierId: 's1', amount: '0', method: 'cash' }).error && !!checkSupplierPayment({ supplierId: 's1', amount: '100', method: 'bitcoin' }).error);
const cm = cancelPurchaseMoves(B.purchase, B.moves, { reason: 'Wrong invoice', t: 9, dev: 'D1' });
check('cancelling a purchase takes its stock back out', Array.isArray(cm) ? cm.length === 2 && cm.every((m) => m.q < 0 || m.type !== 'RESTOCK') : !!cm, cm);

// ---------- stock count ----------
const rows = [{ vid: 'a', pid: 'p', system: 10 }, { vid: 'b', pid: 'p', system: 4 }, { vid: 'c', pid: 'q', system: 2.5, dec: 3 }];
const d = countDiffs(rows, { a: '8', b: '4', c: '2.75' });
check('count differences (uncounted rows skipped, decimals by unit)', d.counted === 3 && d.changed.length === 2 && d.up === 0.25 && d.down === 2, d);
check('bad counts refused', countDiffs(rows, { a: '-1' }).vid === 'a' && /whole/.test(countDiffs(rows, { a: '1.5' }).error));
let n = 0;
const mv = countMoves(d.changed, { reason: 'Damaged', note: 'shelf 3', now: 50, dev: 'D1', newId: () => 'm' + (++n), currentStock: (v) => ({ a: 10, c: 2.5 })[v] });
check('each difference is one ADJUST record "Stock count: <reason>"', mv.moves && mv.moves.length === 2 && mv.moves[0].type === 'ADJUST' && mv.moves[0].q === -2 && mv.moves[0].note === 'Stock count: Damaged · shelf 3', mv);
check('stock that changed while counting is reviewed again', !!countMoves(d.changed, { reason: 'Damaged', newId: () => 'x', currentStock: () => 9 }).moved);
check('count needs a reason; nothing to change is refused', !!countMoves(d.changed, { newId: () => 'x' }).error && !!countMoves([], { reason: 'Damaged', newId: () => 'x' }).error && countNote('Other', '') === 'Stock count: Other');

// ---------- factory barcode intake ----------
const cat = [{ id: 'p1', name: 'Tee', variants: [{ id: 'v1', bc: '8901234567890', sku: 'TEE-1', active: true }] }, { id: 'p2', name: 'Old', archived: true, variants: [{ id: 'v9', bc: '4006381333931', active: true }] }];
const vo = (p) => p.variants;
check('a known code finds its variant (barcode, then SKU)', lookupCode('8901234567890', cat, vo).hit.v.id === 'v1' && lookupCode('tee-1', cat, vo).hit.v.id === 'v1');
check('a code on an archived product is named, not reused', !!lookupCode('4006381333931', cat, vo).off);
check('an unknown code offers a new product', lookupCode('5012345678900', cat, vo).unknown === '5012345678900');
const qp = quickProduct({ code: '5012345678900', name: 'Rice 1kg', price: '90', unit: 'kg' }, { id: 'np', vid: 'nv', units: [['pcs', 'Piece', 0], ['kg', 'Kg', 3]] });
check('quick product: code as barcode, unit kept', qp.product && qp.product.variants[0].bc === '5012345678900' && qp.product.unit === 'kg', qp);
check('quick product refuses a taken code and whole-rupee rule', quickProduct({ code: '8901234567890', name: 'x', price: 1 }, { taken: { 'b:8901234567890': 'Tee' } }).field === 'code' && quickProduct({ code: '5012345678900', name: 'x', price: '1.5' }, {}).field === 'price');

// ---------- bulk import ----------
const csv = '﻿Name,Category,Option 1 name,Option 1 value,SKU,Barcode,Price,Cost,GST %,Opening stock,Unit\r\n"Tee, cotton",Tops,Size,M,T-M,,599,300,5,10,pcs\r\n"Tee, cotton",Tops,Size,L,T-L,,599,300,5,4,pcs\r\nRice,Grain,,,,,90,,5,2.5,kg\r\n';
const parsed = parseCsv(csv);
check('CSV: BOM, quotes with commas, CRLF', parsed.length === 4 && parsed[1][0] === 'Tee, cotton' && parsed[3][9] === '2.5', parsed);
check('CSV: ";" separated files', parseCsv('Name;Price\nA;10')[1][1] === '10' && parseCsv(csvText([['a"b', 'c,d']]))[0][0] === 'a"b');
check('header: aliases, needs Name and Price', mapImportHeader(['Item name', 'MRP']).map.price === 1 && !!mapImportHeader(['Price']).error && !!mapImportHeader(['Name']).error);
const V = validateImport(parsed, { products: [] });
check('valid sheet → 2 products (one with 2 variants), pieces added up', V.ok && V.summary.products === 2 && V.summary.variants === 3 && V.summary.pieces === 16.5, V.rows.map((r) => r.errors));
let ids = 0;
const P = importPlan(V, { ids: { product: () => 'P' + (++ids), variant: () => 'V' + (++ids) }, colors: ['#111'], now: 7, dev: 'D1' });
check('import plan: products, variants, OPENING records', P.products.length === 2 && P.products[0].variants.length === 2 && P.moves.length === 3 && P.moves.every((m) => m.type === 'OPENING') && P.products[1].unit === 'kg', P);
const bad = validateImport([['Name', 'Price', 'SKU', 'Opening stock'], ['A', '10', 'X1', '1.5'], ['B', 'abc', 'X1', ''], ['Tee', '5', '', '']], { products: [{ name: 'Tee', variants: [{ sku: 'TEE-1' }] }] });
check('all-or-nothing: every bad row is reported, nothing imported', !bad.ok && bad.errorCount === 3 && !!importPlan(bad, { ids: {} }).error, bad.rows.map((r) => r.errors));
check('opening stock refused when the role cannot set stock', validateImport([['Name', 'Price', 'Opening stock'], ['A', '10', '3']], { stockAllowed: false }).errorCount === 1);
check('template rows: every example is recognised and left out, nothing else to fix', (() => { const t = validateImport(importTemplateRows(), {}); return !t.ok && t.errorCount === 0 && t.summary.examples === 5 && t.summary.products === 0; })());

// ---------- Excel (.xlsx) reading: a stored (uncompressed) ZIP built here ----------
function zip(files) {
  const enc = new TextEncoder(), parts = [], cd = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = enc.encode(name), data = enc.encode(text), h = new Uint8Array(30 + nb.length), dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(8, 0, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true); dv.setUint16(26, nb.length, true); h.set(nb, 30);
    const c = new Uint8Array(46 + nb.length), cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 0, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nb.length, true); cv.setUint32(42, off, true); c.set(nb, 46);
    parts.push(h, data); cd.push(c); off += h.length + data.length;
  }
  const cdLen = cd.reduce((a, c) => a + c.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, cd.length, true); ev.setUint16(10, cd.length, true); ev.setUint32(12, cdLen, true); ev.setUint32(16, off, true);
  const all = [...parts, ...cd, end], out = new Uint8Array(all.reduce((a, p) => a + p.length, 0)); let p = 0; for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}
const xlsx = zip({
  'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Products" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Price</t></si><si><r><t>Tea </t></r><r><t>&amp; Co</t></r></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>120</v></c></row></sheetData></worksheet>',
});
const sheets = await readXlsx(xlsx, { DOMParser: null });
check('xlsx: sheets, shared strings (runs, entities), numbers, gaps', sheets.length === 1 && sheets[0].name === 'Products' && sheets[0].rows[0][1] === 'Price' && sheets[0].rows[2][0] === 'Tea & Co' && sheets[0].rows[2][1] === '' && sheets[0].rows[2][2] === '120', sheets);
check('xlsx: a file that is not a workbook is refused', await readXlsx(new Uint8Array([1, 2, 3]), { DOMParser: null }).then(() => false, (e) => e.code === 'XLSX'));

// ---------- sync rules and mappers ----------
check('a purchase waits for its supplier and products', (() => { const deps = dependsOn({ type: 'purchase', purchase: { supplierId: 's1', lines: [{ p: 'p1' }, { p: 'p1' }] } }); return deps.includes('supplier:s1') && deps.filter((x) => x === 'prod:p1').length === 1; })());
check('purchases need create_purchase', (queuePermissions.purchase || []).includes('create_purchase') && (queuePermissions.spay || []).includes('create_purchase'));
const args = purchaseArgs(B.purchase, B.moves);
check('purchase → RPC args and back', args.p_purchase.id === 'pu1' && args.p_purchase.supplier_id === 's1' && rowToPurchase({ ...args.p_purchase, status: 'posted', total: 1155, paid: 0 }).supplierId === 's1');
check('supplier row mapping', supplierRow({ id: 's1', name: 'A', phone: '' }).phone === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
