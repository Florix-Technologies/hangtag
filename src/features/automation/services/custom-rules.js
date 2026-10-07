// The shop's own rules (domain/automation/custom-rules.js) on today's records: the facts each trigger reads, from the
// calculations the app uses everywhere (the day's bills and returns, what each customer owes, a product's stock), and what
// each rule finds now — for Home → Needs attention ("Tell me"), Activity ("Note it") and Approvals ("Write a reminder").
// Only the rules this person may see (their trigger's permissions) are worked out. Read-only: nothing here changes a record.
import { store } from '../../../shared/state/store.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { customRulesOf, evaluateCustomRule, triggerOf } from '../../../domain/automation/custom-rules.js';
import { dueReminderText } from '../../../domain/automation/rules.js';
import { D } from '../../inventory/services/ledger.js';
import { stockOf } from '../../inventory/services/stock.js';
import { periodData } from '../../reports/services/report-data.js';
import { openBillBalances } from '../../customers/services/customer-account.js';
import { createReadOnlyBusinessQuery } from '../../assistant/services/business-query.js';
import { liveProducts } from '../../products/services/catalog.js';
import { roundQty, unitOf } from '../../../domain/catalog/units.js';
import { can } from '../../shop/services/access.js';
import { logger } from '../../../shared/logging/logger.js';

const DAY = 864e5;
/* The shop's rules, as saved (Settings → Automation → Your rules) */
export const customRules = () => customRulesOf(store.settings && store.settings.automation && store.settings.automation.custom);
export const customUsable = rule => { const t = triggerOf(rule.trigger); return !!t && t.perms.some(p => can(p)); };
/* A product's stock: all its sizes and colours together, in its unit */
export function productStock(pid){
  const p = liveProducts().find(x => x.id === pid); if(!p) return null;
  const u = unitOf(p.unit);
  return { id: p.id, name: p.name, qty: roundQty((p.variants || []).reduce((a, v) => a + stockOf(v.id), 0)), unit: u && u.id !== "pcs" ? u.sym : "" };
}

function facts(now, rules){
  const k = dayKey(now), need = t => rules.some(r => r.trigger === t), F = { day: k, hour: new Date(now).getHours(), bills: [], returns: [], owed: [], sales: 0 };
  if(rules.some(r => ["bill_over", "discount_over", "cancelled", "return_over", "sales_reach", "no_sale_by"].includes(r.trigger))){
    const P = periodData(k, k, ""), d = D();
    F.bills = P.all.map(s => ({ id: s.id, no: s.no, total: +s.total || 0, sub: +s.sub || 0, disc: +s.disc || 0, void: !!s.void, cust: { name: s.cust && s.cust.name || "" } }));
    F.returns = P.rets.map(r => ({ id: r.id, no: r.no, value: +r.value || 0, sale: r.sale, saleNo: (d.saleById[r.sale] || {}).no || "" }));
    F.sales = Math.round(P.live.reduce((a, s) => a + (+s.total || 0), 0) * 100) / 100;
  }
  if(need("owes_over")){
    const open = openBillBalances(), d = D(), bills = {}, oldest = {};
    Object.entries(open).forEach(([sid, amt]) => { const s = d.saleById[sid]; if(!s || s.void || !(amt > 0) || !s.cust || !s.cust.id) return;
      (bills[s.cust.id] = bills[s.cust.id] || []).push(s.no || "a bill"); oldest[s.cust.id] = Math.min(oldest[s.cust.id] || Infinity, s.t); });
    F.owed = createReadOnlyBusinessQuery({ now: () => now }).dues().rows.map(r => ({ id: r.id, name: r.name, amount: r.amount, phone: ((store.customers || {})[r.id] || {}).phone || "",
      bills: bills[r.id] || [], days: oldest[r.id] ? Math.floor((now - oldest[r.id]) / DAY) : 0 }));
  }
  return F;
}
/* What the rules find now: [{ id, rule: "custom", ruleId, action, subject, tone, title, sub, attr, cta, act? }] */
export function customFindings(now = Date.now()){
  const rules = customRules().filter(r => r.on !== false && customUsable(r)); if(!rules.length) return [];
  let F; try{ F = facts(now, rules); }catch(e){ logger.event("automation", "rule-failed", { op: "custom-facts", code: e && e.code }, "warn"); return []; }
  const shop = (store.access && store.access.shopName) || (store.profile && store.profile.shop_name) || "";
  const reminder = c => dueReminderText({ shop, customer: c.name, amount: c.amount, bills: c.bills, days: c.days });
  const out = [];
  rules.forEach(rule => {
    try{
      const G = rule.trigger === "stock_at" ? { ...F, product: productStock(rule.product) } : F;
      evaluateCustomRule(rule, G, { reminder }).forEach(f => out.push({ ...f, id: `custom:${rule.id}:${f.subject}`, rule: "custom", ruleId: rule.id, action: rule.action, subject: `${rule.id}:${f.subject}` }));
    }catch(e){ logger.event("automation", "rule-failed", { op: "custom", code: e && e.code }, "warn"); }   // that rule finds nothing this time
  });
  return out;
}
