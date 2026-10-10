// Products → Import (src/domain/catalog/product-import.js, src/shared/utils/csv.js, src/shared/utils/xlsx.js): the template a
// shop owner fills in (notes, plain column names, example products) matches what the importer reads; row numbers are the
// sheet's own; problems are said in the file's own column names, with what to do; Excel's usual damage (shortened barcodes,
// lost leading zeros, a non-UTF-8 "CSV") is caught; products the shop already has are refused, or left out on request.
// Run: npm run test:unit
import { IMPORT_COLUMNS, importHelpRows, importPlan, importProblemRows, importTemplateColumns, importTemplateNotes, importTemplateRows, isNoteRow, mapImportHeader, validateImport } from '../../src/domain/catalog/product-import.js';
import { csvText, decodeCsvBytes, parseCsv } from '../../src/shared/utils/csv.js';
import { xlsxBytes } from '../../src/shared/utils/xlsx.js';
import { readXlsx } from '../../src/shared/utils/xlsx-read.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info).slice(0, 1500) : ''));
}
const errs = (v) => v.rows.filter((x) => x.errors.length).map((x) => [x.line, ...x.errors]);

// ---------- the template matches the importer ----------
const T = importTemplateRows(), notes = importTemplateNotes(), cols = importTemplateColumns();
const header = T[notes.length];
check('template: the notes come first, each one cell starting with #', notes.length >= 5 && T.slice(0, notes.length).every((r) => r.length === 1 && isNoteRow(r)));
check('template: plain column names, required ones marked', header[0] === 'Product name (required)' && header.includes('Selling price (required)') && header.includes('Colour') && header.includes('Size')
  && header.includes('Stock quantity') && header.includes('Cost price') && header.includes('Barcode') && header.includes('SKU'), header);
const H = mapImportHeader(header);
check('template: every column is one the importer reads (none ignored), Colour and Size as options', !H.error && H.unknown.length === 0
  && ['name', 'price', 'cost', 'qty', 'sku', 'bc', 'cat', 'brand', 'gst', 'hsn', 'unit', 'low', 'desc'].every((k) => H.map[k] != null)
  && H.optionCols.map((o) => o.name).join() === 'Colour,Size', H);
check('template: each column has a help line and an example', cols.every((c) => c.length === 4) && importHelpRows().length === cols.length + 2 && importHelpRows()[1][1] === 'Yes');
const t = validateImport(T, {});
check('template as downloaded: its 5 example rows are left out (never imported), nothing to fix', !t.ok && t.errorCount === 0 && t.summary.examples === 5 && t.rows.every((x) => x.skip === 'example'), errs(t));
// a shop owner's first file: the template with the examples made their own
const mine = T.map((r, i) => i > notes.length ? r.map((c, j) => j === 0 ? 'My ' + c : header[j] === 'SKU' && c ? 'MY-' + c : c) : r);
const m = validateImport(mine, {});
check('the template filled in: 3 products (a T-shirt in 3 colour/size variants, a bottle, rice by kg), 73.5 in stock', m.ok && m.summary.products === 3 && m.summary.variants === 5 && m.summary.pieces === 73.5, errs(m));
const plan = importPlan(m, { ids: { product: (() => { let n = 0; return () => 'P' + (++n); })(), variant: (() => { let n = 0; return () => 'V' + (++n); })() }, colors: ['#111'], now: 1, dev: 'D' });
const tee = plan.products.find((p) => /T-shirt/.test(p.name)), rice = plan.products.find((p) => /Rice/.test(p.name));
check('…the T-shirt: options Colour (Black, White) × Size (M, L), its variants and their stock; rice in kg', tee && JSON.stringify(tee.opts) === '[{"n":"Colour","v":["Black","White"]},{"n":"Size","v":["M","L"]}]'
  && tee.variants.length === 3 && plan.moves.filter((x) => x.p === tee.id).reduce((a, x) => a + x.q, 0) === 24 && rice.unit === 'kg' && plan.products.find((p) => /Bottle/.test(p.name)).variants[0].bc === '8901234567890', plan.products);
