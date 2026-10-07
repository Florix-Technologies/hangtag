// Automation's watch rules (domain/automation/rules.js WATCH_RULES) on this shop's records: what each one notices now, as
// Home → Needs attention items. One source: Home shows these (a rule set to Off shows nothing), and the automation log
// notes each rule's finding once a day (automation.js runAutomation). Worked out afresh from the calculations the app uses
// everywhere (stock levels, batches, the bills still owed on, the UPI payments checked by hand, orders, the cash book,
// sales, the upload queue and the backup log); nothing is stored and nothing is changed: a finding only links to where a
// person acts. The shop's own rules set to "Tell me" (services/custom-rules.js) are found here too, as rule "custom".
//   [{ id (the Home item), rule, tone (bad | warn | info), title, sub, attr (where it opens), cta, subject (for the log) }]
import { store } from '../../../shared/state/store.js';
import { inr } from '../../../shared/formatting/money.js';
import { addDays, agoText, dayKey, dayLab, fmtDate } from '../../../shared/formatting/dates.js';
import { esc } from '../../../shared/dom.js';
import { automationOf, WATCH_RULES } from '../../../domain/automation/rules.js';
import { isUnverified, unverifiedPayments } from '../../../domain/sales/payments.js';
import { D } from '../../inventory/services/ledger.js';
import { expiryAlerts, stockAlerts } from '../../inventory/services/alerts.js';
import { expiryDays } from '../../inventory/services/tracking.js';
import { periodData } from '../../reports/services/report-data.js';
import { receiptStatusOf } from '../../delivery/services/receipt-status.js';
import { sameTimeDays } from '../../reports/services/business-today.js';
import { createReadOnlyBusinessQuery } from '../../assistant/services/business-query.js';
import { closeOf } from '../../finance/use-cases/cash-moves.js';
import { can, canAny } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { moduleShown } from '../../shop/services/modules.js';
import { shopRegion } from '../../shop/services/region.js';
import { logger } from '../../../shared/logging/logger.js';
import { lastBackupAt } from '../../backup/services/backup-file.js';
import { customFindings } from './custom-rules.js';

const DAY = 864e5, HOUR = 36e5;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
export const watchSettings = () => automationOf(store.settings).watch;
/* May this shop / person see the rule's findings? (its permissions, features and tax regime) */
export function watchUsable(r){
  if(r.perms && !r.perms.some(p => can(p))) return false;
  if(r.caps && !r.caps.some(c => hasCap(c))) return false;
  if(r.tax && shopRegion().tax !== r.tax) return false;
  return true;
}

/* Sales orders still open after the late-orders setting (Settings → Automation → Watch): [order] — Home's Orders card too */
export const lateOrders = (now = Date.now(), W = watchSettings()) => Object.values(store.orders || {})
  .filter(o => o && o.kind === "sales" && ["draft", "confirmed", "partial"].includes(o.status) && +o.t > 0 && now - o.t >= W.lateDays * DAY);

