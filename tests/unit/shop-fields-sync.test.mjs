// The shop's own fields and units on their way to and from the cloud (schema.sql section 3z): product rows carry their
// values only when they have some (an older database still takes every other product), options keep the field they take
// their values from, fields and units round-trip through their rows, a product's upload waits for a field still on its
// way, merged uploads keep what both waited for, only manage_products uploads them, an edit of values is an edit of its
// own, and the variant editor keeps an option's field through every change. Run: npm run test:unit
import { attrRow, rowToAttr, rowToUnit, unitRow } from '../../src/infrastructure/supabase/biz-mappers.js';
import { productRow, rowToProduct } from '../../src/infrastructure/supabase/mappers.js';
import { BIZ_UPLOAD_PERMISSIONS, dependsOn, isBlocked, mergeProductUpload, uploadAllowed, waitingKeys } from '../../src/domain/sync/queue-rules.js';
import { productChanges } from '../../src/domain/catalog/product-changes.js';
import { addOption, addValues, editorState, removeValue, renameOption, renameValue } from '../../src/domain/catalog/options.js';
import { attrIdsOf, checkAttrDef, renameAttrValues } from '../../src/domain/catalog/attributes.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('=== product rows ===');
const lamp = { id: 'p1', name: 'LED Grow Light', price: 4999, cat: 'Grow lights', opts: [{ n: 'Wattage', v: ['100 W', '200 W'], a: 'at_watt' }, { n: 'Size', v: ['2 ft'] }],
  variants: [{ id: 'v1', o: ['100 W', '2 ft'] }, { id: 'v2', o: ['200 W', '2 ft'] }], attrs: { at_spec: 'Bloom', at_beam: 120.5, at_list: ['Wi-Fi'], at_bad: { no: 1 } } };
const row = productRow(lamp, 0);
check('a product with values sends them (plain values only)', eq(row.attrs, { at_spec: 'Bloom', at_beam: 120.5, at_list: ['Wi-Fi'] }), row.attrs);
check('…and its options keep the field they take their values from', eq(row.options.opts, [{ name: 'Wattage', values: ['100 W', '200 W'], attr: 'at_watt' }, { name: 'Size', values: ['2 ft'] }]), row.options.opts);
const plain = productRow({ id: 'p2', name: 'Tee', price: 500, opts: [], variants: [{ id: 'v', o: [] }] }, 1);
check('a product with no values sends no attrs at all (an older database, without the column, still takes it)', !('attrs' in plain), Object.keys(plain));
check('a product whose values were all removed sends an empty set (clears them)', eq(productRow({ ...lamp, attrs: {} }, 0).attrs, {}));
const back = rowToProduct({ ...row, category: 'Grow lights', options: row.options });
check('downloaded: values and option fields come back', eq(back.attrs, row.attrs) && back.opts[0].a === 'at_watt' && !('a' in back.opts[1]), back);
check('…a row with no values has no attrs (as before)', !('attrs' in rowToProduct({ ...plain, attrs: {} })) && !('attrs' in rowToProduct(plain)));

console.log('\n=== field and unit rows ===');
const watt = checkAttrDef({ id: 'at_watt', name: 'Wattage', type: 'choice', options: ['100 W', '200 W'], cats: ['Grow lights'], required: true }).attr;
const beam = checkAttrDef({ id: 'at_beam', name: 'Beam angle', type: 'decimal', dp: 1, unit: '°', min: 0, max: 360 }).attr;
const ar = attrRow(watt), br = attrRow(beam);
check('a field\'s row: its rules as one object, only those that apply', eq(ar.rules, { required: true }) && eq(br.rules, { required: false, min: 0, max: 360, dp: 1, unit: '°' }) && eq(ar.categories, ['Grow lights']), { ar, br });
const wb = rowToAttr({ ...ar, created_at: '2026-10-10T10:00:00Z' }), bb = rowToAttr(br);
check('…and back', wb.name === 'Wattage' && wb.required && eq(wb.options, watt.options) && eq(wb.cats, ['Grow lights']) && bb.dp === 1 && bb.unit === '°' && bb.min === 0 && bb.max === 360 && wb.t > 0, { wb, bb });
const sq = { id: 'sqft', label: 'Sq ft', dp: 2, kind: 'measure', uqc: 'SQF', archived: false };
check('a unit\'s row and back', eq(unitRow(sq), { id: 'sqft', label: 'Sq ft', decimals: 2, kind: 'measure', uqc: 'SQF', archived: false }) && eq(rowToUnit(unitRow(sq)), sq));

