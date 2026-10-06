// Automation rules (src/domain/automation/rules.js): the policies each rule may have (nothing is ever sent by itself),
// the watch rules (Off / Notify me: they only notice and tell), the shop's settings with safe defaults, the form check,
// what changed (for the log), the reminder text, and the log (bounded, newest first, each entry once across devices;
// the Hangtag Agent's entries carry an audit). Run: npm run test:unit
import { AUTOMATION_DEFAULTS, AUTOMATION_RULES, LOG_ACTIONS, LOG_MAX, NOTICE_MAX, POLICY_LABELS, WATCH_DEFAULTS, WATCH_LABELS, WATCH_POLICIES, WATCH_RULES, automationOf, automationRule, checkAutomationSettings, dueReminderText, logEntry, mergeLogs, policyChanges, watchOf, watchRule } from '../../src/domain/automation/rules.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); } };

check('three rules: reorder drafts, payment reminders, UPI checks', AUTOMATION_RULES.map((r) => r.key).join() === 'reorder,dues,upi');
check('a payment reminder is never sent by itself (off or ask only); UPI is checked or not (never asks)', JSON.stringify(automationRule('dues').policies) === '["off","ask"]'
  && JSON.stringify(automationRule('upi').policies) === '["off","auto"]' && automationRule('reorder').policies.includes('auto'));
check('reorder drafts need purchase orders on and someone who may make them', automationRule('reorder').cap === 'uses_purchase_orders' && automationRule('reorder').perms.includes('create_purchase'));
check('every policy has a label; every rule explains itself', AUTOMATION_RULES.every((r) => r.policies.every((p) => POLICY_LABELS[p]) && r.help.length > 30));
const WATCH0 = { stock: 'notify', overdue: 'notify', mismatch: 'notify', late: 'notify', lateDays: 3, unusual: 'off', expiry: 'notify', receipts: 'notify', dayclose: 'notify', closeHour: 21, gst: 'notify' };
check('defaults: ask before drafting or reminding, check UPI automatically, reminders after 7 days; every watch rule but unusual sales notifies',
  JSON.stringify(automationOf({})) === JSON.stringify({ reorder: 'ask', dues: 'ask', dueDays: 7, upi: 'auto', watch: WATCH0 }) && AUTOMATION_DEFAULTS.dueDays === 7, automationOf({}));
check('broken or unknown values fall back to the defaults (a reminder can\'t be made automatic)', JSON.stringify(automationOf({ automation: { reorder: 'auto', dues: 'auto', dueDays: 999, upi: 'ask', extra: 1 } })) === JSON.stringify({ reorder: 'auto', dues: 'ask', dueDays: 7, upi: 'auto', watch: WATCH0 }));
check('the form: saved as chosen (a form without the watch rules keeps the defaults)', JSON.stringify(checkAutomationSettings({ reorder: 'auto', dues: 'off', dueDays: '10', upi: 'off' }).patch) === JSON.stringify({ automation: { reorder: 'auto', dues: 'off', dueDays: 10, upi: 'off', watch: WATCH0 } }));
check('the form: a policy the rule can\'t have, or days out of range, are refused with the field', checkAutomationSettings({ reorder: 'ask', dues: 'auto', dueDays: 7, upi: 'auto' }).field === 'dues'
  && checkAutomationSettings({ reorder: 'ask', dues: 'ask', dueDays: 0, upi: 'auto' }).field === 'dueDays' && checkAutomationSettings({ reorder: 'ask', dues: 'ask', dueDays: 91, upi: 'auto' }).error
  && checkAutomationSettings({ reorder: null, dues: 'ask', dueDays: 7, upi: 'auto' }).field === 'reorder');
check('what changed, for the log', JSON.stringify(policyChanges(undefined, { reorder: 'auto', dues: 'ask', dueDays: 10, upi: 'auto' })) === JSON.stringify([{ rule: 'reorder', from: 'ask', to: 'auto' }, { rule: 'dues', from: '7', to: '10' }])
  && policyChanges({ reorder: 'ask' }, {}).length === 0);

