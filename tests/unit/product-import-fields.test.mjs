// Import and export with the shop's own fields (domain/catalog/product-import.js, domain/catalog/attributes.js), on products
// Hangtag has no template for: LED grow lights by Wattage, vinyl records with a pressing year, hand-knotted rugs sold by the
// square foot. The template is built from the shop's fields and option names; a column named as a field imports into it;
// a value the same on every row of a product is the product's, one that differs makes its variants (an option taking its
// values from the field); wrong values, required fields and fields that can't make variants are said plainly; a column
// the shop has no field for is listed with the kind of field its values suggest (never dropped silently); and the export
// reads back as the same products, variants and values. Run: npm run test:unit
import { exportProductRows, importPlan, importTemplateColumns, importTemplateNotes, importTemplateRows, importHelpRows, mapImportHeader, suggestAttr, validateImport } from '../../src/domain/catalog/product-import.js';
import { checkAttrDef } from '../../src/domain/catalog/attributes.js';
import { checkShopUnit, setShopUnits } from '../../src/domain/catalog/units.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const def = (x) => checkAttrDef(x).attr;
const WATT = def({ id: 'at_watt', name: 'Wattage', type: 'choice', options: ['100 W', '200 W', '300 W'], cats: ['Grow lights'] });
const SPEC = def({ id: 'at_spec', name: 'Spectrum', type: 'choice', options: ['Full spectrum', 'Bloom', 'Veg'] });
const YEAR = def({ id: 'at_year', name: 'Pressing year', type: 'number', min: 1900, max: 2100, cats: ['Vinyl'] });
const KNOT = def({ id: 'at_knot', name: 'Hand-knotted', type: 'yesno', required: true, cats: ['Rugs'] });
const MRP = def({ id: 'at_mrp', name: 'MRP', type: 'number' });
const TESTED = def({ id: 'at_tested', name: 'Tested on', type: 'date' });
const ATTRS = [WATT, SPEC, YEAR, KNOT, MRP, TESTED];
const ctx = { attrs: ATTRS, optionNames: ['Shade'] };
const ids = () => { let n = 0; return { product: () => 'P' + (++n), variant: () => 'V' + (++n) }; };

console.log('=== the template follows the shop ===');
const cols = importTemplateColumns(ctx), heads = cols.map((c) => c[1]);
check('option columns are the shop\'s own (Shade), not a fixed Colour / Size', heads.includes('Shade') && !heads.includes('Colour') && !heads.includes('Size'), heads);
check('every field has its column, named as the field (required ones marked), after the built-in columns', eq(heads.slice(-6), ['Wattage', 'Spectrum', 'Pressing year', 'Hand-knotted (required)', 'MRP', 'Tested on'])
  && cols.findIndex((c) => c[0] === 'desc') < cols.findIndex((c) => c[0] === 'attr:at_watt'), heads);
const help = importHelpRows(ctx).find((r) => r[0] === 'Wattage'), year = importHelpRows(ctx).find((r) => r[0] === 'Pressing year');
check('the help says what each field takes', /One of: 100 W, 200 W, 300 W\. For Grow lights\..*variants/.test(help[2]) && /whole number, from 1900 to 2100\. For Vinyl\./.test(year[2]) && importHelpRows(ctx).find((r) => r[0] === 'Hand-knotted')[1] === 'Yes', { help, year });
check('the notes name the fields, and how a field makes variants', importTemplateNotes(ctx).some((n) => /Your own fields have a column each, at the end: Wattage, Spectrum/.test(n) && /makes those rows its variants/.test(n)));
const plain = importTemplateColumns().map((c) => c[1]);
check('a shop without fields or options gets the template as before (Colour, Size)', plain[1] === 'Colour' && plain[2] === 'Size' && !plain.some((h) => /Wattage/.test(h)));
const tmpl = validateImport(importTemplateRows(ctx), ctx);
check('the template\'s own example rows are recognised and left out, nothing to fix', !tmpl.error && tmpl.errorCount === 0 && tmpl.summary.examples === 5, tmpl.error || tmpl.rows.filter((x) => x.errors.length));

