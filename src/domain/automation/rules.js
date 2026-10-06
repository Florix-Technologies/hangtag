// Automation: rules that watch the shop's records and either do a safe thing by themselves or wait for a person's OK.
// Each rule has a policy the shop chooses (Settings → Automation, kept in the shop's settings):
//   off  — the rule does nothing
//   ask  — what it finds waits in Approvals (Home → Needs attention) for a person to approve or dismiss
//   auto — it acts by itself, only where the action is safe to repeat and changes nothing outside the shop: drafting a
//          purchase order (never sent) or asking the payment provider which UPI payments arrived (only the provider's own
//          record marks one verified)
// Nothing is ever sent to a customer or supplier by itself: a reminder opens WhatsApp with the message typed in, and the
// person presses Send. Every automatic action, approval, dismissal and policy change is written to the automation log.
// Watch rules (WATCH_RULES) only notice and tell: Off or Notify. What they find is Home → Needs attention (one place,
// nothing shown twice) and, once a day per rule, a line in the log. They never change stock, prices, bills or payments.
import { inr } from '../../shared/formatting/money.js';

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
]);
const ALL_RULES = [...AUTOMATION_RULES, ...WATCH_RULES, Object.freeze({ key: "agent", label: "Hangtag Agent", policies: [] })];
export const automationRule = key => ALL_RULES.find(r => r.key === key) || null;
export const watchRule = key => WATCH_RULES.find(r => r.key === key) || null;
export const AUTOMATION_DEFAULTS = Object.freeze({ reorder: "ask", dues: "ask", dueDays: 7, upi: "auto" });
export const WATCH_DEFAULTS = Object.freeze({ ...Object.fromEntries(WATCH_RULES.map(r => [r.key, r.dflt])), lateDays: 3, closeHour: 21 });

const whole = (v, min, max, dflt) => { const n = Math.round(+v); return Number.isFinite(n) && n >= min && n <= max ? n : dflt; };
/* The shop's automation settings, every value valid (unknown or broken values fall back to the defaults) */
export function automationOf(settings){
  const a = Object.assign({}, AUTOMATION_DEFAULTS, settings && settings.automation), out = {};
  AUTOMATION_RULES.forEach(r => { out[r.key] = r.policies.includes(a[r.key]) ? a[r.key] : r.dflt; if(r.field) out[r.field.name] = whole(a[r.field.name], r.field.min, r.field.max, AUTOMATION_DEFAULTS[r.field.name]); });
  out.watch = watchOf(a.watch);
  return out;
}
/* The watch rules' settings, every value valid */
export function watchOf(watch){
  const w = Object.assign({}, WATCH_DEFAULTS, watch && typeof watch === "object" ? watch : {}), out = {};
  WATCH_RULES.forEach(r => { out[r.key] = WATCH_POLICIES.includes(w[r.key]) ? w[r.key] : r.dflt; if(r.field) out[r.field.name] = whole(w[r.field.name], r.field.min, r.field.max, WATCH_DEFAULTS[r.field.name]); });
  return out;
}
/* A form's values → { patch: { automation } } or { error, field } */
export function checkAutomationSettings(input){
  const out = {};
  for(const r of AUTOMATION_RULES){
    const p = input && input[r.key];
    if(!r.policies.includes(p)) return { error: `Choose what “${r.label}” does.`, field: r.key };
    out[r.key] = p;
    if(r.field){
      const n = Math.round(+input[r.field.name]);
      if(!Number.isFinite(n) || n < r.field.min || n > r.field.max) return { error: `${r.label}: from ${r.field.min} to ${r.field.max} ${r.field.unit.split(" ")[0]}.`, field: r.field.name };
      out[r.field.name] = n;
    }
  }
  // watch rules: the form names them w_<key> (and their fields by name); without them, the given watch object or the defaults
  const watch = {}, given = !!input && WATCH_RULES.some(r => input["w_" + r.key] != null), prev = (input && input.watch) || {};
  for(const r of WATCH_RULES){
    const p = given ? input["w_" + r.key] : (prev[r.key] || r.dflt);
    if(!WATCH_POLICIES.includes(p)) return { error: `Choose what “${r.label}” does.`, field: "w_" + r.key };
    watch[r.key] = p;
    if(r.field){
      const raw = given ? input[r.field.name] : (prev[r.field.name] != null ? prev[r.field.name] : WATCH_DEFAULTS[r.field.name]), n = Math.round(+raw);
      if(!Number.isFinite(n) || n < r.field.min || n > r.field.max) return { error: `${r.label}: from ${r.field.min} to ${r.field.max}.`, field: r.field.name };
      watch[r.field.name] = n;
    }
  }
  out.watch = watch;
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
  notified: "Noticed" });
/* One entry: { id, t, rule, action (auto|approved|dismissed|policy|failed|notified), key (what it was about), text, by, dev }
   and, for the Hangtag Agent's actions (an audit): why (the question asked), tool, before, after, outcome — who is "by",
   when is "t", the approval is the action ("approved": the person tapped to save it; "dismissed": they chose not to). */
const AUDIT_FIELDS = Object.freeze({ why: 200, tool: 40, before: 160, after: 160, outcome: 160 });
export function logEntry(e){
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  const out = { id: s(e.id, 40), t: +e.t || 0, rule: s(e.rule, 20), action: LOG_ACTIONS[e.action] ? e.action : "auto", key: s(e.key, 120), text: s(e.text, 240), by: s(e.by, 60), dev: s(e.dev, 20) };
  Object.entries(AUDIT_FIELDS).forEach(([k, n]) => { if(e[k] != null && String(e[k]).trim()) out[k] = s(e[k], n); });
  return out;
}
/* Newest first, each entry once (by id), at most LOG_MAX */
export function mergeLogs(...lists){
  const seen = new Set(), out = [];
  lists.flat().filter(Boolean).map(logEntry).filter(e => e.id && e.t).sort((a, b) => b.t - a.t).forEach(e => { if(!seen.has(e.id)){ seen.add(e.id); out.push(e); } });
  return out.slice(0, LOG_MAX);
}
