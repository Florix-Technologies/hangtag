// Generic product options: combinations, labels, matrix views, the v2 → v3 catalog upgrade and the editor operations.
// Run: npm run test:unit
import * as O from '../../src/domain/catalog/options.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const vals = (n, p) => Array.from({ length: n }, (_, i) => p + (i + 1));

// ---------- combinations ----------
check('no options → one empty combination (a simple product)', eq(O.combos([]), [[]]) && O.variantCount([]) === 1);
check('one option → one combination per value', eq(O.combos([{ n: 'Storage', v: ['64 GB', '128 GB'] }]), [['64 GB'], ['128 GB']]));
const two = [{ n: 'Colour', v: ['Black', 'White'] }, { n: 'Size', v: ['S', 'M', 'L'] }];
check('two options → cartesian product, first option slowest', eq(O.combos(two), [['Black', 'S'], ['Black', 'M'], ['Black', 'L'], ['White', 'S'], ['White', 'M'], ['White', 'L']]));
const ten = [{ n: 'Colour', v: vals(10, 'C') }, { n: 'Size', v: vals(10, 'S') }];
const c100 = O.combos(ten);
check('10 colours × 10 sizes = 100 unique variants', c100.length === 100 && new Set(c100.map(O.tupleKey)).size === 100 && O.variantCount(ten) === 100);
check('3 options multiply (2 × 3 × 2 = 12)', O.combos([...two, { n: 'Material', v: ['Cotton', 'Linen'] }]).length === 12);
check('an option without values takes no part yet', O.combos([...two, { n: 'Fit', v: [] }]).length === 6);
check('tuple keys ignore case', O.tupleKey(['Black', 'M']) === O.tupleKey(['black', 'm']));

// ---------- names, labels, legacy ----------
check('option names/values are tidied', O.cleanOptionName('  Pack   Size ') === 'Pack Size' && O.cleanOptionValue(' Black / White ') === 'Black/White');
check('colour/size names (for old reports only)', O.isColourOption('Color') && O.isColourOption('Colours') && O.isColourOption('shade') && O.isSizeOption('Size') && !O.isSizeOption('Pack Size'));
check('variant label joins values', O.vLabel({ o: ['Black', 'M'] }) === 'Black / M' && O.vLabel({ o: [] }) === '');
check('line label: new lines use vl, old ones colour + size', O.lineLabel({ vl: '64 GB / Blue' }) === '64 GB / Blue' && O.lineLabel({ c: 'Black', s: 'M' }) === 'Black / M' && O.lineLabel({ s: 'L' }) === 'L');
const phone = { opts: [{ n: 'Storage', v: ['64 GB'] }, { n: 'Colour', v: ['Blue'] }], variants: [{ id: 'v1', o: ['64 GB', 'Blue'], active: true }] };
check('option snapshot for bill lines', eq(O.optionSnapshot(phone, phone.variants[0]), [{ n: 'Storage', v: '64 GB' }, { n: 'Colour', v: 'Blue' }]));
check('legacy c/s come from colour/size-named options only', eq(O.legacyCS(phone.opts, ['64 GB', 'Blue']), { c: 'Blue', s: '' }) && eq(O.legacyCS(two, ['Black', 'M']), { c: 'Black', s: 'M' }));

// ---------- matrix views ----------
const dress = { opts: two, variants: O.combos(two).map((o, i) => ({ id: 'v' + i, o, active: true })) };
dress.variants.push({ id: 'old', o: ['Red', 'M'], active: false });   // a leftover
check('matrix rows/cols from options (rows = all but last)', eq(O.rowVals(dress), ['Black', 'White']) && eq(O.colVals(dress), ['S', 'M', 'L']) && eq(O.matrixNames(dress), { row: 'Colour', col: 'Size' }));
check('findVariant places the exact variant', O.findVariant(dress, 'White', 'M').id === 'v4' && O.findVariant(dress, 'white', 'm').id === 'v4');
check('a leftover is never placed in the matrix', O.rowKey(dress, dress.variants[6]) === null && O.findVariant(dress, 'Red', 'M', true) === null);
const three = { opts: [{ n: 'Colour', v: ['Black'] }, { n: 'Material', v: ['Cotton', 'Linen'] }, { n: 'Size', v: ['S'] }], variants: [] };
check('3 options: rows combine the first two', eq(O.rowVals(three), ['Black / Cotton', 'Black / Linen']) && O.matrixNames(three).row === 'Colour / Material');
check('simple product: one blank row and column', eq(O.rowVals({ opts: [] }), ['']) && eq(O.colVals({ opts: [] }), ['']));
check('summary text', O.productSummary(dress) === '2 colours · 3 sizes' && O.productSummary(phone) === '1 variant' && O.productSummary({ opts: [] }) === '');