const FINDERS = {
  stock(){
    if(!(moduleShown("stock") && canAny(["view_products", "manage_inventory", "create_purchase", "manage_products"]))) return [];
    const al = stockAlerts(), out = al.filter(a => a.level === "out").length, low = al.length - out;
    if(!al.length) return [];
    return [{ id: "stock", tone: out ? "bad" : "warn", title: out ? `${plural(out, "item")} sold out` : `${plural(low, "item")} running low`,
      sub: [out && low ? `${low} more running low` : "", al.slice(0, 2).map(a => a.p.name).join(", ")].filter(Boolean).join(" · "),
      attr: canAny(["manage_inventory", "view_reports"]) ? 'data-tab="stock" data-subview="stock:smart"' : 'data-tab="stock"', cta: "Restock" }];
  },
  overdue(now){
    if(!(moduleShown("customers") && canAny(["collect_credit", "view_reports"]))) return [];
    const d = createReadOnlyBusinessQuery({ now: () => now }).dues();
    if(!(d.total > 0)) return [];
    return [{ id: "dues", tone: "warn", title: `${inr(d.total)} to collect`, sub: `${plural(d.customers, "customer")} · most from ${d.rows[0].name} (${inr(d.rows[0].amount)})`,
      attr: d.customers === 1 ? `data-custhist="${esc(d.rows[0].id)}"` : 'data-tab="customers"', cta: "Collect" }];
  },
  mismatch(now){
    if(!(moduleShown("report") && can("view_reports"))) return [];
    const out = [], k = dayKey(now), bills = periodData(addDays(k, -29), k, "").live.filter(isUnverified);
    if(bills.length){ const amt = bills.reduce((a, s) => a + unverifiedPayments(s).reduce((b, p) => b + (+p.amount || 0), 0), 0);
      out.push({ id: "upi", tone: "warn", title: `${plural(bills.length, "UPI payment")} to verify`, sub: `${inr(amt)} · checked by hand, last 30 days`, attr: 'data-reportgo="30d|reconcileCard"', cta: "Reconcile", subject: "upi" }); }
    const um = (store.unmatched || []).filter(I => !I.resolution || I.resolution === "open");
    if(um.length) out.push({ id: "unmatched", tone: "bad", title: `${plural(um.length, "payment")} not on any bill`, sub: `${inr(um.reduce((a, I) => a + (+I.paidAmount || 0), 0))} received · refund or allocate`,
      attr: 'data-reportgo="30d|reconcileCard"', cta: "Resolve", subject: "unmatched" });
    return out;
  },
  late(now, W){
    if(!(moduleShown("orders") && canAny(["create_sale", "create_order"]))) return [];
    const late = lateOrders(now, W);
    if(!late.length) return [];
    const oldest = Math.min(...late.map(o => o.t)), online = late.filter(o => o.source === "customer").length, value = Math.round(late.reduce((a, o) => a + (+o.total || 0), 0) * 100) / 100;
    return [{ id: "late", tone: "bad", title: `${plural(late.length, "order")} late`, sub: `Open more than ${plural(W.lateDays, "day")} · the oldest ${Math.floor((now - oldest) / DAY)} days${online ? ` · ${online} from your online store` : ""}`,
      attr: 'data-tab="orders" data-subview="orders:sales"', cta: "Open", count: late.length, value, online }];
  },
  unusual(now){
    if(!(moduleShown("report") && can("view_reports"))) return [];
    if(new Date(now).getHours() < 11) return [];   // too early in the day to tell
    // the same weekday of the last four weeks, each up to this time (Business today's comparison days)
    const S = sameTimeDays(now), past = S.weekdays;
    if(past.some(p => !(p.bills > 0))) return [];   // four full weeks of this weekday with sales, or nothing is said
    const usual = past.reduce((a, p) => a + p.total, 0) / past.length, usualBills = past.reduce((a, p) => a + p.bills, 0) / past.length;
    if(usualBills < 3 || !(usual > 0)) return [];
    const today = S.today, ratio = today.total / usual, day = S.weekday;
    if(ratio < 0.5) return [{ id: "unusual", tone: "warn", title: "Sales slower than usual", sub: `${inr(today.total)} so far · a usual ${day} has ${inr(usual)} by now`, attr: 'data-tab="report"', cta: "See sales" }];
    if(ratio > 2) return [{ id: "unusual", tone: "info", title: "Sales busier than usual", sub: `${inr(today.total)} so far · a usual ${day} has ${inr(usual)} by now`, attr: 'data-tab="report"', cta: "See sales" }];
    return [];
  },
  expiry(){
    if(!(moduleShown("stock") && canAny(["manage_inventory", "create_purchase", "view_reports"]))) return [];
    const list = expiryAlerts(); if(!list.length) return [];
    const expired = list.filter(a => a.x === "expired").length, soon = list.length - expired;
    return [{ id: "expiry", tone: expired ? "bad" : "warn", title: expired ? `${plural(expired, "batch", "batches")} expired` : `${plural(soon, "batch", "batches")} expiring soon`,
      sub: [expired && soon ? `${soon} more within ${plural(expiryDays(), "day")}` : !expired ? `within ${plural(expiryDays(), "day")}` : "", list.slice(0, 2).map(a => a.r.p.name).join(", ")].filter(Boolean).join(" · "),
      attr: 'data-tab="stock"', cta: "Check stock" }];
  },
  receipts(){
    if(!can("create_sale")) return [];
    const ids = new Set([...(store.deliveryQueue || []).map(j => j.saleId), ...Object.keys(store.deliveries || {})]);
    const failed = [...ids].filter(id => { const s = D().saleById[id]; return s && !s.void && receiptStatusOf(id).state === "failed"; });
    if(!failed.length) return [];
    return [{ id: "receipts", tone: "warn", title: `${plural(failed.length, "receipt")} not sent`, sub: failed.length === 1 ? "The customer didn't get it · open the bill to send it again" : "The customers didn't get them · send them again from Bills",
      attr: failed.length === 1 ? `data-billview="${esc(failed[0])}"` : 'data-tab="bills" data-billstatus="unsent"', cta: "Send" }];
  },
  dayclose(now, W){
    if(!can("create_sale") || new Date(now).getHours() < W.closeHour) return [];
    const k = dayKey(now);
    if(closeOf(k, "shop") || closeOf(k, store.dev)) return [];
    const x = periodData(k, k, "");
    if(!x.live.length) return [];
    return [{ id: "dayclose", tone: "info", title: "Close today's cash", sub: `${plural(x.live.length, "bill")} today · count the cash and close the day`,
      attr: 'data-cashform="close"', cta: "Close day" }];
  },
  gst(now){
    if(!(moduleShown("report") && can("view_reports")) || !(store.settings && store.settings.taxOn)) return [];
    const d = new Date(now); if(d.getDate() > 11) return [];
    const last = new Date(d.getFullYear(), d.getMonth() - 1, 1), month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
    const from = month + "-01", to = dayKey(new Date(d.getFullYear(), d.getMonth(), 0));
    if(!periodData(from, to, "").live.length) return [];
    if((store.settings.gstExports || []).some(x => x.period === month)) return [];   // already exported for that month
    const name = fmtDate(last, { month: "long", year: "numeric" });
    return [{ id: "gst", tone: d.getDate() >= 9 ? "warn" : "info", title: `Prepare GST for ${name}`, sub: `GSTR-1 is due on the 11th · check and export the month`,
      attr: `data-act="gstview" data-gstmonth="${month}"`, cta: "Prepare", subject: month }];
  },
  // the morning briefing is Home's own card (this rule switches it); it adds nothing to Needs attention
  briefing(){ return []; },
  backup(now, W){
    if(!can("manage_settings")) return [];
    const out = [], q = (store.sbOfflineQueue || []).length, refused = (store.syncReview || []).length;
    if(refused) out.push({ id: "syncreview", tone: "bad", title: `${plural(refused, "change")} not saved in the cloud`, sub: "The cloud refused them · look at each in the sync review", attr: 'data-act="syncpanel"', cta: "Review", subject: "review" });
    else if(q && store.lastSyncAt && now - store.lastSyncAt > 6 * HOUR) out.push({ id: "unsynced", tone: "warn", title: `${plural(q, "change")} not in the cloud yet`,
      sub: `This device was last fully saved ${agoText(store.lastSyncAt)} · connect it to the internet`, attr: 'data-act="syncpanel"', cta: "Check", subject: "queue" });
    // a backup file: once the shop has had bills for the days set, and none downloaded on this device since
    const sales = D().sales, first = sales.length ? sales[0].t : 0, last = lastBackupAt();
    if(first && now - first > W.backupDays * DAY && now - (last || 0) > W.backupDays * DAY)
      out.push({ id: "backupfile", tone: "info", title: "Download a backup file", sub: last ? `The last one on this device was on ${dayLab(dayKey(last))} · the cloud keeps a copy too` : "None on this device yet · the cloud keeps a copy too",
        attr: 'data-act="backup"', cta: "Download", subject: "file" });
    return out;
  },
};

/* What the watch rules set to Notify find now, for this person: [finding] (each with its rule) */
export function watchFindings(now = Date.now()){
  const W = watchSettings(), out = [];
  WATCH_RULES.forEach(r => {
    if(W[r.key] !== "notify" || !watchUsable(r) || !FINDERS[r.key]) return;
    try{ FINDERS[r.key](now, W).forEach(f => out.push({ ...f, rule: r.key, subject: f.subject || r.key })); }
    catch(e){ logger.event("automation", "rule-failed", { op: r.key, code: e && e.code }, "warn"); }   // finds nothing this time; the next run tries again
  });
  customFindings(now).filter(f => f.action === "notify").forEach(f => out.push(f));
  return out;
}
