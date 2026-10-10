// The shop's own product fields (domain/catalog/attributes.js) and units (domain/catalog/units.js), with products Hangtag has
// no template for: LED grow lights (Wattage, Spectrum), vinyl records (Pressing year, RPM), aquarium fish (Water type),
// hand-knotted rugs sold by the square foot (Knots per sq inch, Hand-knotted). Definitions are checked (types, choices,
// rules, names the built-in fields need), values are read from forms and sheets, a product shows the fields of its category
// and every field it already has a value for, nothing unknown is dropped, a choice renamed changes every product using it
// (variants keep their ids), and a shop's own units carry their decimals and GST code everywhere. Run: npm run test:unit
import { ATTR_LIMITS, appliesTo, attrSearchText, attrText, attrUsage, attrValue, checkAttrDef, checkAttrs, checkLinkedValues, cleanAttrValues,
  fieldsFor, nameKey, parseDay, renameAttrValue, reservedName, variantFields } from '../../src/domain/catalog/attributes.js';
import { allUnits, checkQty, checkShopUnit, decimalsOf, isMeasured, isWeighed, qtyText, setShopUnits, shopUnits, unitId, unitOf } from '../../src/domain/catalog/units.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const def = (input, ctx) => checkAttrDef({ id: input.id || 'a_' + nameKey(input.name).replace(/\W/g, ''), ...input }, ctx);

console.log('=== a field is defined ===');
const watt = def({ name: 'Wattage', type: 'choice', options: ['100 W', '200 W', '300 W'] }).attr;
const spectrum = def({ name: 'Spectrum', type: 'choice', options: 'Full spectrum, Bloom, Veg', cats: 'Grow lights' }).attr;
const year = def({ name: 'Pressing year', type: 'number', min: 1900, max: '2100', cats: ['Vinyl'] }).attr;
const rpm = def({ name: 'RPM', type: 'choice', options: ['33⅓', '45', '78'], cats: ['Vinyl'] }).attr;
const water = def({ name: 'Water type', type: 'choice', options: ['Fresh', 'Salt', 'Brackish'], required: true, cats: ['Fish'] }).attr;
const knots = def({ name: 'Knots per sq inch', type: 'number', unit: 'KPSI', cats: ['Rugs'] }).attr;
const handmade = def({ name: 'Hand-knotted', type: 'yesno', cats: ['Rugs'] }).attr;
const beam = def({ name: 'Beam angle', type: 'decimal', dp: 1, unit: '°', min: 0, max: 360 }).attr;
const conn = def({ name: 'Connectivity', type: 'multi', options: ['Bluetooth', 'Wi-Fi', 'Zigbee'] }).attr;
const tested = def({ name: 'Tested on', type: 'date' }).attr;
const notes = def({ name: 'Origin', type: 'text', maxLen: 20 }).attr;
check('every kind of field can be made: text, whole and decimal numbers, date, yes/no, one choice, several choices',
  [watt, spectrum, year, rpm, water, knots, handmade, beam, conn, tested, notes].every(Boolean) && [watt.type, year.type, beam.type, tested.type, handmade.type, conn.type, notes.type].join() === 'choice,number,decimal,date,yesno,multi,text');
check('choices from a list or "a, b, c"; categories from a list or "a, b"', eq(spectrum.options, ['Full spectrum', 'Bloom', 'Veg']) && eq(spectrum.cats, ['Grow lights']) && eq(year.cats, ['Vinyl']));
check('rules kept: lowest / highest, decimals, the unit after a number, required, longest text',
  year.min === 1900 && year.max === 2100 && year.dp === 0 && beam.dp === 1 && beam.unit === '°' && knots.unit === 'KPSI' && water.required === true && notes.maxLen === 20);
const ALL = [watt, spectrum, year, rpm, water, knots, handmade, beam, conn, tested, notes];

const refused = (input, re, ctx) => { const r = def(input, ctx); return !!r.error && re.test(r.error) ? true : r; };
check('a field can\'t take a built-in field\'s name, and says where that lives instead',
  refused({ name: 'IMEI', type: 'text' }, /Serial number/) === true && refused({ name: 'Expiry date', type: 'date' }, /Batch with expiry date/) === true
  && refused({ name: 'selling  price', type: 'number' }, /built in/) === true && refused({ name: 'Stock', type: 'number' }, /stock records/) === true
  && refused({ name: 'sku', type: 'text' }, /SKU is built in/) === true && refused({ name: 'GST %', type: 'decimal' }, /GST/) === true);