// ---------- validation ----------
check('checkOptions: fine', O.checkOptions(two) === null);
check('checkOptions: duplicate value (any case)', /twice/.test(O.checkOptions([{ n: 'Size', v: ['M', 'm'] }]).error));
check('checkOptions: duplicate option name', /already/.test(O.checkOptions([{ n: 'Size', v: ['M'] }, { n: 'size', v: ['L'] }]).error));
check('checkOptions: at most 3 options', /up to 3/.test(O.checkOptions([1, 2, 3, 4].map((i) => ({ n: 'O' + i, v: ['a'] }))).error));
check('checkOptions: at most 400 variants', /400/.test(O.checkOptions([{ n: 'A', v: vals(21, 'a') }, { n: 'B', v: vals(20, 'b') }]).error));
check('checkOptions: an option needs a value and a name', /at least one value/.test(O.checkOptions([{ n: 'Fit', v: [] }]).error) && /name/.test(O.checkOptions([{ n: ' ', v: ['a'] }]).error));

// ---------- v2 → v3 ----------
const v2 = { version: 2, example: false, products: [
  { id: 'p1', name: 'Tee', price: 499, cost: null, colors: ['Black', 'White'], sizes: ['S', 'M'], variants: [
    { id: 'a', c: 'Black', s: 'S', sku: 'T-B-S', bc: '4006381333931', price: 549, cost: 200, active: true },
    { id: 'b', c: 'White', s: 'M', sku: '', bc: '', price: null, cost: null, active: true },
    { id: 'c', c: 'Navy', s: 'M', sku: '', bc: '', price: null, cost: null, active: true } ] },
  { id: 'p2', name: 'Jeans', price: 999, colors: [], sizes: ['30', '32'], variants: [
    { id: 'd', c: '', s: '30', sku: '', bc: '', price: null, cost: null, active: true },
    { id: 'e', c: 'Blue', s: '32', sku: '', bc: '', price: null, cost: null, active: false } ] },
  { id: 'p3', name: 'Tote', price: 399, colors: [], sizes: [], variants: [{ id: 'f', c: '', s: '', sku: 'TOTE', bc: '', price: null, cost: null, active: true }] } ] };
const v3 = O.migrateCatalogV3(v2), [t, j, tote] = v3.products;
check('v3: version bumped, colours then sizes become options', v3.version === 3 && eq(t.opts, [{ n: 'Colour', v: ['Black', 'White', 'Navy'] }, { n: 'Size', v: ['S', 'M'] }]));
check('v3: variants keep id, SKU, barcode, price, cost; c/s gone', eq(t.variants[0], { id: 'a', o: ['Black', 'S'], sku: 'T-B-S', bc: '4006381333931', price: 549, cost: 200, active: true }) && !('colors' in t) && !('c' in t.variants[1]));
check('v3: a colour missing from the list is added, so nothing for sale is lost', t.variants[2].active && eq(t.variants[2].o, ['Navy', 'M']));
check('v3: sizes only → one Size option', eq(j.opts, [{ n: 'Size', v: ['30', '32'] }]) && eq(j.variants[0].o, ['30']));
check('v3: a leftover with a colour on a product without colours stays inactive with its values', eq(j.variants[1].o, ['Blue', '32']) && j.variants[1].active === false);
check('v3: no colours and no sizes → a simple product', eq(tote.opts, []) && eq(tote.variants[0].o, []) && tote.variants[0].sku === 'TOTE');
check('v3: new fields default, barcode turns codes on', t.hsn === '' && t.gst === null && t.code === 'barcode' && j.code === '');
check('v3: running it again changes nothing (same object)', O.migrateCatalogV3(v3) === v3);
const dup = O.migrateProductV3({ id: 'x', colors: ['Red'], sizes: [], variants: [{ id: 'm', c: 'Red', s: '', active: true }, { id: 'n', c: 'red', s: '', active: true }] });
check('v3: a duplicate tuple from bad data is kept but made unique and inactive', dup.variants[1].active === false && O.tupleKey(dup.variants[0].o) !== O.tupleKey(dup.variants[1].o));

