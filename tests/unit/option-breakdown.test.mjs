// Pieces sold by each of the products' own options (src/domain/reports/option-breakdown.js): whatever the shop named them
// (Storage, Pack Size, Size, Colour…), matched by name in any case; values in the shop's own order; returns net off;
// products without options counted apart; per product, its pieces by value. Run: npm run test:unit
import { optionBreakdown } from '../../src/domain/reports/option-breakdown.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); } };
const L = (pid, name, q, amt, opts) => ({ pid, name, q, amt, opts: opts.map(([n, v]) => ({ n, v })) });
const lines = [
  L('ph', 'Phone', 2, 60000, [['Colour', 'Black'], ['Storage', '256GB']]),
  L('ph', 'Phone', 1, 25000, [['colour', 'Blue'], ['storage', '128GB']]),
  L('ph', 'Phone', -1, -30000, [['Colour', 'Black'], ['Storage', '256GB']]),   // a return
  L('ku', 'Kurta', 1, 1000, [['Size', 'L']]),
  L('ri', 'Rice', 3, 900, [['Pack Size', '5kg']]),
  L('us', 'USB cable', 4, 1196, []),
];
const order = { storage: ['128GB', '256GB', '512GB'], colour: ['Black', 'Blue'] };
const B = optionBreakdown(lines, { orderOf: (name) => order[name.toLowerCase()] || null });
check('every option the products have, by its own name, most pieces first (Pack Size 3; Colour 2, Storage 2 net of the return; Size 1)', JSON.stringify(B.names) === JSON.stringify(['Pack Size', 'Colour', 'Storage', 'Size']), B.names);
check('products without options counted apart', B.plain === 4, B.plain);
const S = B.of('STORAGE');
check('an option by name in any case: Storage — 128GB 1, 256GB 1 (2 sold, 1 returned), in the shop\'s order', S.name === 'Storage' && JSON.stringify(S.values.map((v) => [v.value, v.q])) === '[["128GB",1],["256GB",1]]' && S.total === 2, S);
check('…with each value\'s share', S.values.every((v) => v.share === 50));
check('per product: its pieces by value, the amount net of returns', S.products.length === 1 && S.products[0].pid === 'ph' && S.products[0].q === 2 && S.products[0].amt === 55000 && S.products[0].by['256GB'] === 1, S.products);
check('an option nobody sold: nothing', B.of('RAM') === null);
check('a value sold then fully returned isn\'t shown', optionBreakdown([L('a', 'A', 1, 10, [['Size', 'M']]), L('a', 'A', -1, -10, [['Size', 'M']]), L('a', 'A', 1, 10, [['Size', 'L']])]).of('Size').values.map((v) => v.value).join() === 'L');
check('nothing sold: no options, no error', optionBreakdown([]).names.length === 0 && optionBreakdown(null).plain === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