console.log('\n=== field columns ===');
const H = mapImportHeader(['Product name', 'Selling price', 'MRP', 'wattage', 'Shade', 'Lumens'], ctx);
check('a header named as a field is its column (any case); a field takes even a loose alias (MRP), never a template header',
  H.attrCols.map((c) => c.attr.id).join() === 'at_mrp,at_watt' && H.map.price === 1 && H.optionCols.map((c) => c.name).join() === 'Shade' && H.unknown.join() === 'Lumens', H);
const sheet = [
  ['Product name', 'Selling price', 'Category', 'Wattage', 'Spectrum', 'Stock quantity', 'Tested on', 'MRP'],
  ['LED Grow Light', '4999', 'Grow lights', '100 W', 'Bloom', '4', '05/10/2026', '5499'],
  ['LED Grow Light', '7999', 'Grow lights', '200 w', 'Bloom', '2', '', '8999'],
  ['Clip Fan', '899', 'Grow lights', '', 'Veg', '6', '2026-10-01', ''],
];
let v = validateImport(sheet, ctx);
const lamp = v.products && v.products.find((p) => p.name === 'LED Grow Light');
check('a field whose value differs between a product\'s rows makes its variants (its values in the field\'s spelling)', !v.error && v.ok && eq(lamp.opts, [{ n: 'Wattage', v: ['100 W', '200 W'], a: 'at_watt' }, { n: 'MRP', v: ['5499', '8999'], a: 'at_mrp' }]), v.error || v.rows.filter((x) => x.errors.length));
check('…a value the same on every row (or only on one) is the product\'s own', eq(Object.entries(lamp.attrs).sort(), [['at_spec', 'Bloom'], ['at_tested', '2026-10-05']]) && v.products[1].attrs.at_spec === 'Veg', lamp.attrs);
const plan = importPlan(v, { ids: ids(), now: 1, dev: 'd' });
const pl = plan.products[0];
check('the plan: the product\'s values, its options taking their values from the fields, its variants', eq(pl.attrs, lamp.attrs) && pl.opts[0].a === 'at_watt' && eq(pl.variants.map((x) => x.o), [['100 W', '5499'], ['200 W', '8999']])
  && eq(plan.moves.map((m) => m.q), [4, 2, 6]), pl);
