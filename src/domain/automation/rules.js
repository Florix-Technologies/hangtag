// Automation: rules that watch the shop's records and either do a safe thing by themselves or wait for a person's OK.
// Each rule has a policy the shop chooses (Settings → Automation, kept in the shop's settings):
//   off  — the rule does nothing
//   ask  — what it finds waits in Approvals (Home → Needs attention) for a person to approve or dismiss
//   auto — it acts by itself, only where the action is safe to repeat and changes nothing outside the shop: drafting a
//          purchase order (never sent) or asking the payment provider which UPI payments arrived (only the provider's own
//          record marks one verified)
// Nothing is ever sent to a customer or supplier by itself: a reminder opens WhatsApp with the message typed in, and the
// person presses Send. Every automatic action, approval, dismissal and policy change is written to the automation log.

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
export const automationRule = key => AUTOMATION_RULES.find(r => r.key === key) || null;
export const AUTOMATION_DEFAULTS = Object.freeze({ reorder: "ask", dues: "ask", dueDays: 7, upi: "auto" });

const whole = (v, min, max, dflt) => { const n = Math.round(+v); return Number.isFinite(n) && n >= min && n <= max ? n : dflt; };
/* The shop's automation settings, every value valid (unknown or broken values fall back to the defaults) */
export function automationOf(settings){
  const a = Object.assign({}, AUTOMATION_DEFAULTS, settings && settings.automation), out = {};
  AUTOMATION_RULES.forEach(r => { out[r.key] = r.policies.includes(a[r.key]) ? a[r.key] : r.dflt; if(r.field) out[r.field.name] = whole(a[r.field.name], r.field.min, r.field.max, AUTOMATION_DEFAULTS[r.field.name]); });
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
  return { patch: { automation: out } };
}
/* Which policies changed: [{ rule, from, to }] (for the log) */
export function policyChanges(before, after){
  const a = automationOf({ automation: before }), b = automationOf({ automation: after });
  return AUTOMATION_RULES.flatMap(r => [...(a[r.key] !== b[r.key] ? [{ rule: r.key, from: a[r.key], to: b[r.key] }] : []),
    ...(r.field && a[r.field.name] !== b[r.field.name] ? [{ rule: r.key, from: String(a[r.field.name]), to: String(b[r.field.name]) }] : [])]);
}

/* A payment reminder, in the shop's words (rupees in the Indian way) */
export function dueReminderText({ shop, customer, amount, bills, days }){
  const rs = "₹" + Math.round(+amount || 0).toLocaleString("en-IN");
  const which = bills && bills.length ? ` (bill${bills.length > 1 ? "s" : ""} ${bills.slice(0, 3).join(", ")}${bills.length > 3 ? " and more" : ""})` : "";
  return `Hello ${customer || ""}, this is a friendly reminder from ${shop || "our shop"}: ${rs} is due on your account${which}${days ? `, unpaid for ${days} day${days === 1 ? "" : "s"}` : ""}. Please pay at your convenience. Thank you!`.replace(/\s+/g, " ").trim();
}

/* ---------- the automation log ---------- */
export const LOG_MAX = 100;
export const LOG_ACTIONS = Object.freeze({ auto: "Done automatically", approved: "Approved", dismissed: "Dismissed", policy: "Policy changed", failed: "Couldn't be done" });
/* One entry: { id, t, rule, action (auto|approved|dismissed|policy|failed), key (what it was about), text, by, dev } */
export function logEntry(e){
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  return { id: s(e.id, 40), t: +e.t || 0, rule: s(e.rule, 20), action: LOG_ACTIONS[e.action] ? e.action : "auto", key: s(e.key, 120), text: s(e.text, 240), by: s(e.by, 60), dev: s(e.dev, 20) };
}
/* Newest first, each entry once (by id), at most LOG_MAX */
export function mergeLogs(...lists){
  const seen = new Set(), out = [];
  lists.flat().filter(Boolean).map(logEntry).filter(e => e.id && e.t).sort((a, b) => b.t - a.t).forEach(e => { if(!seen.has(e.id)){ seen.add(e.id); out.push(e); } });
  return out.slice(0, LOG_MAX);
}
