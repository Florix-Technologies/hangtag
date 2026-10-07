// The shop's own automation rules (src/domain/automation/custom-rules.js): WHEN a bill is over / a discount is over / a
// bill is cancelled / a return is over / a customer owes more than / a product's stock is at or below / today's sales
// reach / no sale yet by — THEN tell me, note it, or write a reminder for my OK (only where a reminder makes sense). The
// rule checked before it is kept; what each finds in a day's facts, with where it opens. Run: npm run test:unit
import { CUSTOM_MAX, TRIGGERS, actionsOf, checkCustomRule, customRulesOf, evaluateCustomRule, ruleWords, sameRule } from '../../src/domain/automation/custom-rules.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); } };

check('eight triggers; only "a customer owes more than" can write a reminder', TRIGGERS.map((t) => t.key).join() === 'bill_over,discount_over,cancelled,return_over,owes_over,stock_at,sales_reach,no_sale_by'
  && TRIGGERS.filter((t) => actionsOf(t).includes('remind')).map((t) => t.key).join() === 'owes_over' && TRIGGERS.every((t) => actionsOf(t).includes('notify') && t.perms.length));
const ok = checkCustomRule({ id: 'r1', trigger: 'bill_over', amount: '₹10,000', action: 'notify' });
check('a rule: its figure read the way people write it', JSON.stringify(ok.rule) === JSON.stringify({ id: 'r1', trigger: 'bill_over', amount: 10000, action: 'notify', on: true }), ok);
const err = (i, o) => checkCustomRule(i, o).field;
check('refused with the field: no trigger, no amount, a discount over 100%, an hour out of the day, an action the trigger can\'t have',
  err({ trigger: 'x' }) === 'trigger' && err({ trigger: 'bill_over', amount: '' }) === 'amount' && err({ trigger: 'discount_over', pct: 120 }) === 'pct'
  && err({ trigger: 'no_sale_by', hour: 3 }) === 'hour' && err({ trigger: 'bill_over', amount: 5, action: 'remind' }) === 'action' && !checkCustomRule({ trigger: 'owes_over', amount: 5000, action: 'remind' }).error);
check('a stock rule names a product the shop sells', err({ trigger: 'stock_at', qty: 5 }) === 'product' && err({ trigger: 'stock_at', qty: 5, product: 'gone' }, { products: [{ id: 'p1' }] }) === 'product'
  && checkCustomRule({ trigger: 'stock_at', qty: 0, product: 'p1' }, { products: [{ id: 'p1' }] }).rule.qty === 0);
const many = Array.from({ length: 15 }, (_, i) => ({ id: 'r' + i, trigger: 'cancelled', action: 'log' }));
check('as saved: broken ones and ones without an id dropped, at most ' + CUSTOM_MAX, customRulesOf([...many, { trigger: 'bill_over', amount: 5 }, null]).length === CUSTOM_MAX
  && customRulesOf([{ id: 'x', trigger: 'nope' }, { trigger: 'cancelled', action: 'log' }]).length === 0 && customRulesOf('x').length === 0);
check('in words', ruleWords(ok.rule) === 'A bill over ₹10,000 → Tell me' && ruleWords({ trigger: 'stock_at', qty: 10, product: 'p1', action: 'log' }, 'Basmati Rice') === 'Basmati Rice at 10 or below → Note it'
  && ruleWords({ trigger: 'owes_over', amount: 5000, action: 'remind' }) === 'A customer owing more than ₹5,000 → Write a reminder');
check('the same rule twice is the same', sameRule(ok.rule, { ...ok.rule, id: 'r9' }) && !sameRule(ok.rule, { ...ok.rule, amount: 9000 }) && !sameRule(ok.rule, { ...ok.rule, action: 'log' }));

