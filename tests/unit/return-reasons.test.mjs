// Returns and after-sales (src/domain/returns/return-reasons.js): each returned line keeps why it came back; a damaged or
// faulty piece stays off the shelf by default; the return's note keeps every reason in words (what an older app reads);
// returns saved before lines had reasons fall back to the note; and Reports' after-sales summary — by reason, what came
// back most, what went back on the shelf and what stayed off. Run: npm run test:unit
import { DAMAGED, RETURN_REASONS, cleanReason, lineReasons, reasonsNote, resaleableFor, returnsByReason } from '../../src/domain/returns/return-reasons.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); } };

check('the reasons offered, damaged among them', RETURN_REASONS.length === 5 && RETURN_REASONS.includes(DAMAGED) && RETURN_REASONS[0] === "Didn't fit");
check('a reason is trimmed, single-spaced and at most 60 characters', cleanReason('  Wrong   size ') === 'Wrong size' && cleanReason('x'.repeat(80)).length === 60 && cleanReason(null) === '');
check('damaged or faulty stays off the shelf by default; every other reason goes back', !resaleableFor(DAMAGED) && resaleableFor('Wrong size') && resaleableFor(''));
check('the note: each reason once, in order', reasonsNote(['Wrong size', 'Damaged or faulty', 'Wrong size', '']) === 'Wrong size; Damaged or faulty' && reasonsNote([]) === '');
check('a line\'s own reason, else the note when it is one reason, else "Not given"', JSON.stringify(lineReasons({ note: 'Wrong size', items: [{ reason: 'Damaged or faulty' }, {}] })) === '["Damaged or faulty","Wrong size"]'
  && JSON.stringify(lineReasons({ note: 'customer changed mind, paid by UPI', items: [{}] })) === '["Not given"]');

const rets = [
  { note: 'Wrong size', items: [{ p: 'k', n: 'Kurta', q: 2, value: 2000, restock: true, reason: 'Wrong size' }] },
  { note: "Wrong size; Damaged or faulty", items: [{ p: 'k', n: 'Kurta', q: 1, value: 1000, restock: true, reason: 'Wrong size' }, { p: 'd', n: 'Dupatta', q: 1, value: 500, restock: false, reason: 'Damaged or faulty' }] },
  { note: "Didn't fit", items: [{ p: 'd', n: 'Dupatta', q: 1, value: 500 }] },   // saved before lines had reasons
];
const X = returnsByReason(rets);
check('3 returns, 5 pieces, ₹4,000 in all', X.count === 3 && X.pieces === 5 && X.value === 4000, X);
check('by reason, most pieces first: Wrong size 3, then Didn\'t fit and Damaged 1 each', X.reasons[0].reason === 'Wrong size' && X.reasons[0].pieces === 3 && X.reasons[0].value === 3000
  && X.reasons.some((r) => r.reason === "Didn't fit" && r.pieces === 1) && X.reasons.some((r) => r.reason === DAMAGED && r.pieces === 1), X.reasons);
check('came back most: Kurta (3, mostly Wrong size), then Dupatta (2)', X.products[0].name === 'Kurta' && X.products[0].pieces === 3 && X.products[0].top === 'Wrong size' && X.products[1].name === 'Dupatta' && X.products[1].pieces === 2, X.products);
check('back on the shelf 4 pieces (₹3,500); kept off, damaged, 1 (₹500)', X.shelf.pieces === 4 && X.shelf.value === 3500 && X.off.pieces === 1 && X.off.value === 500, [X.shelf, X.off]);
check('no returns: nothing', returnsByReason([]).count === 0 && returnsByReason(null).reasons.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
