// Unit tests for the domain layer: pure business rules, no browser, no state, no Supabase.
// Run: npm run test:unit
import { cleanProductName, takenCodes, validateProductDraft } from '../../src/domain/catalog/product-validation.js';
import { lineLabel, numOrNull, priceRange, vCost, vLabel, vPrice, variantsOf } from '../../src/domain/catalog/variants.js';
import { upgradeCatalog } from '../../src/domain/catalog/catalog-migration.js';
import { checkQty } from '../../src/domain/sales/cart-rules.js';
import { szRank } from '../../src/domain/catalog/sizes.js';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { formatInvoiceNo, pcsOf } from '../../src/domain/sales/sale.js';
import { lowStockThreshold, stockLevel } from '../../src/domain/inventory/stock-levels.js';
import { buildStockMoves } from '../../src/domain/inventory/stock-operation.js';
import { checkProfile, tidyProfile } from '../../src/domain/shop/profile-validation.js';
import { checkBillingSettings } from '../../src/domain/shop/settings-validation.js';
import { profileComplete } from '../../src/domain/shop/profile.js';
import { validPhone } from '../../src/shared/validation/phone.js';
import { validGstin } from '../../src/shared/validation/gstin.js';
import { validEmail } from '../../src/shared/validation/email.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- variants ----------
const tee = { id: 'p1', name: 'Tee', price: 599, cost: 300, variants: [
  { id: 'v1', c: 'Black', s: 'M', price: null, cost: null, active: true },
  { id: 'v2', c: 'Black', s: 'L', price: 649, cost: 350, active: true },
  { id: 'v3', c: 'White', s: 'M', price: null, cost: null, active: false }] };
check('variantsOf hides inactive variants unless asked for all', variantsOf(tee).length === 2 && variantsOf(tee, true).length === 3);
check('a variant without its own price or cost uses the product one', vPrice(tee, tee.variants[0]) === 599 && vCost(tee, tee.variants[0]) === 300);
check('a variant with its own price and cost overrides the product', vPrice(tee, tee.variants[1]) === 649 && vCost(tee, tee.variants[1]) === 350);
check('no cost anywhere means unknown cost (null), not zero', vCost({ price: 1, cost: null }, { cost: null }) === null);
check('price range covers the active variants', priceRange(tee) === '₹599–649', priceRange(tee));
check('variant label: its option values joined, skipping empty parts', vLabel({ o: ['Black', 'M'] }) === 'Black / M' && vLabel({ o: ['', 'M'] }) === 'M' && vLabel({ o: [] }) === '');
check('numOrNull: empty stays empty, numbers are whole and never negative', numOrNull('') === null && numOrNull('12.6') === 13 && numOrNull('-4') === 0);
check('old bill lines (colour + size only) still get a label', lineLabel({ c: 'Black', s: 'M' }) === 'Black / M' && lineLabel({ vl: '64 GB', c: '', s: '' }) === '64 GB');
check('sizes sort S, M, L, then numbers, then the rest', ['XL', '32', 'S', 'Free', 'M'].sort((a, b) => szRank(a) - szRank(b)).join(',') === 'S,M,XL,32,Free');