console.log('\n=== the upload queue ===');
check('a product\'s fields: its values and its options\' fields, each once', eq(attrIdsOf(lamp).sort(), ['at_bad', 'at_beam', 'at_list', 'at_spec', 'at_watt']) && eq(attrIdsOf({}), []));
const prod = { type: 'prod', id: 'p1', need: ['biz:at:at_watt'] };
const queue = [{ type: 'biz', kind: 'at', id: 'at_watt', rec: {} }, prod];
check('a product waits while a field it uses is still on its way', eq(dependsOn(prod), ['biz:at:at_watt']) && isBlocked(prod, waitingKeys(queue, [], new Set())));
check('…and goes once the field is up', !isBlocked(prod, waitingKeys(queue, [], new Set([queue[0]]))));
check('…a field refused into the review keeps it waiting (the database would refuse it too)', isBlocked(prod, waitingKeys([prod], [{ item: queue[0] }], new Set())));
const m1 = mergeProductUpload({ type: 'prod', id: 'p1', fields: ['attrs'], vars: [], need: ['biz:at:a'] }, { type: 'prod', id: 'p1', fields: ['name'], vars: [], need: ['biz:at:b'] });
const m2 = mergeProductUpload({ type: 'prod', id: 'p1', need: ['biz:at:a'] }, { type: 'prod', id: 'p1', fields: ['attrs'], vars: [] });
check('merged uploads wait for what either needed (an edit and a whole upload alike)', eq(m1.need, ['biz:at:a', 'biz:at:b']) && eq(m1.fields, ['attrs', 'name']) && eq(m2.need, ['biz:at:a']) && !m2.fields);
check('only someone who may manage products uploads fields and units (and their removal)', eq(BIZ_UPLOAD_PERMISSIONS.at, ['manage_products']) && eq(BIZ_UPLOAD_PERMISSIONS.un, ['manage_products'])
  && !uploadAllowed({ type: 'biz', kind: 'at' }, (p) => p === 'create_sale') && uploadAllowed({ type: 'bizdel', kind: 'un' }, (p) => p === 'manage_products'));
const c1 = productChanges({ ...lamp }, { ...lamp, attrs: { ...lamp.attrs, at_spec: 'Veg' } });
check('changing values is an edit of attrs only (other fields edited on another till stay)', eq(c1.fields, ['attrs']) && eq(c1.variants, []), c1);
check('…no values and an empty set are the same', eq(productChanges({ id: 'x', name: 'X' }, { id: 'x', name: 'X', attrs: {} }).fields, []));

console.log('\n=== the variant editor keeps an option\'s field ===');
let st = editorState(lamp, () => 0);
check('the editor starts with the option\'s field', st.opts[0].a === 'at_watt' && !('a' in st.opts[1]), st.opts);
st = addOption(st, 'Spectrum', 'at_spectrum');
const one = editorState({ opts: [{ n: 'Wattage', v: ['100 W'], a: 'at_watt' }], variants: [{ id: 'v1', o: ['100 W'] }] }, () => 0);
check('an option added from a field keeps it; the same field twice is refused', st.opts[2].a === 'at_spectrum' && /already an option for Watts/.test(addOption(one, 'Watts', 'at_watt').error || ''), st.opts);
st = addValues(st, 2, 'Bloom, Veg');
st = renameValue(st, 2, 1, 'Vegetative');
st = removeValue(st, 0, 1);
st = renameOption(st, 1, 'Length');
check('…through adding, renaming and removing values and renaming another option', st.opts[0].a === 'at_watt' && st.opts[2].a === 'at_spectrum' && eq(st.opts[2].v, ['Bloom', 'Vegetative'])
  && st.opts[1].n === 'Length' && !('a' in st.opts[1]), st.opts);

console.log('\n=== renaming choices all at once ===');
const swap = renameAttrValues([lamp], watt, [['100 W', '200 W'], ['200 W', '100 W']]);
check('two choices swapping names swap (not both ending as one)', eq(swap[0].opts[0].v, ['200 W', '100 W']) && eq(swap[0].variants.map((v) => v.o[0]), ['200 W', '100 W']) && eq(swap[0].variants.map((v) => v.id), ['v1', 'v2']), swap[0]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
