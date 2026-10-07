// Automation: rules that watch the shop's records and either do a safe thing by themselves or wait for a person's OK.
// Each rule has a policy the shop chooses (Settings → Automation, kept in the shop's settings):
//   off  — the rule does nothing
//   ask  — what it finds waits in Approvals (Home → Needs attention) for a person to approve or dismiss
//   auto — it acts by itself, only where the action is safe to repeat and changes nothing outside the shop: drafting a
//          purchase order (never sent) or asking the payment provider which UPI payments arrived (only the provider's own
//          record marks one verified)
// Nothing is ever sent to a customer or supplier by itself: a reminder opens WhatsApp with the message typed in, and the
// person presses Send — the one exception is a receipt the shop already sends by itself that failed for a passing reason
// (the provider, the internet): "Send failed receipts again" tries it once a day. Every automatic action, approval,
// dismissal and policy change is written to the automation log. The shop's own rules (custom-rules.js: WHEN … THEN tell me /
// note it / write a reminder) are kept here too (automation.custom).
// Watch rules (WATCH_RULES) only notice and tell: Off or Notify. What they find is Home → Needs attention (one place,
// nothing shown twice) and, once a day per rule, a line in the log. They never change stock, prices, bills or payments.
import { inr } from '../../shared/formatting/money.js';
import { customRulesOf } from './custom-rules.js';

export const POLICY_LABELS = Object.freeze({ off: "Off", ask: "Ask me first", auto: "Automatically" });
/* key, label, help, policies (the ones the rule may have), dflt, perms (who may act on it: any one), cap (a feature the shop
   must use), and the setting that tunes it (field) */
export const AUTOMATION_RULES = Object.freeze([
  Object.freeze({ key: "reorder", label: "Reorder drafts", policies: ["off", "ask", "auto"], dflt: "ask", perms: ["create_purchase"], cap: "uses_purchase_orders",
    help: "When Smart reorder says to reorder products you have bought from a supplier: a draft purchase order for that supplier, one at a time. It is never sent by itself." }),
  Object.freeze({ key: "dues", label: "Payment reminders", policies: ["off", "ask"], dflt: "ask", perms: ["collect_credit", "view_reports"],
    field: { name: "dueDays", label: "Remind after", unit: "days unpaid", min: 1, max: 90 },
    help: "When a customer's bill on account stays unpaid: a WhatsApp reminder, written for you. You press Send in WhatsApp." }),
  Object.freeze({ key: "upi", label: "Check UPI with the provider", policies: ["off", "auto"], dflt: "auto", perms: ["create_sale"],
    help: "UPI payments checked by hand are matched with your payment provider's records whenever this device is online. Only the provider's own record marks a payment verified." }),
  Object.freeze({ key: "resend", label: "Send failed receipts again", policies: ["off", "auto"], dflt: "auto", perms: ["create_sale"],
    help: "A receipt the shop sends by itself that failed because of the provider or the internet (not a missing number or email) is tried again once a day while the bill is recent. A wrong or missing contact needs a person." }),
]);
/* Watch rules: notice and tell (Home → Needs attention, and the log once a day). key, label, help, dflt (off | notify), perms
   (who sees it: any one), caps (the shop uses any one of these features), tax (only under this tax regime), field (its tuning) */
