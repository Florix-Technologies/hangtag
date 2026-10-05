// Automation rules (src/domain/automation/rules.js): the policies each rule may have (nothing is ever sent by itself),
// the shop's settings with safe defaults, the form check, what changed (for the log), the reminder text, and the log
// (bounded, newest first, each entry once across devices). Run: npm run test:unit
import { AUTOMATION_DEFAULTS, AUTOMATION_RULES, LOG_MAX, POLICY_LABELS, automationOf, automationRule, checkAutomationSettings, dueReminderText, logEntry, mergeLogs, policyChanges } from '../../src/domain/automation/rules.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); } };

check('three rules: reorder drafts, payment reminders, UPI checks', AUTOMATION_RULES.map((r) => r.key).join() === 'reorder,dues,upi');
check('a payment reminder is never sent by itself (off or ask only); UPI is checked or not (never asks)', JSON.stringify(automationRule('dues').policies) === '["off","ask"]'
  && JSON.stringify(automationRule('upi').policies) === '["off","auto"]' && automationRule('reorder').policies.includes('auto'));
check('reorder drafts need purchase orders on and someone who may make them', automationRule('reorder').cap === 'uses_purchase_orders' && automationRule('reorder').perms.includes('create_purchase'));
check('every policy has a label; every rule explains itself', AUTOMATION_RULES.every((r) => r.policies.every((p) => POLICY_LABELS[p]) && r.help.length > 30));
check('defaults: ask before drafting or reminding, check UPI automatically, reminders after 7 days', JSON.stringify(automationOf({})) === JSON.stringify({ reorder: 'ask', dues: 'ask', dueDays: 7, upi: 'auto' }) && AUTOMATION_DEFAULTS.dueDays === 7);
check('broken or unknown values fall back to the defaults (a reminder can\'t be made automatic)', JSON.stringify(automationOf({ automation: { reorder: 'auto', dues: 'auto', dueDays: 999, upi: 'ask', extra: 1 } })) === JSON.stringify({ reorder: 'auto', dues: 'ask', dueDays: 7, upi: 'auto' }));
check('the form: saved as chosen', JSON.stringify(checkAutomationSettings({ reorder: 'auto', dues: 'off', dueDays: '10', upi: 'off' }).patch) === JSON.stringify({ automation: { reorder: 'auto', dues: 'off', dueDays: 10, upi: 'off' } }));
check('the form: a policy the rule can\'t have, or days out of range, are refused with the field', checkAutomationSettings({ reorder: 'ask', dues: 'auto', dueDays: 7, upi: 'auto' }).field === 'dues'
  && checkAutomationSettings({ reorder: 'ask', dues: 'ask', dueDays: 0, upi: 'auto' }).field === 'dueDays' && checkAutomationSettings({ reorder: 'ask', dues: 'ask', dueDays: 91, upi: 'auto' }).error
  && checkAutomationSettings({ reorder: null, dues: 'ask', dueDays: 7, upi: 'auto' }).field === 'reorder');
check('what changed, for the log', JSON.stringify(policyChanges(undefined, { reorder: 'auto', dues: 'ask', dueDays: 10, upi: 'auto' })) === JSON.stringify([{ rule: 'reorder', from: 'ask', to: 'auto' }, { rule: 'dues', from: '7', to: '10' }])
  && policyChanges({ reorder: 'ask' }, {}).length === 0);
const msg = dueReminderText({ shop: 'Aura Threads', customer: 'Riya', amount: 2598.4, bills: ['INV-000002', 'INV-000007'], days: 9 });
check('the reminder: polite, the shop, the amount in rupees, the bills and how long', msg === 'Hello Riya, this is a friendly reminder from Aura Threads: ₹2,598 is due on your account (bills INV-000002, INV-000007), unpaid for 9 days. Please pay at your convenience. Thank you!', msg);
check('...many bills are shortened', /bills A, B, C and more\)/.test(dueReminderText({ shop: 'S', customer: 'R', amount: 1, bills: ['A', 'B', 'C', 'D'], days: 1 })));
const e = logEntry({ id: 'x1', t: 5, rule: 'reorder', action: 'nonsense', key: 'k'.repeat(500), text: 't'.repeat(500), by: 'Owner', dev: 'A', extra: 'dropped' });
check('a log entry: known fields only, bounded, an unknown action recorded as automatic', e.action === 'auto' && e.key.length === 120 && e.text.length === 240 && !('extra' in e));
const mk = (id, t, dev) => ({ id, t, rule: 'dues', action: 'approved', key: 'dues:c1', text: 'x', by: 'o', dev });
const merged = mergeLogs([mk('a', 1, 'A'), mk('b', 3, 'A')], [mk('b', 3, 'A'), mk('c', 2, 'B')], [{ id: '', t: 9 }, null]);
check('logs of several devices merge: each entry once, newest first, broken ones dropped', merged.map((x) => x.id).join() === 'b,c,a');
check('the log keeps at most ' + LOG_MAX + ' entries', mergeLogs(Array.from({ length: 150 }, (_, i) => mk('i' + i, i + 1, 'A'))).length === LOG_MAX && mergeLogs(Array.from({ length: 150 }, (_, i) => mk('i' + i, i + 1, 'A')))[0].id === 'i149');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
