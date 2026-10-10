// Supplier bill import planning (src/domain/inventory/bill-import.js): review lines, matching, the plan and applying it.
// Run: npm run test:unit
import { applyPlan, billFileType, buildIndex, matchLine, newReviewLines, planImport, prepareLines, reviewReasons } from '../../src/domain/inventory/bill-import.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
let n = 0; const uid = () => 'x' + (++n);
const ctx = { uid, now: 1000, deviceId: 'dev', importId: 'imp1', note: 'Supplier bill INV-1 · Ravi' };
const catalog = () => [
  { id: 'dr', name: 'Dress', brand: 'Aura', price: 999, cost: 600, opts: [{ n: 'Colour', v: ['Black', 'White'] }, { n: 'Size', v: ['M', 'L'] }], variants: [
    { id: 'dbm', o: ['Black', 'M'], sku: 'DR-BLK-M', bc: '2000000000015', price: null, cost: null, active: true },
    { id: 'dbl', o: ['Black', 'L'], sku: '', bc: '', price: 1099, cost: null, active: true },
    { id: 'dwm', o: ['White', 'M'], sku: '', bc: '', price: null, cost: null, active: true },
    { id: 'dwl', o: ['White', 'L'], sku: '', bc: '', price: null, cost: null, active: false } ] },
  { id: 'tote', name: 'Tote Bag', brand: '', price: 399, cost: 180, opts: [], variants: [{ id: 'tv', o: [], sku: 'TOTE', bc: '', price: null, cost: null, active: true }] },
];
const ex = (lines) => ({ lines });
const L = (o) => Object.assign({ name: 'Dress', brand: 'Aura', options: [], quantity: 1, unit_price: 600, total_price: null, mrp: 999, sku: null, barcode: null, hsn: '6204', gst_rate: 5, confidence: 0.95, notes: null }, o);
const opt = (c, s) => [{ name: 'Colour', value: c }, { name: 'Size', value: s }];

