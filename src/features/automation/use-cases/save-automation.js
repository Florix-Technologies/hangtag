// Settings → Automation: what each rule does (off / ask me first / automatically) and its timing, kept with the shop's
// settings (synced like them); each change is written to the automation log.
import { checkAutomationSettings, policyChanges, POLICY_LABELS, automationRule } from '../../../domain/automation/rules.js';
import { store } from '../../../shared/state/store.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { can, notAllowedText } from '../../shop/services/access.js';
import { enqueue } from '../../sync/services/outbox.js';
import { logAutomation } from '../services/automation.js';

/* input: { reorder, dues, dueDays, upi } → { ok, changed } or { error, field } */
export function saveAutomationSettings(input){
  if(!can("manage_settings")) return { error: notAllowedText("change the shop's automation") };
  const r = checkAutomationSettings(input); if(r.error) return r;
  const changes = policyChanges(store.settings.automation, r.patch.automation);
  store.settings = Object.assign({}, store.settings, r.patch);
  saveSettings(); enqueue({ type: "settings" });
  const word = v => POLICY_LABELS[v] || v;
  changes.forEach(c => logAutomation({ rule: c.rule, action: "policy", key: `policy:${c.rule}`, text: `${automationRule(c.rule).label}: ${word(c.from)} → ${word(c.to)}` }));
  return { ok: true, changed: changes.length };
}