// ---------- product validation (same messages and order as the product editor) ----------
const draft = (over) => Object.assign({ id: 'p9', name: ' Linen   Shirt ', price: '899', cost: '', hsn: '', gst: '', hasOpts: true, opts: [{ n: 'Colour', v: ['Blue'] }, { n: 'Size', v: ['M', 'L'] }] }, over);
const combo = (c, s, cell) => ({ o: [c, s], cell: Object.assign({ sku: '', bc: '', stock: '', price: '', cost: '' }, cell) });
const V = (d, combos, taken) => validateProductDraft(d, combos, [], taken);
check('product names are trimmed with single spaces', cleanProductName('  Linen   Shirt ') === 'Linen Shirt');
check('valid draft returns the cleaned name, price and cost', eq(V(draft(), [combo('Blue', 'M')], {}), { name: 'Linen Shirt', price: 899, cost: null, hsn: '', gst: null }));
check('missing name', V(draft({ name: '  ' }), [], {}).error === 'Enter a product name.');
check('missing or negative price', V(draft({ price: '' }), [], {}).error === 'Enter a selling price (₹0 or more).' && V(draft({ price: '-1' }), [], {}).error === 'Enter a selling price (₹0 or more).');
check('negative cost', V(draft({ cost: '-5' }), [], {}).error === "Cost price can't be negative.");
check('multiple options ticked but none added', V(draft({ opts: [] }), [], {}).error === 'Add an option (for example Size), or untick “multiple options”.');
check('an option without values', V(draft({ opts: [{ n: 'Size', v: [] }] }), [], {}).error === 'Add at least one value to Size, or remove it.');
check('HSN must be 4, 6 or 8 digits; GST 0–100', V(draft({ hsn: '62O4' }), [], {}).error === 'HSN code should be 4, 6 or 8 digits.' && V(draft({ gst: '120' }), [], {}).error === 'GST % should be between 0 and 100.' && V(draft({ hsn: '620462', gst: '5' }), [], {}).gst === 5);
check('a mistyped EAN-13 check digit is caught, naming the variant', /Blue \/ M: 4006381333932 isn't a valid EAN-13/.test(V(draft(), [combo('Blue', 'M', { bc: '4006381333932' })], {}).error || ''));
check('a code kept by a removed variant still counts', validateProductDraft(draft(), [combo('Blue', 'M', { sku: 'K1' })], [{ o: ['Red', 'M'], cell: { sku: 'k1', bc: '' } }], {}).error === 'SKU K1 is used twice in this product (Red / M and Blue / M).');
const shop = [tee, { id: 'p2', name: 'Cap', opts: [], variants: [{ id: 'c1', o: [], sku: 'CAP-1', bc: '890123', active: true }] }];
const taken = takenCodes(shop, 'p9', variantsOf);
check('takenCodes lists other products\' SKUs and barcodes (case-insensitive keys)', taken['s:cap-1'] === 'Cap' && taken['b:890123'] === 'Cap');
check('takenCodes skips the product being edited', !takenCodes(shop, 'p2', variantsOf)['s:cap-1']);
check('a SKU used by another product is refused, naming it', V(draft(), [combo('Blue', 'M', { sku: 'cap-1' })], taken).error === 'SKU cap-1 is already used by Cap.');
check('a barcode used by another product is refused', V(draft(), [combo('Blue', 'M', { bc: '890123' })], taken).error === 'Barcode 890123 is already used by Cap.');
check('the same SKU twice in one product is refused', V(draft(), [combo('Blue', 'M', { sku: 'X1' }), combo('Blue', 'L', { sku: 'x1' })], {}).error === 'SKU x1 is used twice in this product (Blue / M and Blue / L).');
check('negative stock is refused', V(draft(), [combo('Blue', 'M', { stock: '-2' })], {}).error === "Stock for Blue / M can't be negative.");
check('negative variant price or cost is refused, naming the variant', V(draft(), [combo('Blue', 'M', { price: '-1' })], {}).error === "Price for Blue / M can't be negative." && V(draft(), [combo('Blue', 'M', { cost: 'x' })], {}).error === "Cost for Blue / M can't be negative.");

// ---------- catalog upgrade ----------
const v1 = { example: true, products: [{ id: 'q1', name: 'Tee', price: '499.6', color: 'bad', sizes: [{ s: 'M', stock: 5 }, { s: 'L', stock: 0 }] }, { id: 'q2', name: '', price: 100 }] };
const up = upgradeCatalog(v1, { deviceId: 'dev1', now: 1000 });
check('v1 → v3: each old size becomes a variant with a fixed id (Size option)', eq(up.cat.products[0].variants.map((v) => v.id), ['q1:M', 'q1:L']) && up.cat.version === 3 && up.cat.example === true);
check('v1 → v2: received stock becomes an opening move (none for zero)', up.moves.length === 1 && eq(up.moves[0], { id: 'open:q1:M', v: 'q1:M', p: 'q1', type: 'OPENING', q: 5, cost: null, note: 'Opening stock (moved from the old size list)', t: 1000, dev: 'dev1' }));
check('v1 → v2: a product with no sizes gets one plain variant; prices whole; bad colours reset', up.cat.products[1].variants[0].id === 'q2:' && up.cat.products[0].price === 500 && up.cat.products[0].color === '#8E8A83' && up.cat.products[1].name === 'Untitled');
const v3 = { version: 3, products: [] };
check('a v3 catalog is returned unchanged', upgradeCatalog(v3, { deviceId: 'd', now: 1 }).cat === v3);
check('v1 → v3: sizes become a Size option with aligned variants', JSON.stringify(up.cat.products[0].opts) === '[{"n":"Size","v":["M","L"]}]' && JSON.stringify(up.cat.products[0].variants[0].o) === '["M"]');

// ---------- bill line quantities ----------
check('quantity: a whole number from 1 to the stock', checkQty('3', 5).q === 3 && checkQty(' 5 ', 5).q === 5 && checkQty(2, null).q === 2);
check('quantity: 0, negative, decimals and text are refused', !!checkQty('0', 5).error && !!checkQty('-1', 5).error && !!checkQty('2.5', 5).error && !!checkQty('abc', 5).error && !!checkQty('', 5).error);
check('quantity: more than the stock is capped, with the reason', checkQty('9', 4).q === 4 && checkQty('9', 4).error === 'Only 4 in stock.' && checkQty('1', 0).error === 'That one is sold out.' && checkQty('1', 0).q === undefined);

// ---------- bill totals, invoice numbers ----------
const lines = [{ q: 2, price: 500 }, { q: 1, price: 250 }];
// one GST rate for every line (the shop's setting) and a fixed bill discount — the full rules are in tests/unit/checkout.test.mjs
const shopTotals = (ls, disc, s) => { const r = computeCheckout({ lines: ls.map((l) => ({ ...l, rate: s.taxRate })), billDisc: disc, gst: { mode: s.taxOn ? 'intra' : 'none', inclusive: !!s.taxIncl } });
  return { sub: r.sub, disc: r.disc, tax: r.tax, total: r.total, rate: r.rate, incl: r.incl }; };
check('no GST: total = subtotal − discount', eq(shopTotals(lines, 50, { taxOn: false }), { sub: 1250, disc: 50, tax: 0, total: 1200, rate: 0, incl: false }));
check('GST included in prices: tax is taken out (to the paisa), total unchanged', eq(shopTotals(lines, 0, { taxOn: true, taxRate: 5, taxIncl: true }), { sub: 1250, disc: 0, tax: 59.52, total: 1250, rate: 5, incl: true }));
check('GST added on top: total grows by the tax', eq(shopTotals(lines, 250, { taxOn: true, taxRate: 12, taxIncl: false }), { sub: 1250, disc: 250, tax: 120, total: 1120, rate: 12, incl: false }));
check('a discount larger than the bill is capped at the subtotal', shopTotals(lines, 9999, { taxOn: false }).total === 0);
check('invoice number: prefix + yymmdd + running number', formatInvoiceNo('INV-', new Date(2026, 8, 5, 10).getTime(), 7) === 'INV-260905-007' && formatInvoiceNo('', new Date(2026, 0, 1).getTime(), 123) === '260101-123');
check('pieces on a bill', pcsOf({ items: [{ q: 2 }, { q: 3 }] }) === 5);

// ---------- stock levels and stock operations ----------
check('low-stock threshold: whole, never negative', lowStockThreshold({ lowStock: '3.4' }) === 3 && lowStockThreshold({ lowStock: -2 }) === 0 && lowStockThreshold({}) === 0);
check('stock level: out / low / ok', stockLevel(0, 3) === 'out' && stockLevel(-1, 3) === 'out' && stockLevel(3, 3) === 'low' && stockLevel(4, 3) === 'ok');
let n = 0; const newId = () => 'm' + (++n);
const stockIn = buildStockMoves({ kind: 'in', productId: 'p1', values: { v1: '5', v2: '', v3: '0' }, costRaw: ' 320 ', reason: '', note: 'Invoice 42', now: 7, deviceId: 'd1' }, () => 99, newId);
check('stock in: one RESTOCK move per quantity typed, with cost and note', eq(stockIn, { moves: [{ id: 'm1', v: 'v1', p: 'p1', type: 'RESTOCK', q: 5, cost: 320, note: 'Invoice 42', t: 7, dev: 'd1' }], cost: 320 }));
const adj = buildStockMoves({ kind: 'adjust', productId: 'p1', values: { v1: '8', v2: '10' }, costRaw: '5', reason: 'Damaged', note: 'torn', now: 7, deviceId: 'd1' }, (vid) => (vid === 'v1' ? 10 : 10), newId);
check('adjustment: the move is the difference to the counted number, with the reason', adj.moves.length === 1 && adj.moves[0].q === -2 && adj.moves[0].type === 'ADJUST' && adj.moves[0].note === 'Damaged · torn' && adj.moves[0].cost === null && adj.cost === null);
check('stock in: an invalid cost is refused first', buildStockMoves({ kind: 'in', values: { v1: '5' }, costRaw: '-1' }, () => 0, newId).error === 'Enter a valid cost per piece, or leave it empty.');
check('negative quantities are refused', buildStockMoves({ kind: 'in', values: { v1: '-3' }, costRaw: '' }, () => 0, newId).error === "Quantities can't be negative.");
check('nothing typed / nothing changed is refused', buildStockMoves({ kind: 'in', values: { v1: '' }, costRaw: '' }, () => 0, newId).error === 'Enter at least one quantity.' && buildStockMoves({ kind: 'adjust', values: { v1: '4' } }, () => 4, newId).error === 'Nothing changed.');

// ---------- shop profile and settings ----------
const full = { full_name: 'Asha', shop_name: 'Asha Styles', phone: '98765 43210', business_type: null, city: 'Pune', state: 'MH', address: null, gstin: null };
check('profile values are trimmed; GST number upper case without spaces; empty becomes null', eq(tidyProfile({ full_name: '  Asha  K ', gstin: ' 27abcde 1234f1z5 ', city: '' }).full_name, 'Asha K') && tidyProfile({ gstin: ' 27abcde 1234f1z5 ' }).gstin === '27ABCDE1234F1Z5' && tidyProfile({ city: ' ' }).city === null);
check('a complete profile passes', checkProfile(full) === null && profileComplete(full));
check('a missing required field is named', eq(checkProfile(Object.assign({}, full, { city: null })), { error: 'City is required.', field: 'city' }));
check('phone needs 10–15 digits', eq(checkProfile(Object.assign({}, full, { phone: '12345' })), { error: 'Enter a valid phone number (at least 10 digits).', field: 'phone' }));
check('GST number format is checked when given', eq(checkProfile(Object.assign({}, full, { gstin: '27ABC' })), { error: 'GST number should be 15 letters and digits, like 27ABCDE1234F1Z5.', field: 'gstin' }));
check('billing settings: valid input becomes the settings to save', eq(checkBillingSettings({ lowStock: '4', taxOn: 'on', taxRate: '5.555', taxIncl: null, prefix: ' INV/ ', paper: 'a4', footer: ' Thanks ' }).patch, { lowStock: 4, prefix: 'INV/', taxOn: true, taxRate: 5.56, taxIncl: false, paper: 'a4', footer: 'Thanks' }));
check('billing settings: refused values', checkBillingSettings({ lowStock: '-1' }).error === 'Low-stock alert must be 0 or more.' && checkBillingSettings({ lowStock: '1', taxOn: 'on', taxRate: '41' }).error === 'Enter a GST rate between 0 and 40.' && checkBillingSettings({ lowStock: '1', prefix: 'bad prefix!' }).error === 'Bill number prefix can use letters, numbers, - / _ only.');
check('billing settings: GST rate is ignored when GST is off', !checkBillingSettings({ lowStock: '1', taxRate: '99' }).error);

// ---------- shared validators ----------
check('phone numbers', validPhone('+91 98765-43210') && validPhone('(080) 1234 5678') && !validPhone('98765') && !validPhone('9876543210x'));
check('GST numbers', validGstin('27ABCDE1234F1Z5') && !validGstin('27abcde1234f1z5') && !validGstin('27ABCDE1234F1Z'));
check('email addresses', validEmail('a@b.co') && !validEmail('a@b') && !validEmail('no-at.example.com'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