check('…but names close to them are fine (MRP, Dye lot, Model number)', ['MRP', 'Dye lot', 'Model number'].every((n) => !def({ name: n, type: 'text' }).error) && reservedName('Batch no') && !reservedName('Batch size'));
check('names are unique in the shop (any case and spacing); an archived field\'s name can be used again',
  refused({ name: '  wattage ', type: 'text' }, /already a field called/, { attrs: ALL }) === true
  && !def({ name: 'Wattage', type: 'text' }, { attrs: [{ ...watt, archived: true }] }).error);
check('a name is needed, up to 32 characters, not starting with #',
  refused({ name: ' ', type: 'text' }, /Give the field a name/) === true && refused({ name: 'x'.repeat(33), type: 'text' }, /up to 32/) === true && refused({ name: '#Notes', type: 'text' }, /#/) === true);
check('a list field needs a choice; a choice twice or too long is refused',
  refused({ name: 'Finish', type: 'choice', options: [] }, /at least one choice/) === true && refused({ name: 'Finish', type: 'choice', options: ['Matte', 'matte'] }, /twice/) === true
  && refused({ name: 'Finish', type: 'multi', options: ['x'.repeat(41)] }, /up to 40/) === true
  && refused({ name: 'Finish', type: 'choice', options: Array.from({ length: 101 }, (_, i) => 'C' + i) }, /up to 100/) === true);
check('number rules: lowest above highest, decimals out of range, whole-number limits',
  refused({ name: 'Weight', type: 'number', min: 10, max: 5 }, /lowest value is above/) === true && refused({ name: 'Weight', type: 'decimal', dp: 5 }, /1 to 4/) === true
  && refused({ name: 'Weight', type: 'number', min: 1.5 }, /must be whole/) === true && refused({ name: 'Weight', type: 'decimal', dp: 1, max: 2.25 }, /more than 1 decimal/) === true);
check(`a shop has up to ${ATTR_LIMITS.maxFields} fields in use`, refused({ name: 'One more', type: 'text' }, /up to 60 fields/, { attrs: Array.from({ length: 60 }, (_, i) => ({ id: 'f' + i, name: 'F' + i, type: 'text' })) }) === true);
check('the kind of field is needed', refused({ name: 'Finish' }, /what kind of field/) === true);

console.log('\n=== changing a field that products use ===');
const lamp1 = { id: 'p1', name: 'LED Grow Light', cat: 'Grow lights', attrs: { [spectrum.id]: 'Bloom', [beam.id]: 120 }, opts: [{ n: 'Wattage', v: ['100 W', '200 W'], a: watt.id }],
  variants: [{ id: 'v1', o: ['100 W'] }, { id: 'v2', o: ['200 W'] }] };
const lamp2 = { id: 'p2', name: 'LED Panel', cat: 'Grow lights', attrs: { [spectrum.id]: 'Full spectrum' }, opts: [{ n: 'Size', v: ['2 ft', '4 ft'] }, { n: 'Wattage', v: ['100 W'], a: watt.id }],
  variants: [{ id: 'v3', o: ['2 ft', '100 W'] }, { id: 'v4', o: ['4 ft', '100 W'] }] };
const record = { id: 'p3', name: 'Blue Note 1500', cat: 'Vinyl', attrs: { [year.id]: 1959, [conn.id]: ['Bluetooth'] } };
const PRODUCTS = [lamp1, lamp2, record];
const usage = attrUsage(PRODUCTS, watt);
check('usage counts products by their values and their linked options, choice by choice',
  usage.products === 2 && usage.variants === 2 && usage.values === 0 && usage.byOption['100 w'] === 2 && usage.byOption['200 w'] === 1 && !usage.byOption['300 w'], usage);
const used = { attrs: ALL, before: watt, usage };
check('a field in use keeps its type', refused({ id: watt.id, name: 'Wattage', type: 'text' }, /used by 2 products, so its type can't change/, used) === true);
check('a choice in use can\'t be removed (sent empty, or left out of the list)',
  refused({ id: watt.id, name: 'Wattage', type: 'choice', options: [{ was: '100 W', now: '' }, { was: '200 W', now: '200 W' }, { was: '300 W', now: '300 W' }] }, /100 W is used by 2 products/, used) === true
  && refused({ id: watt.id, name: 'Wattage', type: 'choice', options: [{ was: '100 W', now: '100 W' }, { was: '300 W', now: '300 W' }] }, /200 W is used by 1 product,/, used) === true);
const ren = def({ id: watt.id, name: 'Wattage', type: 'choice', options: [{ was: '100 W', now: '100 W' }, { was: '200 W', now: '200 W' }, { was: '300 W', now: '' }, { was: null, now: '600 W' }, { was: '100 W', now: '100 W' }].slice(0, 4) }, used);
check('an unused choice can be removed, one added; renaming one in use is allowed', !ren.error && eq(ren.attr.options, ['100 W', '200 W', '600 W']) && eq(ren.renames, []), ren);
const ren2 = def({ id: watt.id, name: 'Wattage', type: 'choice', options: [{ was: '100 W', now: '100 Watt' }, { was: '200 W', now: '200 W' }, { was: '300 W', now: '300 W' }] }, used);
check('…a renamed choice comes back as [from, to]', !ren2.error && eq(ren2.renames, [['100 W', '100 Watt']]), ren2);
const changed = renameAttrValue(PRODUCTS, watt, '100 W', '100 Watt');
const c2 = changed.find((p) => p.id === 'p2');
check('renaming a choice changes the linked options and the variants\' values in every product (ids kept, other options untouched)',
  changed.length === 2 && eq(changed[0].opts[0].v, ['100 Watt', '200 W']) && eq(changed[0].variants.map((v) => [v.id, v.o]), [['v1', ['100 Watt']], ['v2', ['200 W']]])
  && eq(c2.opts[0].v, ['2 ft', '4 ft']) && eq(c2.variants.map((v) => v.o), [['2 ft', '100 Watt'], ['4 ft', '100 Watt']]) && lamp1.opts[0].v[0] === '100 W', changed);
const multiRen = renameAttrValue(PRODUCTS, conn, 'bluetooth', 'Bluetooth 5');
check('…and values: one choice, or one of several', multiRen.length === 1 && eq(multiRen[0].attrs[conn.id], ['Bluetooth 5']) && renameAttrValue(PRODUCTS, spectrum, 'Bloom', 'Flower')[0].attrs[spectrum.id] === 'Flower');

console.log('\n=== values from a form or a sheet ===');
const v = (a, raw) => attrValue(a, raw);
check('a choice in any case comes back in the field\'s spelling; one not in the list is refused with the choices', v(watt, '200 w').value === '200 W' && /Choose from: 100 W, 200 W, 300 W/.test(v(watt, '150 W').error));
check('several choices from "a; b" or "a, b": the field\'s order, each once', eq(v(conn, 'zigbee; wi-fi, Zigbee').value, ['Wi-Fi', 'Zigbee']) && /no choice “LoRa”/.test(v(conn, 'Wi-Fi, LoRa').error));
check('whole numbers: "1,200" is 1200; decimals, words and limits refused', v(knots, '1,200').value === 1200 && /whole number/.test(v(knots, '12.5').error) && /isn't a number/.test(v(knots, 'many').error)
  && /below 1900/.test(v(year, 1850).error) && v(year, '1959').value === 1959);
check('the field\'s unit may be typed after the number ("120 KPSI", "35.5°")', v(knots, '120 KPSI').value === 120 && v(beam, '35.5°').value === 35.5 && /up to 1 decimal/.test(v(beam, '35.55').error) && /above 360/.test(v(beam, 400).error));
check('dates: 2026-12-31, 31/12/2026, 31-12-2026 and Excel\'s day numbers; impossible dates refused',
  v(tested, '2026-12-31').value === '2026-12-31' && v(tested, '31/12/2026').value === '2026-12-31' && v(tested, '1-2-2026').value === '2026-02-01' && v(tested, 45291).value === '2023-12-31'
  && /isn't a date/.test(v(tested, '31/02/2026').error) && parseDay('2026-02-30') === null);
check('yes / no: yes, Y, true, 1, ✓ and no, N, false, 0', [ 'yes', 'Y', 'true', '1', '✓' ].every((x) => v(handmade, x).value === true) && [ 'no', 'N', 'false', '0' ].every((x) => v(handmade, x).value === false) && /Yes or No/.test(v(handmade, 'maybe').error));
check('text: tidied, up to its longest', v(notes, '  Bhadohi   region ').value === 'Bhadohi region' && /up to 20 characters/.test(v(notes, 'x'.repeat(21)).error));
check('an empty value is empty, whatever the kind', [watt, year, beam, tested, handmade, conn, notes].every((a) => v(a, '').empty && v(a, null).empty));
check('values read for people', attrText(beam, 35.5) === '35.5 °' && attrText(handmade, true) === 'Yes' && attrText(conn, ['Wi-Fi', 'Zigbee']) === 'Wi-Fi, Zigbee' && attrText(year, 1959) === '1959' && attrText(year, null) === '');

console.log('\n=== which fields a product shows ===');
const fishy = { id: 'f1', name: 'Neon Tetra', cat: 'Fish', attrs: {} };
check('a field limited to categories shows only there (any case); a field for all shows everywhere',
  eq(fieldsFor(ALL, fishy).map((a) => a.name), ['Beam angle', 'Connectivity', 'Origin', 'Tested on', 'Water type', 'Wattage']) && appliesTo(water, 'fish') && !appliesTo(water, 'Vinyl'));
check('…a field the product has a value for shows even for another category, or archived', fieldsFor([...ALL.filter((a) => a.id !== conn.id), { ...conn, archived: true }], record).map((a) => a.name).includes('Connectivity')
  && fieldsFor(ALL, record).some((a) => a.name === 'Pressing year') && !fieldsFor([{ ...knots, archived: true }], record).length);
check('the category being typed decides (before the product is saved)', fieldsFor(ALL, fishy, 'Rugs').some((a) => a.name === 'Hand-knotted') && !fieldsFor(ALL, fishy, 'Rugs').some((a) => a.name === 'Water type'));
check('fields that can make variants: one choice, text and numbers (not dates, yes/no or several choices)',
  eq(variantFields(ALL).map((a) => a.type).sort(), ['choice', 'choice', 'choice', 'choice', 'decimal', 'number', 'number', 'text']));

console.log('\n=== a product\'s values checked on save ===');
let r = checkAttrs(ALL, fishy, { [water.id]: '' });
check('a required field is required in its categories', /Water type is required for Fish/.test(r.error), r);
r = checkAttrs(ALL, { ...fishy, cat: 'Vinyl' }, { [water.id]: '' }, 'Vinyl');
check('…and not elsewhere', !r.error, r);
r = checkAttrs(ALL, fishy, { [water.id]: 'salt', [beam.id]: '', [tested.id]: '05/10/2026' });
check('values come back checked, empty ones left out', !r.error && eq(Object.entries(r.attrs).sort(), Object.entries({ [water.id]: 'Salt', [tested.id]: '2026-10-05' }).sort()), r);
const withUnknown = { ...record, attrs: { ...record.attrs, a_from_another_phone: 'Kept', [conn.id]: ['Bluetooth'] } };
r = checkAttrs([...ALL.filter((a) => a.id !== conn.id), { ...conn, archived: true }], withUnknown, { [year.id]: '1960' });
check('a value for a field this device doesn\'t know, or an archived field, is kept as it is', !r.error && r.attrs.a_from_another_phone === 'Kept' && eq(r.attrs[conn.id], ['Bluetooth']) && r.attrs[year.id] === 1960, r);
r = checkAttrs(ALL, record, { [year.id]: '' });
check('clearing a value removes it', !r.error && !(year.id in r.attrs), r);
r = checkAttrs(ALL, record, { [year.id]: 'nineteen' });
check('a wrong value stops the save with the field\'s name', /Pressing year: “nineteen” isn't a number/.test(r.error), r);
check('values downloaded are plain values only', eq(cleanAttrValues({ ok: 'x', n: 2, b: false, l: ['a', 3], bad: { x: 1 }, 'bad key!': 'x', nan: NaN }), { ok: 'x', n: 2, b: false, l: ['a'] }));
check('search text holds the values as people read them', /bloom/i.test(attrSearchText(ALL, lamp1)) && /120 °/.test(attrSearchText(ALL, lamp1)));
check('an option linked to a field takes only its values, in its spelling', eq(checkLinkedValues(watt, ['100 w', '300 W']).values, ['100 W', '300 W']) && /no choice “150 W”/.test(checkLinkedValues(watt, ['150 W']).error)
  && eq(checkLinkedValues(knots, ['100', '150']).values, ['100', '150']) && /whole number/.test(checkLinkedValues(knots, ['1.5']).error));

console.log('\n=== the shop\'s own units ===');
const roll = checkShopUnit({ label: 'Roll', uqc: 'ROL' }).unit, sqft = checkShopUnit({ label: 'Sq ft', dp: 2, uqc: 'SQF' }).unit;
check('a unit is made from its name: the code from the letters, counted or measured from its decimals', roll.id === 'roll' && roll.dp === 0 && roll.kind === 'count' && sqft.id === 'sqft' && sqft.kind === 'measure' && sqft.uqc === 'SQF');
check('a unit Hangtag has is refused (by code, symbol or name)', /already has Kg/.test(checkShopUnit({ label: 'KG' }).error) && /already has Dozen/.test(checkShopUnit({ label: 'doz' }).error) && /already has Piece/.test(checkShopUnit({ label: 'Piece' }).error));
check('codes and names are unique; decimals 0 to 3; a GST code from the list',
  /code roll/.test(checkShopUnit({ label: 'Roll' }, { units: [roll] }).error) && /called Sq ft/.test(checkShopUnit({ id: 'sqfeet', label: 'sq ft' }, { units: [sqft] }).error)
  && /0 \(counted/.test(checkShopUnit({ label: 'Bale', dp: 4 }).error) && /GST unit code/.test(checkShopUnit({ label: 'Bale', uqc: 'XYZ' }).error) && /start with a letter/.test(checkShopUnit({ label: '12 pack' }).error));
check('a unit in use keeps its code and decimals', /used by 3 products, so its decimals can't change/.test(checkShopUnit({ label: 'Sq ft', dp: 3 }, { units: [sqft], before: sqft, used: 3 }).error)
  && checkShopUnit({ id: 'other', label: 'Square feet', dp: 2 }, { units: [sqft], before: sqft, used: 3 }).unit.id === 'sqft');
setShopUnits([roll, sqft, { ...checkShopUnit({ label: 'Bale' }).unit, archived: true }, { id: 'kg', label: 'Mine' }, { id: 'Bad Code' }]);
check('the shop\'s units are known everywhere: decimals, symbol, GST code; Hangtag\'s own can\'t be replaced', decimalsOf('sqft') === 2 && unitOf('roll').uqc === 'ROL' && qtyText(12.5, 'sqft') === '12.5 sqft'
  && qtyText(3, 'roll') === '3 roll' && unitOf('kg').label === 'Kg' && shopUnits().length === 3 && unitId('sqft') === 'sqft');
check('archived units still read on old products and lines, but aren\'t offered for new ones', unitOf('bale').label === 'Bale' && !allUnits().some((u) => u.id === 'bale') && allUnits().some((u) => u.id === 'roll'));
check('quantities follow the unit\'s decimals', checkQty('12.25', 'sqft').q === 12.25 && /at most 2 decimal/.test(checkQty('12.255', 'sqft').error) && /whole number/.test(checkQty('1.5', 'roll').error));
check('a code nobody defined here reads as itself (up to 3 decimals); anything else is a piece', unitOf('cartonx').sym === 'cartonx' && decimalsOf('cartonx') === 3 && unitOf('Not a code').id === 'pcs' && unitId('BAD') === 'pcs');
check('measured units are one bill line whatever the quantity; only Hangtag\'s weights and volumes go on the scale', isMeasured('sqft') && !isMeasured('roll') && !isWeighed('sqft') && isWeighed('kg'));
setShopUnits([]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
