// The shop's own automation rules: WHEN something happens THEN tell me / note it / write a reminder for my OK. Triggers are
// read from the shop's records (today's bills, discounts, cancellations and returns, what customers owe, a product's stock,
// the day's sales); an action never changes stock, prices, bills or payments and never sends anything by itself — a
// reminder waits in Approvals and opens WhatsApp with the message typed in. Pure: the facts are gathered by the caller
// (features/automation/services/custom-rules.js) and kept with the shop's settings (automation.custom).
import { inr, stripMoney } from '../../shared/formatting/money.js';

export const CUSTOM_MAX = 12;
export const RULE_ACTIONS = Object.freeze({ notify: "Tell me (Home → Needs attention)", log: "Only note it in Activity", remind: "Write a WhatsApp reminder (I approve it)" });
/* key, label (WHEN …), param (its figure: money | percent | qty | hour), product (the rule names one), actions, perms (who is
   told: any one), say (the rule in words) */
export const TRIGGERS = Object.freeze([
  Object.freeze({ key: "bill_over", label: "A bill is over", param: { name: "amount", kind: "money", min: 1, max: 1e8 }, perms: ["view_reports"], say: r => `A bill over ${inr(r.amount)}` }),
  Object.freeze({ key: "discount_over", label: "A bill's discount is over", param: { name: "pct", kind: "percent", min: 1, max: 100 }, perms: ["view_reports"], say: r => `A discount over ${r.pct}% of a bill` }),
  Object.freeze({ key: "cancelled", label: "A bill is cancelled", perms: ["view_reports"], say: () => "A bill cancelled" }),
  Object.freeze({ key: "return_over", label: "A return is over", param: { name: "amount", kind: "money", min: 1, max: 1e8 }, perms: ["view_reports"], say: r => `A return over ${inr(r.amount)}` }),
  Object.freeze({ key: "owes_over", label: "A customer owes more than", param: { name: "amount", kind: "money", min: 1, max: 1e8 }, perms: ["collect_credit", "view_reports"], actions: ["notify", "log", "remind"],
    say: r => `A customer owing more than ${inr(r.amount)}` }),
  Object.freeze({ key: "stock_at", label: "A product's stock is at or below", param: { name: "qty", kind: "qty", min: 0, max: 1e6 }, product: true, perms: ["view_products", "manage_inventory", "create_purchase", "view_reports"],
    say: (r, name) => `${name || "A product"} at ${r.qty} or below` }),
  Object.freeze({ key: "sales_reach", label: "Today's sales reach", param: { name: "amount", kind: "money", min: 1, max: 1e9 }, perms: ["view_reports"], say: r => `Today's sales reaching ${inr(r.amount)}` }),
  Object.freeze({ key: "no_sale_by", label: "No sale yet by", param: { name: "hour", kind: "hour", min: 7, max: 23 }, perms: ["view_reports", "create_sale"], say: r => `No sale by ${r.hour}:00` }),
]);
export const triggerOf = key => TRIGGERS.find(t => t.key === key) || null;
export const actionsOf = t => (t && t.actions) || ["notify", "log"];
/* a typed figure without the shop's currency mark, grouping commas and spaces ("1,000", the symbol before it) */
const num = v => { const s = stripMoney(v); const n = s === "" ? NaN : +s; return Number.isFinite(n) ? n : NaN; };

/* One rule from a form (or the settings) → { rule } or { error, field }. A rule: { id, trigger, amount | pct | qty | hour,
   product?, action, on } */
export function checkCustomRule(input, { products = null } = {}){
  const t = triggerOf(input && input.trigger);
  if(!t) return { error: "Choose when the rule acts.", field: "trigger" };
  const rule = { id: String(input.id || "").slice(0, 40), trigger: t.key };
  if(t.param){
    const P = t.param, raw = num(input[P.name]), v = P.kind === "hour" ? Math.round(raw) : Math.round(raw * 100) / 100;
    if(!Number.isFinite(raw) || v < P.min || v > P.max) return { error: P.kind === "hour" ? `The hour: from ${P.min} to ${P.max} (24 h).` : P.kind === "percent" ? "The discount: from 1 to 100 %." : P.kind === "qty" ? "The stock level: 0 or more." : "Enter the amount in rupees.", field: P.name };
    rule[P.name] = v;
  }
  if(t.product){
    const pid = String(input.product || "");
    if(!pid || (products && !products.some(p => p.id === pid))) return { error: "Choose the product.", field: "product" };
    rule.product = pid;
  }
  const a = String(input.action || "notify");
  if(!actionsOf(t).includes(a)) return { error: "Choose what the rule does.", field: "action" };
  rule.action = a; rule.on = input.on !== false;
  return { rule };
}
/* The shop's rules as saved, every one valid, at most CUSTOM_MAX */
export function customRulesOf(list){
  return (Array.isArray(list) ? list : []).map(x => checkCustomRule(x || {})).filter(r => r.rule && r.rule.id).map(r => r.rule).slice(0, CUSTOM_MAX);
}
/* The rule in words: "A bill over ₹10,000 → Tell me" */
export function ruleWords(rule, productName){
  const t = triggerOf(rule.trigger); if(!t) return "";
  return `${t.say(rule, productName)} → ${({ notify: "Tell me", log: "Note it", remind: "Write a reminder" })[rule.action] || rule.action}`;
}
/* Is this the same rule as another (the same trigger, figure, product and action)? */
export const sameRule = (a, b) => a.trigger === b.trigger && a.action === b.action && (a.product || "") === (b.product || "")
  && ["amount", "pct", "qty", "hour"].every(k => (a[k] == null ? null : +a[k]) === (b[k] == null ? null : +b[k]));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const filter = o => JSON.stringify(o);