export const WATCH_POLICIES = Object.freeze(["off", "notify"]);
export const WATCH_LABELS = Object.freeze({ off: "Off", notify: "Notify me" });
export const WATCH_RULES = Object.freeze([
  Object.freeze({ key: "stock", label: "Low stock", dflt: "notify", perms: ["view_products", "manage_inventory", "create_purchase", "manage_products", "view_reports"],
    help: "When products run low or sell out (by each product's low-stock level), with Smart reorder to restock." }),
  Object.freeze({ key: "overdue", label: "Money customers owe", dflt: "notify", perms: ["collect_credit", "view_reports"],
    help: "What customers owe on their account, and who owes the most. Reminders are under Act → Payment reminders." }),
  Object.freeze({ key: "mismatch", label: "Payment mismatches", dflt: "notify", perms: ["view_reports"],
    help: "UPI payments only checked by hand, and money received that isn't on any bill — to verify, refund or allocate." }),
  Object.freeze({ key: "late", label: "Late orders", dflt: "notify", perms: ["create_sale", "create_order"], caps: ["uses_sales_orders", "uses_mobile_store"],
    field: Object.freeze({ name: "lateDays", label: "Late after", unit: "days open", min: 1, max: 60 }),
    help: "Sales orders (including your online store's) still not delivered after the days you set." }),
  Object.freeze({ key: "unusual", label: "Unusual sales", dflt: "off", perms: ["view_reports"],
    help: "Today's sales far below (under half) or above (over double) the usual for this weekday by this hour — only with four weeks of history." }),
  Object.freeze({ key: "expiry", label: "Expiring stock", dflt: "notify", perms: ["manage_inventory", "create_purchase", "view_reports"], caps: ["uses_expiry", "uses_batches"],
    help: "Batches that have expired or expire within your expiry warning period (Products & Inventory)." }),
  Object.freeze({ key: "receipts", label: "Receipts not sent", dflt: "notify", perms: ["create_sale"],
    help: "Receipts this device tried to send by email, WhatsApp or SMS and couldn't." }),
  Object.freeze({ key: "dayclose", label: "Daily closing", dflt: "notify", perms: ["create_sale"],
    field: Object.freeze({ name: "closeHour", label: "Remind from", unit: "o'clock (24 h)", min: 12, max: 23 }),
    help: "From the hour you set, if there were sales today and the day's cash isn't closed yet." }),
  Object.freeze({ key: "gst", label: "GST preparation", dflt: "notify", perms: ["view_reports"], tax: "gst",
    help: "From the 1st to the 11th of each month (GSTR-1 is due on the 11th): prepare last month's GST from Reports." }),
  Object.freeze({ key: "briefing", label: "Morning briefing", dflt: "notify", perms: ["view_reports"],
    help: "Each morning on Home: yesterday against a usual day, the one thing to do first, stock to act on and money owed. Never sent anywhere." }),
  Object.freeze({ key: "backup", label: "Backup", dflt: "notify", perms: ["manage_settings"],
    field: Object.freeze({ name: "backupDays", label: "Backup file after", unit: "days without one on this device", min: 7, max: 90 }),
    help: "Changes on this device that the cloud refused or that haven't reached it for six hours, and no backup file downloaded on this device for the days you set." }),
]);
const ALL_RULES = [...AUTOMATION_RULES, ...WATCH_RULES, Object.freeze({ key: "agent", label: "Hangtag Agent", policies: [] }), Object.freeze({ key: "custom", label: "Your rules", policies: [] })];
export const automationRule = key => ALL_RULES.find(r => r.key === key) || null;
export const watchRule = key => WATCH_RULES.find(r => r.key === key) || null;
export const AUTOMATION_DEFAULTS = Object.freeze({ reorder: "ask", dues: "ask", dueDays: 7, upi: "auto", resend: "auto" });
export const WATCH_DEFAULTS = Object.freeze({ ...Object.fromEntries(WATCH_RULES.map(r => [r.key, r.dflt])), lateDays: 3, closeHour: 21, backupDays: 30 });
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

const whole = (v, min, max, dflt) => { const n = Math.round(+v); return Number.isFinite(n) && n >= min && n <= max ? n : dflt; };
/* The shop's automation settings, every value valid (unknown or broken values fall back to the defaults) */
export function automationOf(settings){
  const a = Object.assign({}, AUTOMATION_DEFAULTS, settings && settings.automation), out = {};
  AUTOMATION_RULES.forEach(r => { out[r.key] = r.policies.includes(a[r.key]) ? a[r.key] : r.dflt; if(r.field) out[r.field.name] = whole(a[r.field.name], r.field.min, r.field.max, AUTOMATION_DEFAULTS[r.field.name]); });
  out.watch = watchOf(a.watch);
  out.custom = customRulesOf(a.custom);
  return out;
}
/* The watch rules' settings, every value valid */
export function watchOf(watch){
  const w = Object.assign({}, WATCH_DEFAULTS, watch && typeof watch === "object" ? watch : {}), out = {};
  WATCH_RULES.forEach(r => { out[r.key] = WATCH_POLICIES.includes(w[r.key]) ? w[r.key] : r.dflt; if(r.field) out[r.field.name] = whole(w[r.field.name], r.field.min, r.field.max, WATCH_DEFAULTS[r.field.name]); });
  return out;
}
/* A form's values → { patch: { automation } } or { error, field }. A rule (or timing) the input doesn't name at all keeps its
   current value (input.current, else the default); one named without a valid value is refused. The shop's own rules
   (input.custom) are carried as they are, checked. */
