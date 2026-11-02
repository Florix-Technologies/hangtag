// Search, understood (src/domain/search/search-query.js): exact identifiers first — a bill or order number (or its last
// digits), a phone number written any way, a GSTIN, an amount — and the everyday ways people narrow bills: who, when
// (today … last month, a month's name), which (unpaid, cancelled, returned, on credit, receipts not sent), how they paid and
// how much (over / under / between / around, 2k, 1.5 lakh). A question is for the Agent. Run: npm run test:unit
import { amountMatches, filterWords, moneyOf, parseSearch } from '../../src/domain/search/search-query.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const now = new Date(2026, 9, 7, 12, 0, 0).getTime();   // Wednesday 7 October 2026
const p = s => parseSearch(s, { now });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// money, written the ways people write it
check('money: ₹2,500 / rs 2500 / 2.5k / 1.5 lakh / 2 cr', moneyOf('₹2,500') === 2500 && moneyOf('rs 2500') === 2500 && moneyOf('2.5k') === 2500
  && moneyOf('1.5 lakh') === 150000 && moneyOf('2 cr') === 20000000, [moneyOf('₹2,500'), moneyOf('rs 2500'), moneyOf('2.5k'), moneyOf('1.5 lakh'), moneyOf('2 cr')]);
check('money: not a figure → null', moneyOf('abc') === null && moneyOf('') === null);

// the whole sentence
const a = p('unpaid bills from Riya last week over 2000');
check('sentence: who, when, which, how much', same(a.words, ['riya']) && a.status === 'unpaid' && a.amount.op === 'gt' && a.amount.value === 2000
  && a.period.key === 'lastweek' && a.period.from === '2026-09-28' && a.period.to === '2026-10-04' && a.billWord && !a.ask, a);

// identifiers
const ph = p('+91 98200-11223');
check('phone written with +91, spaces and a dash → its last 10 digits, nothing else', ph.phone === '9820011223' && same(ph.words, []) && !ph.amount, ph);
check('phone with a space', p('98200 11223').phone === '9820011223');
const g = p('27ABCDE1234F1Z5');
check('GSTIN', g.gstin === '27ABCDE1234F1Z5' && !g.gst, g);
check('bill / credit note / order numbers look like identifiers', p('INV-000123').idLike && p('CN-12').idLike && p('SO 0004').idLike && p('#123').idLike && !p('riya sharma').idLike);
const n = p('2500');
check('a plain number: last digits AND an amount', n.idLike && n.digits === '2500' && n.amount && n.amount.op === 'eq' && n.amount.value === 2500, n);
check('a number in a sentence is an amount, not a phone', p('bills 2k').amount.value === 2000 && !p('bills 2k').phone);

// when
const per = s => p(s).period;
check('today / yesterday', per('bills today').from === '2026-10-07' && per('bills yesterday').from === '2026-10-06' && per('bills yesterday').to === '2026-10-06');
check('this week: since Monday', per('sales this week').from === '2026-10-05' && per('sales this week').to === '2026-10-07', per('sales this week'));
check('last 7 / 30 days', per('last 7 days').from === '2026-10-01' && per('past 30 days').from === '2026-09-08', [per('last 7 days'), per('past 30 days')]);
check('this month / last month', per('this month').from === '2026-10-01' && per('last month').from === '2026-09-01' && per('last month').to === '2026-09-30');
check('a month by name: its last occurrence', per('september').key === 'month:2026-09' && per('december').key === 'month:2025-12' && per('dec 2024').key === 'month:2024-12',
  [per('september'), per('december'), per('dec 2024')]);
check('"may" is a month only when said as one', !per('may') && same(p('may').words, ['may']) && per('sales in may').key === 'month:2026-05');
const june = p('june');
check('a month alone is also a name (a customer called June)', june.period.key === 'month:2026-06' && june.alsoName === 'june' && same(june.words, []), june);

// which, how paid
check('statuses', p('cancelled bills today').status === 'cancelled' && p('returns this week').status === 'returns' && p('on credit').status === 'credit'
  && p('udhar').status === 'credit' && p('receipts not sent').status === 'unsent' && p('paid bills').status === 'paid' && p('due').status === 'unpaid');
const upi = p('paid by upi');
check('"paid by UPI" is a method, not the Paid status', upi.method === 'upi' && !upi.status && same(upi.words, []), upi);
check('methods: gpay → UPI, card, cash', p('gpay bills').method === 'upi' && p('card').method === 'card' && p('cash sales today').method === 'cash');

// how much
const am = s => p(s).amount;
check('over / under / between / around', am('over ₹2,000').op === 'gt' && am('under 1500').op === 'lt' && am('under 1500').value === 1500
  && same([am('between 500 and 1k').value, am('between 500 and 1k').value2], [500, 1000]) && am('around 2.5k').op === 'about' && am('around 2.5k').value === 2500,
  [am('over ₹2,000'), am('under 1500'), am('between 500 and 1k'), am('around 2.5k')]);
check('₹ amount / lakh', am('₹2,500').value === 2500 && am('bills 1.5 lakh').value === 150000);
check('amount matching', !amountMatches({ op: 'gt', value: 2000 }, 2000) && amountMatches({ op: 'gt', value: 2000 }, 2001) && amountMatches({ op: 'between', value: 1000, value2: 500 }, 1000)
  && amountMatches({ op: 'about', value: 2500 }, 2600) && !amountMatches({ op: 'about', value: 2500 }, 2700) && amountMatches({ op: 'eq', value: 99.5 }, '99.50') && amountMatches(null, 5));

// GST, questions
check('GST: last month by default, or the month named', p('gst').gst.month === '2026-09' && p('gstr-1 last month').gst.month === '2026-09' && p('gst august').gst.month === '2026-08');
const q = p('how much did I sell yesterday?');
check('a question is for the Agent (its filler words dropped)', q.ask && q.period.key === 'yesterday' && same(q.words, []), q);
check('not a question', !p('riya').ask && !p('INV-000123').ask);

// the heading words
check('filter words', filterWords({ status: 'unpaid', method: 'upi', period: { label: 'last week' }, amount: { op: 'gt', value: 2000 } }, v => '₹' + v) === 'unpaid · by UPI · last week · over ₹2000'
  && filterWords({ amount: { op: 'between', value: 500, value2: 1000 } }) === '500–1000' && filterWords({}) === '');
check('empty search', same(p('  ').words, []) && !p('').period && !p('').amount);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