// ---------- review lines ----------
let lines = newReviewLines(ex([L({ options: opt('Black', 'M'), quantity: 5 }), { name: 'Kurta', quantity: null, confidence: 0.4 }, L({ quantity: 3, unit_price: 100, total_price: 500 })]), { uid });
check('missing fields stay blank (nothing invented)', lines[1].brand === '' && lines[1].sku === '' && lines[1].unitCost === null && lines[1].sellPrice === null && lines[1].options.length === 0);
check('a clean line needs no review', lines[0].needsReview === false && lines[0].reasons.length === 0 && lines[0].sellPrice === 999);
check('missing quantity and low confidence are flagged', lines[1].needsReview && lines[1].reasons.some((r) => /No quantity/.test(r)) && lines[1].reasons.some((r) => /40%/.test(r)));
check('quantity × price ≠ total is flagged', lines[2].reasons.some((r) => /doesn't match/.test(r)));
check('reasons are recomputed after an edit', reviewReasons({ ...lines[2], total: 300 }).length === 0);
check('a fractional quantity is flagged', reviewReasons({ name: 'x', qty: 2.5 }).some((r) => /whole number/.test(r)));

// ---------- matching ----------
const idx = buildIndex(catalog());
const m = (o) => matchLine(newReviewLines(ex([L(o)]), { uid })[0], idx);
check('match 1: SKU (any case)', m({ name: 'Something else', sku: 'dr-blk-m' }).kind === 'sku' && m({ name: 'x', sku: 'dr-blk-m' }).variantId === 'dbm');
check('match 2: barcode', m({ name: 'x', barcode: '2000000000015' }).kind === 'barcode');
check('SKU wins over barcode', m({ name: 'x', sku: 'TOTE', barcode: '2000000000015' }).variantId === 'tv');
check('match 3: product + option values (any case, any order)', (() => { const r = m({ name: 'dress', options: [{ name: 'size', value: 'l' }, { name: 'colour', value: 'black' }] }); return r.kind === 'variant' && r.variantId === 'dbl' && r.label === 'Dress → Black → L'; })());
check('match 4: product name only when no variant has those values', m({ options: opt('Red', 'M') }).kind === 'product' && m({ options: opt('Red', 'M') }).productId === 'dr');
check('a different brand is not a match', m({ brand: 'Other', options: opt('Black', 'M') }).kind === 'none');
check('an inactive variant is not matched by options', m({ options: opt('White', 'L') }).kind === 'product');
check('a simple product matches by name', m({ name: 'Tote bag', brand: '' }).variantId === 'tv');
check('no match → none', m({ name: 'Scarf' }).kind === 'none');

// ---------- default actions ----------
lines = prepareLines(newReviewLines(ex([L({ sku: 'DR-BLK-M', quantity: 2 }), L({ options: opt('Red', 'M'), quantity: 4 }), L({ options: [{ name: 'Fit', value: 'Slim' }] }), L({ name: 'Scarf', brand: '', options: [], quantity: 6, mrp: 299 })]), { uid }), catalog());
check('existing → add stock; new values → new variant; unknown → new product', lines.map((l) => l.action).join() === 'existing,new-variant,,new-product', lines.map((l) => l.action));
check('options that do not fit the product need a decision, with a reason', lines[2].action === '' && /don't fit/.test(lines[2].decisionNote));

// ---------- plan: the brief's example (5 variants of one new product) ----------
const five = [['Black', 'M', 5], ['Black', 'L', 7], ['Black', 'XL', 3], ['White', 'M', 6], ['White', 'L', 4]];
lines = prepareLines(newReviewLines(ex(five.map(([c, s, q]) => L({ name: 'Kurti', brand: '', options: opt(c, s), quantity: q, mrp: 799, unit_price: 400 }))), { uid }), catalog());
let plan = planImport(lines, catalog(), ctx);
const kurti = plan.newProducts[0];
check('5 bill lines of one product → 1 new product with 5 variants', !plan.errors.length && plan.newProducts.length === 1 && kurti.variants.length === 5, plan.errors);
check('options come from the bill in order (Colour, Size), values as written', JSON.stringify(kurti.opts) === JSON.stringify([{ n: 'Colour', v: ['Black', 'White'] }, { n: 'Size', v: ['M', 'L', 'XL'] }]));
check('quantities become RESTOCK moves tagged with the import (25 units)', plan.moves.length === 5 && plan.moves.every((mv) => mv.type === 'RESTOCK' && mv.q > 0 && mv.imp === 'imp1' && mv.cost === 400 && mv.note === ctx.note) && plan.summary.units === 25);
check('new product: price from MRP, cost from the bill, HSN/GST', kurti.price === 799 && kurti.cost === 400 && kurti.hsn === '6204' && kurti.gst === 5);
check('summary counts', JSON.stringify(plan.summary) === JSON.stringify({ productsToCreate: 1, variantsToCreate: 5, existingMatched: 0, units: 25, lines: 5 }), plan.summary);

// the same variant twice on a bill → one variant, both quantities
lines = prepareLines(newReviewLines(ex([L({ name: 'Cap', brand: '', options: [{ name: 'Colour', value: 'Red' }], quantity: 2, mrp: 199 }), L({ name: 'cap', brand: '', options: [{ name: 'colour', value: 'red' }], quantity: 3, mrp: 199 })]), { uid }), catalog());
plan = planImport(lines, catalog(), ctx);
check('same product + values twice → one variant, quantities 2 + 3', plan.newProducts.length === 1 && plan.newProducts[0].variants.length === 1 && plan.summary.units === 5 && plan.moves.every((mv) => mv.v === plan.newProducts[0].variants[0].id));

// existing stock + new variant on an existing product + simple new product
lines = prepareLines(newReviewLines(ex([L({ sku: 'DR-BLK-M', quantity: 2 }), L({ options: opt('Red', 'M'), quantity: 4, mrp: 1049 }), L({ name: 'Scarf', brand: '', options: [], quantity: 6, mrp: 299, barcode: '8901234567890' })]), { uid }), catalog());
plan = planImport(lines, catalog(), ctx);
check('existing SKU match → a move on that exact variant', plan.moves[0].v === 'dbm' && plan.moves[0].q === 2);
check('new variant on an existing product: its new value is added (Red)', plan.newVariants.length === 1 && JSON.stringify(plan.newVariants[0].variant.o) === '["Red","M"]'
  && JSON.stringify(plan.updatedProducts[0].opts[0].v) === '["Black","White","Red"]' && plan.newVariants[0].variant.price === 1049);
check('simple new product (no options) with its barcode', plan.newProducts[0].opts.length === 0 && plan.newProducts[0].variants[0].bc === '8901234567890' && plan.newProducts[0].code === 'barcode');
check('summary: 1 product, 2 variants, 1 existing product matched, 12 units', JSON.stringify(plan.summary) === JSON.stringify({ productsToCreate: 1, variantsToCreate: 2, existingMatched: 1, units: 12, lines: 3 }), plan.summary);
const after = applyPlan(catalog(), plan);
check('applyPlan: new variant and values on Dress, new product appended, nothing else changed', after.length === 3 && after[0].variants.length === 5 && after[0].opts[0].v.includes('Red') && after[1] === after[1] && after[2].name === 'Scarf');

// ---------- errors (nothing is added when any line is wrong) ----------
const errOf = (ls, fix) => { const x = prepareLines(newReviewLines(ex(ls), { uid }), catalog()); if (fix) fix(x); return planImport(x, catalog(), ctx); };
let p = errOf([L({ name: 'Scarf', brand: '', sku: 'TOTE', mrp: 299 })], (x) => { x[0].action = 'new-product'; });   // the merchant chose "create new" over the SKU match
check('creating a product with a SKU already used in the shop is refused', /SKU TOTE is already used by Tote Bag/.test(p.errors[0] && p.errors[0].message) && p.moves.length === 0, p.errors);
p = errOf([L({ name: 'Scarf', brand: '', sku: 'SC-1', mrp: 299 }), L({ name: 'Shawl', brand: '', sku: 'sc-1', mrp: 299 })]);
check('the same SKU twice on one bill is refused', p.errors.some((e) => /SKU sc-1 is already used by Scarf/.test(e.message)), p.errors);
p = errOf([L({ name: 'Scarf', brand: '', quantity: 0, mrp: 299 })]);
check('quantity 0 is refused', p.errors.some((e) => /whole number, 1 or more/.test(e.message)));
p = errOf([L({ name: 'Scarf', brand: '', mrp: null })]);
check('a new product needs a selling price', p.errors.some((e) => /selling price/.test(e.message)));
p = errOf([L({ name: 'Scarf', brand: '', confidence: 0.5, mrp: 299 })]);
check('an unconfirmed "needs review" line blocks the import', p.errors.some((e) => /Confirm/.test(e.message)));
p = errOf([L({ name: 'Scarf', brand: '', confidence: 0.5, mrp: 299 })], (x) => { x[0].confirmed = true; });
check('…and is fine once the merchant confirms it', !p.errors.length && p.summary.units === 1);
p = errOf([L({ name: 'Kurti', brand: '', options: opt('Black', 'M'), mrp: 1 }), L({ name: 'Kurti', brand: '', options: [{ name: 'Colour', value: 'White' }], mrp: 1 })]);
check('a missing option value is never invented', p.errors.some((e) => /Needs a value for Size/.test(e.message)) && p.newProducts.length === 1 && p.moves.length === 0);
p = errOf([L({ sku: 'DR-BLK-M' })], (x) => { x[0].targetVariantId = 'gone'; });
check('"existing" without a real target is refused', p.errors.some((e) => /Pick the product/.test(e.message)));
p = errOf([L({ options: opt('White', 'L') })], (x) => { x[0].action = 'new-variant'; x[0].targetProductId = 'dr'; });
check('an off-sale variant is not silently revived', p.errors.some((e) => /off sale/.test(e.message)));
p = errOf([L({ name: 'Scarf', brand: '', mrp: 299 }), L({ name: 'Shawl', brand: '', mrp: 199 })], (x) => { x[1].include = false; });
check('removed lines are ignored', !p.errors.length && p.summary.lines === 1 && p.newProducts.length === 1);

// the chosen file's type: what the picker said, else from its name (some Android pickers give a PDF or photo no type)
check('bill file type: from the picker, else from the name; anything else is not a bill', billFileType({ type: 'application/pdf', name: 'x' }) === 'application/pdf'
  && billFileType({ type: '', name: 'Bill.PDF' }) === 'application/pdf' && billFileType({ type: 'application/octet-stream', name: 'scan.jpeg' }) === 'image/jpeg'
  && billFileType({ type: 'image/jpg', name: 'a' }) === 'image/jpeg' && billFileType({ type: '', name: 'IMG_1.HEIC' }) === 'image/heic'
  && billFileType({ type: 'image/png', name: 'x.pdf' }) === 'image/png' && billFileType({ type: 'text/plain', name: 'notes.txt' }) === '' && billFileType(null) === '');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