// ---------- Watch rules: notice and tell, never act ----------
check('nine watch rules: low stock, money owed, payment mismatches, late orders, unusual sales, expiring stock, receipts not sent, daily closing, GST',
  WATCH_RULES.map((r) => r.key).join() === 'stock,overdue,mismatch,late,unusual,expiry,receipts,dayclose,gst');
check('a watch rule is Off or Notify me — it can\'t do anything by itself or ask to', JSON.stringify(WATCH_POLICIES) === '["off","notify"]' && WATCH_POLICIES.every((p) => WATCH_LABELS[p])
  && WATCH_RULES.every((r) => WATCH_POLICIES.includes(r.dflt) && !r.policies && r.help.length > 30 && r.label));
check('who sees each is declared; late orders and expiring stock need their features; GST only under GST', WATCH_RULES.every((r) => r.perms && r.perms.length)
  && JSON.stringify(watchRule('late').caps) === '["uses_sales_orders","uses_mobile_store"]' && JSON.stringify(watchRule('expiry').caps) === '["uses_expiry","uses_batches"]' && watchRule('gst').tax === 'gst' && !watchRule('stock').tax);
check('their timing: late after 3 days (1–60), remind to close from 21:00 (12–23)', WATCH_DEFAULTS.lateDays === 3 && WATCH_DEFAULTS.closeHour === 21
  && watchRule('late').field.min === 1 && watchRule('late').field.max === 60 && watchRule('dayclose').field.min === 12 && watchRule('dayclose').field.max === 23);
check('the log names every rule, the watch rules and the Agent too', automationRule('stock').label === 'Low stock' && automationRule('gst').label === 'GST preparation' && automationRule('agent').label === 'Hangtag Agent'
  && automationRule('reorder').label && watchRule('reorder') === null && automationRule('nope') === null);
check('broken watch values fall back (no "auto" for a watch rule; times out of range → the default)', JSON.stringify(watchOf({ stock: 'auto', lateDays: 0, closeHour: 99, unusual: 'notify', gst: 'ask' })) === JSON.stringify({ ...WATCH0, unusual: 'notify' })
  && JSON.stringify(watchOf(null)) === JSON.stringify(WATCH0) && JSON.stringify(watchOf('x')) === JSON.stringify(WATCH0));
const form = { reorder: 'ask', dues: 'ask', dueDays: 7, upi: 'auto', w_stock: 'off', w_overdue: 'notify', w_mismatch: 'notify', w_late: 'notify', lateDays: '5', w_unusual: 'notify', w_expiry: 'off', w_receipts: 'notify', w_dayclose: 'notify', closeHour: '20', w_gst: 'notify' };
check('the form\'s watch rules (w_<rule>) are saved as chosen, with their timing', JSON.stringify(checkAutomationSettings(form).patch.automation.watch) === JSON.stringify({ ...WATCH0, stock: 'off', lateDays: 5, unusual: 'notify', expiry: 'off', closeHour: 20 }));
check('...a watch rule that would act, or timing out of range, is refused with its field', checkAutomationSettings({ ...form, w_stock: 'auto' }).field === 'w_stock' && checkAutomationSettings({ ...form, w_gst: undefined }).field === 'w_gst'
  && checkAutomationSettings({ ...form, lateDays: '0' }).field === 'lateDays' && checkAutomationSettings({ ...form, closeHour: '24' }).field === 'closeHour' && checkAutomationSettings({ ...form, closeHour: 'x' }).field === 'closeHour');
check('...without the form\'s watch rules, the shop\'s current ones are kept', JSON.stringify(checkAutomationSettings({ reorder: 'ask', dues: 'ask', dueDays: 7, upi: 'auto', watch: { ...WATCH0, stock: 'off', lateDays: 9 } }).patch.automation.watch) === JSON.stringify({ ...WATCH0, stock: 'off', lateDays: 9 }));
check('watch changes are policy changes in the log', JSON.stringify(policyChanges(undefined, { watch: { stock: 'off', closeHour: 22 } })) === JSON.stringify([{ rule: 'stock', from: 'notify', to: 'off' }, { rule: 'dayclose', from: '21', to: '22' }])
  && policyChanges({ watch: WATCH0 }, {}).length === 0);
