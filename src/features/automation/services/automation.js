// Automation (domain/automation/rules.js) on this shop's records: what each rule finds now, what waits for a person's OK
// (Approvals), what runs by itself, and the automation log — kept on this device and, for people who manage the shop's
// settings, in the cloud (one log per device, hangtag_meta "autolog:<device>"), so the owner sees every device's.
// Findings are worked out afresh each time from the same calculations the app uses everywhere (Smart reorder's
// suggestion, the bills still owed on, the UPI payments checked by hand): nothing is stored but the log.
//   reorder: one open reorder draft per supplier at a time (a draft already waiting is never doubled)
//   dues:    a customer's bills on account unpaid for longer than the days set, with the reminder written out
// A dismissal (or an approval) is remembered in the log and keeps the same finding away for a while (SNOOZE).
import { AUTOMATION_RULES, automationOf, dueReminderText, logEntry, mergeLogs } from '../../../domain/automation/rules.js';
import { store } from '../../../shared/state/store.js';
import { saveAutoLog } from '../../../shared/state/persistence.js';
import { uid } from '../../../shared/utils/ids.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { D } from '../../inventory/services/ledger.js';
import { poFromReorder, poList, reorderGroups } from '../../inventory/use-cases/purchase-orders.js';
import { openBillBalances } from '../../customers/services/customer-account.js';
import { waPhone } from '../../receipts/services/receipt-output.js';
import { isUnverified } from '../../../domain/sales/payments.js';
import { can, canAny, signedInAs } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { enqueue } from '../../sync/services/outbox.js';
import { logger } from '../../../shared/logging/logger.js';

const DAY = 864e5;
const SNOOZE = { reorder: DAY, dues: 3 * DAY };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
export const automationSettings = () => automationOf(store.settings);
/* May this person act on the rule here? (its permissions, and the feature it needs) */
export const ruleUsable = r => (!r.perms || r.perms.some(p => can(p))) && (!r.cap || hasCap(r.cap));

/* ---------- the log ---------- */
const who = () => signedInAs() || (store.authUser && store.authUser.email) || "This device";
export function logAutomation(e){
  const entry = logEntry({ id: "a" + uid(), t: Date.now(), by: who(), dev: store.dev, ...e });
  store.autoLog = mergeLogs([entry], store.autoLog || []); saveAutoLog();
  if(can("manage_settings")) enqueue({ type: "autolog" });
  return entry;
}
/* This device's own entries (what it uploads under its key) */
export const ownLog = () => (store.autoLog || []).filter(e => e.dev === store.dev);
/* The cloud's logs of every device, with this device's */
export function mergeCloudLog(entries){ store.autoLog = mergeLogs(store.autoLog || [], entries || []); saveAutoLog(); }
/* Was this finding approved or dismissed lately? */
function snoozed(key, rule, now){
  const e = (store.autoLog || []).find(x => x.key === key && (x.action === "dismissed" || x.action === "approved"));
  return !!e && now - e.t < (SNOOZE[rule] || DAY);
}

/* ---------- what the rules find ---------- */
function reorderFindings(){
  const open = poList().filter(p => p.status === "draft" && p.source === "reorder");
  return reorderGroups().filter(g => g.supplierId && !open.some(p => p.supplierId === g.supplierId)).map(g => ({
    key: `reorder:${g.supplierId}`, rule: "reorder", title: `Draft a purchase order for ${g.supplier}`,
    sub: `${g.items.map(l => `${l.name}${l.vl ? " " + l.vl : ""} × ${l.q}`).slice(0, 3).join(", ")}${g.items.length > 3 ? ` and ${g.items.length - 3} more` : ""}${g.total ? ` · about ${inr(g.total)}` : ""}`,
    act: { kind: "po", supplierId: g.supplierId, supplier: g.supplier, items: g.items }, approve: "Save draft",
  }));
}
function dueFindings(days, now){
  const owed = openBillBalances(), by = new Map(), d = D();
  Object.entries(owed).forEach(([sid, amt]) => {
    const s = d.saleById[sid]; if(!s || s.void || !(amt > 0) || !s.cust || !s.cust.id || now - s.t < days * DAY) return;
    const g = by.get(s.cust.id) || { cid: s.cust.id, amount: 0, bills: [], oldest: s.t };
    g.amount += amt; g.bills.push(s.no || "a bill"); g.oldest = Math.min(g.oldest, s.t); by.set(s.cust.id, g);
  });
  const shop = (store.access && store.access.shopName) || (store.profile && store.profile.shop_name) || "";
  return [...by.values()].sort((a, b) => b.amount - a.amount).map(g => {
    const c = (store.customers || {})[g.cid] || {}, age = Math.floor((now - g.oldest) / DAY), amount = Math.round(g.amount * 100) / 100;
    return { key: `dues:${g.cid}`, rule: "dues", title: `Remind ${c.name || "a customer"} about ${inr(amount)}`, sub: `${plural(g.bills.length, "bill")} unpaid · the oldest ${age} days`,
      act: { kind: "remind", customerId: g.cid, name: c.name || "", phone: c.phone || "", text: dueReminderText({ shop, customer: c.name, amount, bills: g.bills, days: age }) }, approve: "Open WhatsApp" };
  });
}
/* Everything the rules find now that this person may act on (whatever the policy, but off): [{ key, rule, title, sub, act, approve }] */
export function automationFindings(now = Date.now()){
  const A = automationSettings(), on = r => A[r.key] !== "off" && ruleUsable(r), out = [];
  AUTOMATION_RULES.forEach(r => {
    if(!on(r)) return;
    try{
      if(r.key === "reorder") out.push(...reorderFindings());
      if(r.key === "dues") out.push(...dueFindings(A.dueDays, now));
    }catch(e){ logger.event("automation", "rule-failed", { op: "findings", code: e && e.code }, "warn"); }   // a rule that can't read its data finds nothing this time
  });
  return out;
}
/* What waits for a person's OK: the findings of rules set to "Ask me first", not dismissed or approved lately */
export function pendingApprovals(now = Date.now()){
  const A = automationSettings();
  return automationFindings(now).filter(f => A[f.rule] === "ask" && !snoozed(f.key, f.rule, now));
}