// ---------- editor operations ----------
const stock = { a: 5, b: 0, c: 2 };
let st = O.editorState(t, (id) => stock[id] || 0);
check('editor state: one cell per variant with stock', Object.keys(st.cells).length === 3 && st.cells[O.tupleKey(['Black', 'S'])].stock === '5');
check('editorCombos adds blank cells for new combinations', O.editorCombos(st).length === 6 && O.editorCombos(st).filter((x) => !x.cell.exists).length === 3);
let s2 = O.renameValue(st, 0, 0, 'Jet Black');
const renamed = s2.cells[O.tupleKey(['Jet Black', 'S'])];
check('rename a value: same id, stock and SKU', renamed && renamed.id === 'a' && renamed.stock === '5' && renamed.sku === 'T-B-S' && !s2.cells[O.tupleKey(['Black', 'S'])]);
check('operations never change the state they get', st.cells[O.tupleKey(['Black', 'S'])].id === 'a');
check('rename to an existing value is refused', /already has/.test(O.renameValue(st, 0, 0, 'white').error));
s2 = O.removeValue(st, 0, 2);   // Navy
check('remove a value: its saved variants become removed (kept for history)', O.removedCells(s2).map((r) => r.cell.id).join() === 'c');
check('affectedBy lists what a removal would take away', O.affectedBy(st, 0, 2).map((r) => r.cell.id).join() === 'c');
const back = O.addValues(s2, 0, 'Navy');
check('add the value back: the same variant is revived', back.cells[O.tupleKey(['Navy', 'M'])].id === 'c' && back.cells[O.tupleKey(['Navy', 'M'])].active && !O.removedCells(back).length);
const plus = O.addValues(O.addOption(st, 'Material'), 2, ['Cotton', 'Linen']);
check('add an option to a product with variants: they keep ids with its first value', plus.cells[O.tupleKey(['Black', 'S', 'Cotton'])].id === 'a' && O.editorCombos(plus).length === 12);
const minus = O.removeOption(st, 1);   // Size: first value S survives
check('remove an option: variants with its first value survive, the rest are removed',
  minus.cells[O.tupleKey(['Black'])].id === 'a' && eq(O.removedCells(minus).map((r) => r.cell.id).sort(), ['b', 'c']));
check('renameOption keeps values and cells', O.renameOption(st, 1, 'Fit Size').opts[1].n === 'Fit Size' && O.renameOption(st, 1, 'Fit Size').opts[1].v.join() === 'S,M' && O.renameOption(st, 1, 'Fit Size').cells[O.tupleKey(['Black', 'S'])].id === 'a');
check('addOption: at most 3 and no duplicates', /up to 3/.test(O.addOption(O.addOption(st, 'A'), 'B').error || O.addOption(O.addOption(O.addOption(st, 'A'), 'B'), 'C').error) && /already/.test(O.addOption(st, 'size').error));
check('addValues: too many variants is refused', /400/.test(O.addValues({ opts: ten, cells: {} }, 0, vals(40, 'x')).error));
check('addValues: blanks and repeats are skipped', O.addValues(st, 1, ' , m, L').opts[1].v.join() === 'S,M,L');
const simple = O.editorState({ opts: [], variants: [{ id: 's1', o: [], sku: 'A', active: true }] }, () => 3);
const toVar = O.addValues(O.addOption(simple, 'Size'), 0, ['M', 'L']);
check('simple → options: the single variant takes the first value (id and stock kept)', toVar.cells[O.tupleKey(['M'])].id === 's1' && toVar.cells[O.tupleKey(['M'])].stock === '3');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