const F = { day: '2026-10-07', hour: 12, sales: 12800,
  bills: [{ id: 's1', no: 'INV-1', total: 12000, sub: 12000, disc: 0, void: false, cust: { name: 'Riya' } }, { id: 's2', no: 'INV-2', total: 800, sub: 1000, disc: 200, void: false, cust: { name: '' } },
    { id: 's3', no: 'INV-3', total: 500, sub: 500, disc: 0, void: true, cust: { name: '' } }],
  returns: [{ id: 'x1', no: 'CN-1', value: 1500, sale: 's1', saleNo: 'INV-1' }],
  owed: [{ id: 'c1', name: 'Riya', phone: '98765 43210', amount: 6000, bills: ['INV-9'], days: 12 }, { id: 'c2', name: 'Arjun', amount: 100, bills: [], days: 1 }],
  product: { id: 'p1', name: 'Rice', qty: 8, unit: 'kg' } };
const ev = (r, G = F, o) => evaluateCustomRule({ id: 'r', action: 'notify', on: true, ...r }, G, o);
let f = ev({ trigger: 'bill_over', amount: 10000 });
check('a bill over ₹10,000: the one bill, opened', f.length === 1 && f[0].title === '1 bill over ₹10,000 today' && f[0].attr === 'data-billview="s1"' && /INV-1 · ₹12,000 · Riya/.test(f[0].sub), f);
f = ev({ trigger: 'bill_over', amount: 500 });
check('…several: Bills with the same filter (today, over ₹500); a cancelled bill isn\'t counted', f[0].title === '2 bills over ₹500 today'
  && JSON.parse(/data-billsearch='(.+)'/.exec(f[0].attr)[1]).amount.value === 500 && JSON.parse(/data-billsearch='(.+)'/.exec(f[0].attr)[1]).period.from === '2026-10-07', f);
f = ev({ trigger: 'discount_over', pct: 10 });
check('a discount over 10%: the 20% one', f.length === 1 && /discount over 10%/.test(f[0].title) && /20% \(₹200 off ₹1,000\)/.test(f[0].sub) && f[0].tone === 'warn', f);
f = ev({ trigger: 'cancelled' });
check('a bill cancelled: today\'s cancelled ones', f.length === 1 && f[0].title === '1 bill cancelled today' && /INV-3 \(₹500\)/.test(f[0].sub), f);
f = ev({ trigger: 'return_over', amount: 1000 });
check('a return over ₹1,000: its bill', f.length === 1 && f[0].attr === 'data-billview="s1"' && /₹1,500 on INV-1/.test(f[0].sub), f);
f = ev({ trigger: 'owes_over', amount: 5000, action: 'remind' }, F, { reminder: (c) => 'Pay ' + c.amount });
check('a customer owing more than ₹5,000: one each, with the reminder for an OK (only when the rule writes one)', f.length === 1 && f[0].subject === 'c1' && f[0].act.kind === 'remind' && f[0].act.text === 'Pay 6000'
  && f[0].act.amount === 6000 && ev({ trigger: 'owes_over', amount: 5000 })[0].act === null, f);
f = ev({ trigger: 'stock_at', qty: 10, product: 'p1' });
check('a product at or below 10: "Rice: 8 kg left"', f.length === 1 && f[0].title === 'Rice: 8 kg left' && f[0].attr === 'data-commandproduct="p1"' && ev({ trigger: 'stock_at', qty: 5, product: 'p1' }).length === 0, f);
check('…sold out says so', ev({ trigger: 'stock_at', qty: 3, product: 'p1' }, { ...F, product: { ...F.product, qty: 0 } })[0].title === 'Rice sold out');
check('today\'s sales reach ₹10,000 (not ₹20,000)', ev({ trigger: 'sales_reach', amount: 10000 }).length === 1 && ev({ trigger: 'sales_reach', amount: 20000 }).length === 0);
check('no sale yet by 11: only past the hour with no live bill', ev({ trigger: 'no_sale_by', hour: 11 }).length === 0 && ev({ trigger: 'no_sale_by', hour: 11 }, { ...F, bills: [F.bills[2]] }).length === 1
  && ev({ trigger: 'no_sale_by', hour: 13 }, { ...F, bills: [] }).length === 0);
check('a rule switched off finds nothing', ev({ trigger: 'cancelled', on: false }).length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
