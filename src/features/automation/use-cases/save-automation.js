// Settings → Automation: what each rule does (off / ask me first / automatically) and its timing, and the shop's own rules
// (WHEN … THEN …), kept with the shop's settings (synced like them); each change is written to the automation log.
import { WATCH_LABELS, automationOf, checkAutomationSettings, policyChanges, POLICY_LABELS, automationRule } from '../../../domain/automation/rules.js';
import { CUSTOM_MAX, checkCustomRule, ruleWords, sameRule } from '../../../domain/automation/custom-rules.js';
import { store } from '../../../shared/state/store.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { uid } from '../../../shared/utils/ids.js';
import { can, notAllowedText } from '../../shop/services/access.js';
import { enqueue } from '../../sync/services/outbox.js';
import { liveProducts } from '../../products/services/catalog.js';
import { logAutomation } from '../services/automation.js';

const current = () => automationOf(store.settings);
function keep(patch){ store.settings = Object.assign({}, store.settings, patch); saveSettings(); enqueue({ type: "settings" }); }

/* input: { reorder, dues, dueDays, upi, resend, w_<watch rule>…, lateDays, closeHour, backupDays } → { ok, changed } or
   { error, field }. What the input doesn't name keeps the shop's current setting (the shop's own rules too). */
export function saveAutomationSettings(input){
  if(!can("manage_settings")) return { error: notAllowedText("change the shop's automation") };
  const A = current();
  const r = checkAutomationSettings(Object.assign({ watch: A.watch, current: store.settings.automation, custom: A.custom }, input)); if(r.error) return r;
  const changes = policyChanges(store.settings.automation, r.patch.automation);
  keep(r.patch);
  const word = v => POLICY_LABELS[v] || WATCH_LABELS[v] || v;
  changes.forEach(c => logAutomation({ rule: c.rule, action: "policy", key: `policy:${c.rule}`, text: `${automationRule(c.rule).label}: ${word(c.from)} → ${word(c.to)}` }));
  return { ok: true, changed: changes.length };
}

/* ---------- the shop's own rules ---------- */
const nameOf = rule => rule.product ? ((liveProducts().find(p => p.id === rule.product) || {}).name || "") : "";
function putCustom(list, text){
  const A = current();
  keep({ automation: Object.assign({}, store.settings.automation, { custom: list }) });
  logAutomation({ rule: "custom", action: "policy", key: "policy:custom", text });
  return A;
}
/* A new rule: { trigger, amount | pct | qty | hour, product?, action } → { ok, rule } or { error, field } */
export function addCustomRule(input){
  if(!can("manage_settings")) return { error: notAllowedText("change the shop's automation") };
  const list = current().custom;
  if(list.length >= CUSTOM_MAX) return { error: `Up to ${CUSTOM_MAX} rules. Remove one you don't need first.`, field: "trigger" };
  const r = checkCustomRule({ ...input, id: "r" + uid(), on: true }, { products: liveProducts() }); if(r.error) return r;
  if(list.some(x => sameRule(x, r.rule))) return { error: "That rule is already there.", field: "trigger" };
  putCustom([...list, r.rule], `Your rules: added “${ruleWords(r.rule, nameOf(r.rule))}”`);
  return { ok: true, rule: r.rule };
}
/* Switch a rule on or off → { ok } or { error } */
export function switchCustomRule(id, on){
  if(!can("manage_settings")) return { error: notAllowedText("change the shop's automation") };
  const list = current().custom, rule = list.find(x => x.id === id);
  if(!rule) return { error: "That rule isn't there any more." };
  if((rule.on !== false) === !!on) return { ok: true };
  putCustom(list.map(x => x.id === id ? { ...x, on: !!on } : x), `Your rules: “${ruleWords(rule, nameOf(rule))}” ${on ? "switched on" : "switched off"}`);
  return { ok: true };
}
/* Remove a rule → { ok } or { error } */
export function removeCustomRule(id){
  if(!can("manage_settings")) return { error: notAllowedText("change the shop's automation") };
  const list = current().custom, rule = list.find(x => x.id === id);
  if(!rule) return { error: "That rule isn't there any more." };
  putCustom(list.filter(x => x.id !== id), `Your rules: removed “${ruleWords(rule, nameOf(rule))}”`);
  return { ok: true };
}