const msg = dueReminderText({ shop: 'Aura Threads', customer: 'Riya', amount: 2598.4, bills: ['INV-000002', 'INV-000007'], days: 9 });
check('the reminder: polite, the shop, the amount in rupees, the bills and how long', msg === 'Hello Riya, this is a friendly reminder from Aura Threads: ₹2,598 is due on your account (bills INV-000002, INV-000007), unpaid for 9 days. Please pay at your convenience. Thank you!', msg);
check('...many bills are shortened', /bills A, B, C and more\)/.test(dueReminderText({ shop: 'S', customer: 'R', amount: 1, bills: ['A', 'B', 'C', 'D'], days: 1 })));
const e = logEntry({ id: 'x1', t: 5, rule: 'reorder', action: 'nonsense', key: 'k'.repeat(500), text: 't'.repeat(500), by: 'Owner', dev: 'A', extra: 'dropped' });
check('a log entry: known fields only, bounded, an unknown action recorded as automatic', e.action === 'auto' && e.key.length === 120 && e.text.length === 240 && !('extra' in e)
  && !['why', 'tool', 'before', 'after', 'outcome'].some((k) => k in e));
check('"Noticed": what a watch rule found', LOG_ACTIONS.notified === 'Noticed' && logEntry({ id: 'n', t: 1, rule: 'stock', action: 'notified', key: 'notify:stock:stock:2026-10-06', text: 'x' }).action === 'notified');
const au = logEntry({ id: 'g1', t: 7, rule: 'agent', action: 'approved', key: 'agent:po:p1', text: 'Draft PO-000001 saved', by: 'owner@example.com', dev: 'A', why: 'w'.repeat(300), tool: 'draft_purchase_order'.repeat(3),
  before: 'b'.repeat(400), after: 'Draft PO-000001: 2 lines', outcome: 'o'.repeat(400), junk: 'dropped' });
check('an Agent audit entry: who, when, what, why (the question), the tool, before, after, the approval and the outcome — each bounded',
  au.by === 'owner@example.com' && au.t === 7 && au.action === 'approved' && au.why.length === 200 && au.tool.length === 40 && au.before.length === 160 && au.after === 'Draft PO-000001: 2 lines' && au.outcome.length === 160 && !('junk' in au), au);
check('...empty audit fields are left out', !('before' in logEntry({ id: 'g2', t: 1, rule: 'agent', action: 'dismissed', key: 'k', text: 't', before: '  ', why: null })));
const mk = (id, t, dev) => ({ id, t, rule: 'dues', action: 'approved', key: 'dues:c1', text: 'x', by: 'o', dev });
const merged = mergeLogs([mk('a', 1, 'A'), mk('b', 3, 'A')], [mk('b', 3, 'A'), mk('c', 2, 'B')], [{ id: '', t: 9 }, null]);
check('logs of several devices merge: each entry once, newest first, broken ones dropped', merged.map((x) => x.id).join() === 'b,c,a');
check('the log keeps at most ' + LOG_MAX + ' entries', mergeLogs(Array.from({ length: 150 }, (_, i) => mk('i' + i, i + 1, 'A'))).length === LOG_MAX && mergeLogs(Array.from({ length: 150 }, (_, i) => mk('i' + i, i + 1, 'A')))[0].id === 'i149');

const audit = { id: 'g', t: 1, rule: 'agent', action: 'approved', key: 'agent:po:p1', text: 'saved' };
const month = Array.from({ length: 300 }, (_, i) => ({ id: 'n' + i, t: 10 + i, rule: 'stock', action: 'notified', key: 'notify:stock:stock:' + i, text: 'x' }));
const kept = mergeLogs([audit], month);
check('a month of daily notices (10 a day) never pushes the Agent audit out; notices keep their own ' + NOTICE_MAX + ' newest',
  kept.some((e) => e.id === 'g') && kept.filter((e) => e.action === 'notified').length === NOTICE_MAX && kept[0].id === 'n299');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