/* What one rule finds in the facts → [{ subject, tone, title, sub, attr, cta, act? }]. Facts:
   { hour, bills: [{ id, no, total, sub, disc, void, cust: { name } }] (today's), returns: [{ id, no, value, sale, saleNo }] (today's),
     owed: [{ id, name, phone, amount, bills: [no], days }], product: { id, name, qty, unit } | null, sales (today's total), shop } */
export function evaluateCustomRule(rule, F, { reminder = null } = {}){
  const t = triggerOf(rule.trigger); if(!t || rule.on === false) return [];
  const live = (F.bills || []).filter(s => !s.void), today = { key: "today", label: "today" };
  const billsAttr = (list, extra) => list.length === 1 ? `data-billview="${list[0].id}"` : `data-billsearch='${filter({ period: { ...today, from: F.day, to: F.day }, ...extra })}'`;
  switch(rule.trigger){
    case "bill_over": {
      const hit = live.filter(s => +s.total > rule.amount).sort((a, b) => b.total - a.total);
      if(!hit.length) return [];
      return [{ subject: String(hit.length), tone: "info", title: `${plural(hit.length, "bill")} over ${inr(rule.amount)} today`, sub: `The biggest ${hit[0].no || "bill"} · ${inr(hit[0].total)}${hit[0].cust && hit[0].cust.name ? " · " + hit[0].cust.name : ""}`,
        attr: billsAttr(hit, { amount: { op: "gt", value: rule.amount } }), cta: "Open" }];
    }
    case "discount_over": {
      const pct = s => +s.sub > 0 ? (+s.disc || 0) / +s.sub * 100 : 0;
      const hit = live.filter(s => pct(s) > rule.pct).sort((a, b) => pct(b) - pct(a));
      if(!hit.length) return [];
      return [{ subject: String(hit.length), tone: "warn", title: `${plural(hit.length, "bill")} with a discount over ${rule.pct}%`, sub: `The most ${hit[0].no || "a bill"} · ${Math.round(pct(hit[0]))}% (${inr(hit[0].disc)} off ${inr(hit[0].sub)})`,
        attr: hit.length === 1 ? `data-billview="${hit[0].id}"` : `data-billsearch='${filter({ period: { ...today, from: F.day, to: F.day } })}'`, cta: "Check" }];
    }
    case "cancelled": {
      const hit = (F.bills || []).filter(s => s.void);
      if(!hit.length) return [];
      return [{ subject: String(hit.length), tone: "warn", title: `${plural(hit.length, "bill")} cancelled today`, sub: hit.slice(0, 3).map(s => `${s.no || "a bill"} (${inr(s.total)})`).join(", "),
        attr: billsAttr(hit, { status: "cancelled" }), cta: "Check" }];
    }
    case "return_over": {
      const hit = (F.returns || []).filter(r => +r.value > rule.amount).sort((a, b) => b.value - a.value);
      if(!hit.length) return [];
      return [{ subject: String(hit.length), tone: "info", title: `${plural(hit.length, "return")} over ${inr(rule.amount)} today`, sub: `The biggest ${inr(hit[0].value)} on ${hit[0].saleNo || "a bill"}`,
        attr: `data-billview="${hit[0].sale}"`, cta: "Open" }];
    }
    case "owes_over":
      return (F.owed || []).filter(c => +c.amount > rule.amount).sort((a, b) => b.amount - a.amount).map(c => ({ subject: c.id, tone: "warn",
        title: `${c.name || "A customer"} owes ${inr(c.amount)}`, sub: `Over your limit of ${inr(rule.amount)} · ${plural((c.bills || []).length || 1, "bill")} on account`,
        attr: `data-custhist="${c.id}"`, cta: "Collect",
        act: rule.action === "remind" && reminder ? { kind: "remind", customerId: c.id, name: c.name || "", phone: c.phone || "", amount: c.amount, text: reminder(c) } : null }));
    case "stock_at": {
      const p = F.product; if(!p || +p.qty > rule.qty) return [];
      return [{ subject: `${p.id}:${p.qty}`, tone: +p.qty <= 0 ? "bad" : "warn", title: +p.qty <= 0 ? `${p.name} sold out` : `${p.name}: ${p.qty}${p.unit ? " " + p.unit : ""} left`,
        sub: `Your rule: ${rule.qty} or below`, attr: `data-commandproduct="${p.id}"`, cta: "Restock" }];
    }
    case "sales_reach":
      return +F.sales >= rule.amount ? [{ subject: "reached", tone: "info", title: `Today's sales reached ${inr(rule.amount)}`, sub: `${inr(F.sales)} from ${plural(live.length, "bill")}`, attr: 'data-tab="report"', cta: "See sales" }] : [];
    case "no_sale_by":
      return F.hour >= rule.hour && !live.length ? [{ subject: "none", tone: "warn", title: "No sale yet today", sub: `It's past ${rule.hour}:00`, attr: 'data-tab="sell"', cta: "Sell" }] : [];
    default: return [];
  }
}