export function checkAutomationSettings(input){
  const out = {}, cur = automationOf({ automation: input && input.current });
  for(const r of AUTOMATION_RULES){
    const p = has(input, r.key) ? input[r.key] : cur[r.key];
    if(!r.policies.includes(p)) return { error: `Choose what “${r.label}” does.`, field: r.key };
    out[r.key] = p;
    if(r.field){
      const n = Math.round(+(has(input, r.field.name) ? input[r.field.name] : cur[r.field.name]));
      if(!Number.isFinite(n) || n < r.field.min || n > r.field.max) return { error: `${r.label}: from ${r.field.min} to ${r.field.max} ${r.field.unit.split(" ")[0]}.`, field: r.field.name };
      out[r.field.name] = n;
    }
  }
  // watch rules: the form names them w_<key> (and their fields by name); without them, the given watch object or the defaults
  const watch = {}, given = !!input && WATCH_RULES.some(r => input["w_" + r.key] != null), prev = (input && input.watch) || {};
  for(const r of WATCH_RULES){
    const p = given && has(input, "w_" + r.key) ? input["w_" + r.key] : (prev[r.key] || r.dflt);
    if(!WATCH_POLICIES.includes(p)) return { error: `Choose what “${r.label}” does.`, field: "w_" + r.key };
    watch[r.key] = p;
    if(r.field){
      const raw = given && has(input, r.field.name) ? input[r.field.name] : (prev[r.field.name] != null ? prev[r.field.name] : WATCH_DEFAULTS[r.field.name]), n = Math.round(+raw);
      if(!Number.isFinite(n) || n < r.field.min || n > r.field.max) return { error: `${r.label}: from ${r.field.min} to ${r.field.max}.`, field: r.field.name };
      watch[r.field.name] = n;
    }
  }
  out.watch = watch;
  out.custom = customRulesOf(has(input, "custom") ? input.custom : cur.custom);
  return { patch: { automation: out } };
}
/* Which policies changed: [{ rule, from, to }] (for the log), action rules first, then watch rules */
export function policyChanges(before, after){
  const a = automationOf({ automation: before }), b = automationOf({ automation: after });
  return [...AUTOMATION_RULES.flatMap(r => [...(a[r.key] !== b[r.key] ? [{ rule: r.key, from: a[r.key], to: b[r.key] }] : []),
    ...(r.field && a[r.field.name] !== b[r.field.name] ? [{ rule: r.key, from: String(a[r.field.name]), to: String(b[r.field.name]) }] : [])]),
    ...WATCH_RULES.flatMap(r => [...(a.watch[r.key] !== b.watch[r.key] ? [{ rule: r.key, from: a.watch[r.key], to: b.watch[r.key] }] : []),
    ...(r.field && a.watch[r.field.name] !== b.watch[r.field.name] ? [{ rule: r.key, from: String(a.watch[r.field.name]), to: String(b.watch[r.field.name]) }] : [])])];
}

/* A payment reminder, in the shop's words (rupees in the Indian way) */
export function dueReminderText({ shop, customer, amount, bills, days }){
  const rs = inr(amount);
  const which = bills && bills.length ? ` (bill${bills.length > 1 ? "s" : ""} ${bills.slice(0, 3).join(", ")}${bills.length > 3 ? " and more" : ""})` : "";
  return `Hello ${customer || ""}, this is a friendly reminder from ${shop || "our shop"}: ${rs} is due on your account${which}${days ? `, unpaid for ${days} day${days === 1 ? "" : "s"}` : ""}. Please pay at your convenience. Thank you!`.replace(/\s+/g, " ").trim();
}

/* ---------- the automation log ---------- */
export const LOG_MAX = 100;
export const LOG_ACTIONS = Object.freeze({ auto: "Done automatically", approved: "Approved", dismissed: "Dismissed", policy: "Policy changed", failed: "Couldn't be done",
  notified: "Noticed", answered: "Answered by the Agent" });
/* One entry: { id, t, rule, action (auto|approved|dismissed|policy|failed|notified|answered), key (what it was about), text,
   by, dev } and its audit (domain/agent/governance.js: every Agent step and every automatic or approved action): why (the
   question asked, or the rule), tool, before, after, approvedBy (the person who tapped, or the setting that allows it),
   outcome — who is "by", when is "t", what is "text". */
const AUDIT_FIELDS = Object.freeze({ why: 200, tool: 120, before: 160, after: 160, approvedBy: 80, outcome: 160 });
export function logEntry(e){
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  const out = { id: s(e.id, 40), t: +e.t || 0, rule: s(e.rule, 20), action: LOG_ACTIONS[e.action] ? e.action : "auto", key: s(e.key, 120), text: s(e.text, 240), by: s(e.by, 60), dev: s(e.dev, 20) };
  Object.entries(AUDIT_FIELDS).forEach(([k, n]) => { if(e[k] != null && String(e[k]).trim()) out[k] = s(e[k], n); });
  return out;
}
/* Newest first, each entry once (by id), at most LOG_MAX */
export const NOTICE_MAX = 60;   // "Noticed" lines (watch rules, once a day each) are kept apart: they never push out the rest
export const ANSWER_MAX = 60;   // so are the Agent's answers (questions asked often never push out an approval or a change)
export function mergeLogs(...lists){
  const seen = new Set(), out = []; let kept = 0, notices = 0, answers = 0;
  lists.flat().filter(Boolean).map(logEntry).filter(e => e.id && e.t).sort((a, b) => b.t - a.t).forEach(e => {
    if(seen.has(e.id)) return; seen.add(e.id);
    if(e.action === "notified" ? notices++ < NOTICE_MAX : e.action === "answered" ? answers++ < ANSWER_MAX : kept++ < LOG_MAX) out.push(e);
  });
  return out;
}