check('the CSV round trip (Excel-style quoting) reads the same', JSON.stringify(parseCsv(csvText(mine), { keepBlank: true })) === JSON.stringify(mine.map((r) => r.map(String))));
check("the earlier template's column names are still read", !mapImportHeader(['Name', 'Category', 'Option 1 name', 'Option 1 value', 'Price', 'Cost', 'Opening stock']).error
  && mapImportHeader(['Name', 'Price', 'Opening stock']).map.qty === 2 && IMPORT_COLUMNS.find((c) => c[0] === 'qty').includes('Opening stock'));

// ---------- row numbers, notes, the file's own column names ----------
const sheet = [['# my notes'], ['Item name', 'MRP', 'Qty'], [], ['Pen', '10', '5'], ['', '', ''], ['Book', 'abc', '2'], ['#1 Tee', '99', '1'], ['# fix later'], ['Ink', '20', '1.5']];
const s = validateImport(sheet, {});
check('row numbers are the sheet\'s own (notes and blank rows counted)', s.rows.map((x) => x.line).join() === '4,6,7,9', s.rows.map((x) => x.line));
check('a note row is skipped; "#1 Tee" with a price is a product', s.rows.some((x) => x.name === '#1 Tee') && !s.rows.some((x) => /fix later/.test(x.name)));
check('problems use the file\'s own column names and say what to write', /^MRP “abc” isn't a number\. Write just the amount/.test(s.rows[1].errors[0]) && /Qty “1\.5” must be a whole number for pcs/.test(s.rows[3].errors[0]), errs(s));
check('a price with decimals says which whole amounts would do', /has decimals: use a whole amount \(349 or 350\)/.test(validateImport([['Name', 'Price'], ['A', '349.50']], {}).rows[0].errors[0]));
check('only notes, or nothing: said plainly', /only notes/.test(validateImport([['# hi']], {}).error) && /empty/.test(validateImport([[], ['']], {}).error));
check('no Product name / Selling price column: said plainly', /No Product name column/.test(validateImport([['Colour', 'Price'], ['Red', '1']], {}).error) && /No Selling price column/.test(validateImport([['Name', 'Colour'], ['A', 'Red']], {}).error));

// ---------- Excel's usual damage ----------
const x = validateImport([['Product name', 'Selling price', 'Barcode', 'HSN code', 'SKU'], ['Soap', '40', '8.90123E+12', '401', '1.2E+05']], {});
check('a barcode Excel shortened (8.90123E+12) is caught, with how to fix it', x.rows[0].errors.some((e) => /Barcode “8\.90123E\+12” was shortened by Excel.*set the Barcode column to Text/.test(e)) && x.rows[0].errors.some((e) => /^SKU “1\.2E\+05” was shortened/.test(e)), x.rows[0].errors);
check('a 3-digit HSN says Excel may have removed a 0', x.rows[0].errors.some((e) => /HSN code “401” should be 4, 6 or 8 digits \(Excel may have removed a 0/.test(e)));
check('a barcode with a wrong check digit names the column', /^Barcode: 8901234567891 isn't a valid EAN-13/.test(validateImport([['Name', 'Price', 'Barcode'], ['A', '1', '8901234567891']], {}).rows[0].errors[0]));
const ansi = new Uint8Array([...new TextEncoder().encode('Name,Price\nCaf'), 0xe9, ...new TextEncoder().encode(',90\n')]);
check('a CSV saved by Excel in the Windows code page still reads ("Café")', parseCsv(decodeCsvBytes(ansi))[1][0] === 'Café' && decodeCsvBytes(new TextEncoder().encode('₹ ok')) === '₹ ok');
check('";" separated, with notes above the column names', parseCsv('"# note, with a comma"\nName;Price\nA;10')[2][1] === '10');

// ---------- variants: one product, different combinations ----------
const v = validateImport([['Product name', 'Colour', 'Size', 'Selling price', 'Stock quantity', 'Category'],
  ['Kurta', 'Red', 'M', '899', '2', 'Ethnic'], ['Kurta', 'Red', 'L', '949', '1', ''], ['Kurta', 'Red', 'M', '899', '1', ''], ['Kurta', '', 'S', '899', '1', ''], ['Kurta', 'Blue', 'L', '899', '1', 'Western']], {});
check('one product\'s rows: the same combination twice, a missing colour and a different category are each explained', v.rows[2].errors[0] === 'Kurta Red / M is on an earlier row too.'
  && /Row 2 of Kurta has Colour and Size: every row of one product needs the same \(Size here\)/.test(v.rows[3].errors[0]) && /Category “Western” differs from row 2 of Kurta \(Ethnic\)/.test(v.rows[4].errors[0]), errs(v));
const v2 = validateImport([['Product name', 'Colour', 'Size', 'Selling price', 'Stock quantity'], ['Kurta', 'Red', 'M', '899', '2'], ['Kurta', 'Red', 'L', '949', '1']], {});
const p2 = importPlan(v2, { ids: { product: () => 'P', variant: (() => { let n = 0; return () => 'V' + (++n); })() }, now: 1, dev: 'D' });
check('a variant priced differently keeps its own price', v2.ok && p2.products[0].price === 899 && p2.products[0].variants[1].price === 949 && p2.products[0].variants[0].price === null);

// ---------- products the shop already has ----------
const catalog = [{ name: 'Pen', variants: [{ sku: 'PEN-1', o: [] }] }];
const rows = [['Product name', 'Selling price', 'SKU'], ['Pen', '10', 'PEN-1'], ['Pencil', '5', 'PCL-1']];
const ex = validateImport(rows, { products: catalog });
check('a product already in the shop is refused by default, with one clear reason (not also its SKU)', !ex.ok && ex.errorCount === 1 && ex.rows[0].errors.length === 1 && /Pen is already in your shop/.test(ex.rows[0].errors[0]) && ex.existing.join() === 'Pen', errs(ex));
const sk = validateImport(rows, { products: catalog, skipExisting: true });
check('…or, when the merchant chooses, left out and the rest imported', sk.ok && sk.summary.products === 1 && sk.summary.skipped === 1 && sk.rows[0].skip === 'existing' && sk.existing.join() === 'Pen');
const none = validateImport([['Product name', 'Selling price'], ['Pen', '10']], { products: catalog, skipExisting: true });
check('…and a file of only existing products has nothing to import (not "ok")', !none.ok && none.errorCount === 0 && none.summary.products === 0);
check('the import plan refuses a check with nothing to import', !!importPlan(none, { ids: {} }).error);

// ---------- the file given back with its problems ----------
const back = importProblemRows(sheet, s);
check('problems file: a "Problems" column after the last, each row\'s problems in it, notes untouched', back[1][3] === 'Problems' && back[3][3] === '' && /isn't a number/.test(back[5][3]) && /whole number/.test(back[8][3]) && back[0].length === 1, back);
const again = validateImport(back, {});
check('…and choosing it again reads the same rows, the Problems column ignored', again.unknown.length === 0 && again.rows.map((r) => r.line).join() === '4,6,7,9');
check('…a second round replaces the problems in the same column', importProblemRows(back, again)[1].filter((c) => c === 'Problems').length === 1);

// ---------- the Excel template: notes in grey, column names in bold, codes kept as text, reads back the same ----------
const wb = xlsxBytes([{ name: 'Products', rows: T, heads: [notes.length], notes: notes.map((_, i) => i), widths: [30, 10], textCols: [6, 7] }, { name: 'Help', rows: importHelpRows() }]);
const xml = new TextDecoder().decode(wb);
check('xlsx: column widths and Text-formatted code columns (numFmt 49), note style', /<cols><col min="1" max="1" width="30" customWidth="1"\/>/.test(xml) && /<col min="7" max="7" width="10" style="2"\/>/.test(xml) && /numFmtId="49"/.test(xml) && /s="3"/.test(xml));
const back2 = (await readXlsx(wb, { DOMParser: null }))[0].rows;
check('xlsx: the template reads back row for row', back2.length === T.length && back2[notes.length][0] === 'Product name (required)' && validateImport(back2, {}).summary.examples === 5, back2.slice(notes.length, notes.length + 2));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