v = validateImport([['Product name', 'Selling price', 'Wattage', 'Tested on', 'Pressing year'], ['Panel', '10', '150 W', '31/02/2026', '1850']], ctx);
const errs = v.rows[0].errors.join(' | ');
check('wrong values are refused on their row, with the field\'s name and what it takes', /Wattage has no choice “150 W”\. Choose from: 100 W, 200 W, 300 W/.test(errs) && /Tested on: “31\/02\/2026” isn't a date/.test(errs) && /Pressing year can't be below 1900/.test(errs), errs);
v = validateImport([['Product name', 'Selling price', 'Tested on', 'Colour'], ['Panel', '10', '2026-10-01', 'Red'], ['Panel', '10', '2026-10-02', 'Blue']], ctx);
check('a date (or yes/no, several choices) that differs between a product\'s rows is refused: it can\'t make variants', /Tested on differs between the rows of Panel: a date field can't make variants/.test(v.rows[0].errors.join(' ')), v.rows.map((x) => x.errors));
v = validateImport([['Product name', 'Selling price', 'Wattage'], ['Bar Light', '10', '100 W'], ['Bar Light', '10', '200 W'], ['Bar Light', '10', '']], ctx);
check('…a row missing the value that tells the rows apart says so', /Wattage is empty on this row: the rows of Bar Light are told apart by it/.test(v.rows[2].errors.join(' ')), v.rows.map((x) => x.errors));
v = validateImport([['Product name', 'Selling price', 'Wattage'], ['Bar Light', '10', '100 W'], ['Bar Light', '10', '']], ctx);
check('…and rows with one value (or none) are one product\'s rows that nothing tells apart', /also on row 2\. Rows of one product need/.test(v.rows[1].errors.join(' ')), v.rows.map((x) => x.errors));
v = validateImport([['Product name', 'Selling price', 'Category'], ['Kashan 4x6', '45000', 'Rugs']], ctx);
check('a required field for the category: add its column', /Hand-knotted is required for Rugs: add a Hand-knotted column/.test(v.rows[0].errors.join(' ')), v.rows[0].errors);
v = validateImport([['Product name', 'Selling price', 'Category', 'Hand-knotted'], ['Kashan 4x6', '45000', 'Rugs', ''], ['Tabriz 5x8', '65000', 'Rugs', 'yes']], ctx);
check('…or fill it in; given, it is taken (yes → Yes)', /Hand-knotted is required for Rugs: fill it in/.test(v.rows[0].errors.join(' ')) && !v.rows[1].errors.length && v.products[1].attrs.at_knot === true, v.rows.map((x) => x.errors));
v = validateImport([['Product name', 'Selling price', 'Shade'], ['Lacquer', '450', 'Gloss'], ['Lacquer', '450', 'Matte']], ctx);
check('an option name the shop\'s products use (Shade) is an option column, as Colour and Size are', v.ok && eq(v.products[0].opts, [{ n: 'Shade', v: ['Gloss', 'Matte'] }]), v.rows.map((x) => x.errors));

console.log('\n=== columns the shop has no field for ===');
v = validateImport([['Product name', 'Selling price', 'Lumens', 'Beam angle', 'IP rating', 'Dimmable', 'Released', 'Notes', 'IMEI'],
  ['Spot A', '10', '800', '36.5', 'IP65', 'Yes', '2026-01-05', 'Warm glow for living rooms', '358240051111110'],
  ['Spot B', '12', '1200', '24', 'IP44', 'No', '2026-02-11', 'Very bright, for kitchens and garages', '358240051111111'],
  ['Spot C', '14', '1600', '15.25', 'IP65', 'Yes', '2026-03-17', 'For outdoors', '358240051111112']], ctx);
const sg = Object.fromEntries(v.unknownCols.map((c) => [c.name, c.suggest ? c.suggest.type + (c.suggest.options ? ':' + c.suggest.options.join('/') : '') + (c.suggest.dp ? ':' + c.suggest.dp : '') : '']));
check('each is listed, with the kind its values suggest: whole number, decimal (its decimals), choice (its values), yes/no, date, text',
  sg.Lumens === 'number' && sg['Beam angle'] === 'decimal:2' && sg['IP rating'] === 'choice:IP65/IP44' && sg.Dimmable === 'yesno' && sg.Released === 'date' && sg.Notes === 'text', sg);
check('…a column a built-in feature covers says where that lives (IMEI: serial numbers)', /Serial number/.test((v.unknownCols.find((c) => c.name === 'IMEI') || {}).why || ''), v.unknownCols);
check('…and the rest of the file is still checked and importable', v.ok && v.summary.products === 3);
check('suggestions: an empty column is text; "12" and "007" are numbers, 31/12/2026 a date', suggestAttr([]).type === 'text' && suggestAttr(['12', '7']).type === 'number' && suggestAttr(['31/12/2026', '1/1/2027']).type === 'date');

console.log('\n=== the shop\'s own units ===');
setShopUnits([checkShopUnit({ label: 'Sq ft', dp: 2, uqc: 'SQF' }).unit]);
v = validateImport([['Product name', 'Selling price', 'Unit', 'Stock quantity', 'Category', 'Hand-knotted'], ['Kashan rug', '450', 'Sq ft', '24.5', 'Rugs', 'Yes'], ['Jute runner', '120', 'sqft', '10.125', 'Rugs', 'No']], ctx);
check('a unit of the shop\'s own is taken by name or code; its decimals hold', v.rows[0].unit === 'sqft' && !v.rows[0].errors.length && /at most 2 decimal places for sqft/.test(v.rows[1].errors.join(' ')), v.rows.map((x) => [x.unit, x.errors]));
check('…the template lists it with Hangtag\'s units', /sqft/.test(importTemplateColumns(ctx).find((c) => c[0] === 'unit')[2]));
setShopUnits([]);
check('…and without it the unit is refused, pointing to Units', /isn't one Hangtag knows.*Settings → Products & Inventory → Units/.test(validateImport([['Product name', 'Selling price', 'Unit'], ['Rug', '450', 'sqft']], {}).rows[0].errors.join(' ')));

console.log('\n=== the export reads back as the same products ===');
const catalog = [
  { id: 'p1', name: 'LED Grow Light', price: 4999, cost: 3000, cat: 'Grow lights', unit: 'pcs', opts: [{ n: 'Wattage', v: ['100 W', '200 W'], a: 'at_watt' }, { n: 'Shade', v: ['Black'] }],
    variants: [{ id: 'v1', o: ['100 W', 'Black'], sku: 'LGL-100', price: null }, { id: 'v2', o: ['200 W', 'Black'], sku: 'LGL-200', price: 7999 }, { id: 'v3', o: ['300 W', 'Black'], active: false }],
    attrs: { at_spec: 'Bloom', at_tested: '2026-10-05' } },
  { id: 'p2', name: 'Blue Train', price: 2499, cat: 'Vinyl', opts: [], variants: [{ id: 'v4', o: [], bc: '' }], attrs: { at_year: 1957 } },
  { id: 'p3', name: 'Old lamp', price: 10, archived: true, opts: [], variants: [{ id: 'v5', o: [] }] },
];
const stock = { v1: 4, v2: 2, v4: 1 };
const rows = exportProductRows(catalog, { attrs: ATTRS, stockOf: (id) => stock[id] || 0 });
check('one row per variant for sale, archived products left out', rows.length === 1 + 3, rows.length);
const hx = rows[0], col = (name) => hx.indexOf(name);
check('the variants\' values sit in the field\'s column; the product\'s own values on each of its rows; option columns as the products have them',
  rows[1][col('Wattage')] === '100 W' && rows[2][col('Wattage')] === '200 W' && rows[1][col('Spectrum')] === 'Bloom' && rows[2][col('Tested on')] === '2026-10-05'
  && rows[3][col('Pressing year')] === '1957' && rows[1][col('Shade')] === 'Black' && rows[2][col('Selling price')] === 7999 && rows[1][col('Stock quantity')] === 4, { hx, rows });
const re = validateImport(rows, { attrs: ATTRS });
const rp = re.ok ? importPlan(re, { ids: ids(), now: 1, dev: 'd' }).products : [];
const lgl = rp.find((p) => p.name === 'LED Grow Light'), bt = rp.find((p) => p.name === 'Blue Train');
// (the options come back in the file's column order: option columns first, the shop's fields at the end)
const byName = (o) => o.map((x) => [x.n, x.v, x.a || null]).sort();
check('…and import back as the same products, variants, values and stock (into a shop with the same fields)', re.ok && lgl && eq(byName(lgl.opts), byName([{ n: 'Wattage', v: ['100 W', '200 W'], a: 'at_watt' }, { n: 'Shade', v: ['Black'] }]))
  && eq(lgl.attrs, { at_spec: 'Bloom', at_tested: '2026-10-05' }) && eq(lgl.variants.map((x) => [x.o.slice().sort(), x.sku, x.price]), [[['100 W', 'Black'], 'LGL-100', null], [['200 W', 'Black'], 'LGL-200', 7999]])
  && bt && bt.attrs.at_year === 1957 && re.summary.pieces === 7, re.error || re.rows.filter((x) => x.errors.length).map((x) => x.errors));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