/* ---------- acting ---------- */
/* → { ok, po? , url? } or { error }. The person's OK: drafts the purchase order, or gives the WhatsApp link to open. */
export function approveAutomation(key, now = Date.now()){
  const f = automationFindings(now).find(x => x.key === key);
  if(!f) return { error: "That isn't waiting any more." };
  if(f.act.kind === "po"){
    const r = poFromReorder(f.act.supplierId, f.act.items);
    if(r.error){ logAutomation({ rule: f.rule, action: "failed", key, text: `Draft purchase order for ${f.act.supplier}: ${r.error}` }); return r; }
    logAutomation({ rule: f.rule, action: "approved", key, text: `Draft purchase order ${r.po.no} for ${f.act.supplier} (${plural(f.act.items.length, "product")}). Not sent.` });
    return { ok: true, po: r.po };
  }
  if(f.act.kind === "remind"){
    const num = waPhone(f.act.phone);
    logAutomation({ rule: f.rule, action: "approved", key, text: `Payment reminder to ${f.act.name} opened in WhatsApp (${f.title.replace(/^Remind .+? about /, "")}).` });
    return { ok: true, url: `https://wa.me/${num}?text=${encodeURIComponent(f.act.text)}`, phone: !!num };
  }
  return { error: "That can't be done here." };
}
export function dismissAutomation(key, now = Date.now()){
  const f = automationFindings(now).find(x => x.key === key);
  if(!f) return { error: "That isn't waiting any more." };
  logAutomation({ rule: f.rule, action: "dismissed", key, text: f.title });
  return { ok: true };
}
/* What runs by itself (policy "Automatically"), safe to repeat: reorder drafts (one per supplier) and, through checkUpi,
   asking the payment provider about UPI payments checked by hand. → how many things it did */
export async function runAutomation({ now = Date.now(), checkUpi = null, online = false } = {}){
  const A = automationSettings(); let done = 0;
  const reorder = AUTOMATION_RULES.find(r => r.key === "reorder");
  if(A.reorder === "auto" && ruleUsable(reorder)){
    for(const f of reorderFindings()){
      const r = poFromReorder(f.act.supplierId, f.act.items);
      if(r.error) logger.event("automation", "rule-failed", { op: "reorder" }, "warn");
      logAutomation(r.error ? { rule: "reorder", action: "failed", key: f.key, text: `Draft purchase order for ${f.act.supplier}: ${r.error}` }
        : { rule: "reorder", action: "auto", key: f.key, text: `Drafted purchase order ${r.po.no} for ${f.act.supplier} (${plural(f.act.items.length, "product")}). Not sent.` });
      if(!r.error) done++;
    }
  }
  if(A.upi === "auto" && online && checkUpi && canAny(["create_sale"]) && D().sales.some(isUnverified)){
    try{ const n = await checkUpi(); if(n){ done += n; logAutomation({ rule: "upi", action: "auto", key: `upi:${dayKey(now)}`, text: `${plural(n, "UPI payment")} verified by the payment provider.` }); } }
    catch(e){ logger.event("automation", "rule-failed", { op: "upi", code: e && e.code }, "warn"); }   // tried again on the next run
  }
  return done;
}
