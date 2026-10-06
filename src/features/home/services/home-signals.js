// Home's figures, read from the shop's own records through the calculations Reports, Smart reorder and Ask Hangtag
// already use (nothing is worked out a second way, nothing here changes data):
//   today:     sales, bills, average bill, against this time yesterday; gross profit only when cost prices cover enough
//              of the sales to be honest about it; cash / UPI / card taken
//   attention: what someone should act on (stock running out, orders to deliver, held bills, UPI to verify, money
//              received that isn't on a bill, customer and supplier dues, purchase orders to receive, receipts this
//              device couldn't send), each with where to act on it, worst first; only what this person may act on
//   insights:  the Hangtag Agent's few observations from the data (what to reorder, the sales pace, the week's best
//              seller, money tied up in stock that isn't selling), each with where to look
//   trend:     the last 7 days of sales; recent: the latest bills with their state
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { stockAlerts } from '../../inventory/services/alerts.js';
import { liveProducts } from '../../products/services/catalog.js';
import { periodData, kstats, netLines } from '../../reports/services/report-data.js';
import { createReadOnlyBusinessQuery } from '../../assistant/services/business-query.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';
import { pendingApprovals } from '../../automation/services/automation.js';
import { watchFindings } from '../../automation/services/watchers.js';
import { salesByChannel } from '../../commerce/services/channels.js';
import { billContext, billState } from '../../bills/services/bill-status.js';
import { paymentSummary, profitSummary } from '../../../domain/reports/sales-report.js';
import { can, canAny } from '../../shop/services/access.js';
import { moduleShown } from '../../shop/services/modules.js';
import { addDays, dayKey, fmtDate } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { esc } from '../../../shared/dom.js';

/* Gross profit shows only when cost prices are known for at least this share of the day's sales */
export const PROFIT_MIN_COVERAGE = 0.8;
const DAY = 864e5;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;

/* Variants running low or sold out (products on sale), fewest first */
export { stockAlerts };

/* Sales of one day up to a time (the whole day when `until` is past it) */
function dayFigures(k, until = Infinity){
  const x = periodData(k, k, "");
  return kstats(x.live.filter(s => s.t <= until), x.rets.filter(r => r.t <= until));
}

export function todayFigures(now = Date.now()){
  const k = dayKey(now), x = periodData(k, k, ""), K = kstats(x.live, x.rets), Y = dayFigures(addDays(k, -1), now - DAY);
  const out = { sales: K.rev, bills: K.bills, avg: K.avg, pieces: K.pcs, vsYesterday: Y.bills ? pct(K.rev, Y.rev) : null, profit: null, money: null, channels: [] };
  try{ out.channels = salesByChannel(k, k, ""); }catch{ out.channels = []; }
  if(can("view_reports")){
    const P = profitSummary(netLines(x.live, x.rets));
    out.profit = { value: P.grossProfit, margin: P.margin, coverage: P.coverage, complete: P.complete, shown: !P.netSales || P.coverage >= PROFIT_MIN_COVERAGE };
    const m = paymentSummary(x.live, x.rets).methods, inOf = key => (m[key] || {}).in || 0;
    out.money = { cash: inOf("cash"), upi: inOf("upi"), card: inOf("card") };
  }
  return out;
}

const TONE_RANK = { bad: 0, warn: 1, info: 2 };
/* [{ id, tone: bad|warn|info, title, sub, attr, cta }] — worst first */
export function attentionItems(now = Date.now()){
  const q = createReadOnlyBusinessQuery({ now: () => now }), items = [];
  const add = (id, tone, title, sub, attr, cta) => items.push({ id, tone, title, sub, attr, cta });
  // what Automation's watch rules notice (Settings → Automation → Watch: low stock, money owed, payment mismatches, late
  // orders, unusual sales, expiring stock, receipts not sent, daily closing, GST): one source, a rule set to Off shows nothing
  watchFindings(now).forEach(f => add(f.id, f.tone, f.title, f.sub, f.attr, f.cta));
  if(moduleShown("orders") && canAny(["create_sale", "create_order"])){
    const o = q.orders();
    if(o.sales) add("orders", o.mobile ? "warn" : "info", `${plural(o.sales, "order")} to deliver`, `${inr(o.salesValue)}${o.mobile ? ` · ${o.mobile} from your online store` : ""}`, 'data-tab="orders"', "Open");
    if(o.quotes) add("quotes", "info", `${plural(o.quotes, "quotation")} waiting`, inr(o.quoteValue), 'data-tab="orders"', "Follow up");
  }
  const held = Object.values(store.heldCarts || {}).filter(Boolean).length;
  if(held && can("create_sale")) add("held", "warn", `${plural(held, "bill")} on hold`, "Finish or clear them", 'data-tab="orders" data-subview="orders:held"', "Open");
  if(moduleShown("stock") && canAny(["create_purchase", "view_reports"])){
    const s = q.supplierDues();
    if(s.total > 0) add("suppliers", "info", `${inr(s.total)} to pay suppliers`, plural(s.suppliers, "supplier"), 'data-navsub="stock:suppliers"', "Pay");
    const po = q.purchaseOrders();
    if(po.sent && can("manage_inventory")) add("pos", "info", `${plural(po.sent, "purchase order")} to receive`, inr(po.value), 'data-navsub="stock:pos"', "Receive");
  }
  // what Automation found and waits for a person's OK (Settings → Automation: "Ask me first")
  let appr = [];
  try{ appr = pendingApprovals(now); }catch{ appr = []; }
  if(appr.length) add("approvals", "warn", `${plural(appr.length, "automation")} waiting for your OK`, appr[0].title + (appr.length > 1 ? ` and ${appr.length - 1} more` : ""), "data-approvals", "Review");
  return items.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}

/* The Hangtag Agent's observations: [{ id, text, attr, cta }], at most `limit`; only for people who see reports */
export function agentInsights(now = Date.now(), limit = 3){
  if(!can("view_reports")) return [];
  const out = [], add = (id, text, attr, cta) => out.push({ id, text, attr, cta });
  let inv = null;
  try{ inv = inventoryIntelligence({ now }); }catch{ inv = null; }
  if(inv && moduleShown("stock")){
    const re = inv.products.filter(r => r.shouldReorder);
    if(re.length){ const r = re[0], days = r.lowestDaysRemaining, unit = r.unit && r.unit !== "pcs" ? " " + r.unit : "";
      add("reorder", `${r.name}: ${r.currentStock <= 0 ? "sold out" : days == null ? "running low" : `about ${days} day${days === 1 ? "" : "s"} of stock left`}${r.suggestedReorderQty ? ` — reorder ${r.suggestedReorderQty}${unit}` : ""}${re.length > 1 ? `. ${re.length - 1} more to reorder.` : "."}`,
        'data-tab="stock" data-subview="stock:smart"', "Smart reorder"); }
  }
  // rising demand: not at the reorder point yet, but at the recent rate it runs out before a new order would arrive
  if(inv && moduleShown("stock")){
    const soon = inv.products.filter(r => r.risingRisk).sort((a, b) => (a.lowestForecastDays ?? Infinity) - (b.lowestForecastDays ?? Infinity));
    if(soon.length){ const r = soon[0];
      add("rising", `Demand for ${r.name} is up ${Math.max(0, r.trendPercent || 0)}%: at the recent rate it lasts about ${r.lowestForecastDays} days — order soon.${soon.length > 1 ? ` ${soon.length - 1} more like it.` : ""}`, 'data-tab="stock" data-subview="stock:smart"', "Smart reorder"); }
  }
  // the pace: today against the same weekday last week, up to this time
  const k = dayKey(now), T = dayFigures(k, now), W = dayFigures(addDays(k, -7), now - 7 * DAY), d = W.bills && T.bills ? pct(T.rev, W.rev) : null;
  if(d != null && Math.abs(d) >= 10){ const wd = fmtDate(now - 7 * DAY, { weekday: "long" });
    add("pace", `Sales are ${Math.abs(d)}% ${d > 0 ? "ahead of" : "behind"} last ${wd} at this time (${inr(T.rev)} against ${inr(W.rev)}).`, moduleShown("report") ? 'data-tab="report"' : "", "Reports"); }
  const best = createReadOnlyBusinessQuery({ now: () => now }).products("7d", "quantity", 1)[0];
  if(best && best.quantity >= 3){ const p = liveProducts().find(x => x.id === best.id);
    add("best", `${best.name} is this week's best seller: ${best.quantity} sold for ${inr(best.sales)}.`, p ? `data-prodopen="${esc(p.id)}"` : "", p ? "View" : ""); }
  if(inv && inv.summary.deadStock && inv.summary.deadStockValue > 0)
    add("dead", `${inr(inv.summary.deadStockValue)} is tied up in ${plural(inv.summary.deadStock, "product")} with no sale for ${inv.config.deadDays} days or more.`, 'data-tab="stock" data-subview="stock:smart"', "Review");
  return out.slice(0, limit);
}

/* The last `days` days of sales, oldest first: { days: [{ k, sales, bills }], total, prevTotal } */
export function salesTrend(now = Date.now(), days = 7){
  const to = dayKey(now), from = addDays(to, -(days - 1)), x = periodData(from, to, ""), by = {};
  x.live.forEach(s => (by[dayKey(s.t)] = by[dayKey(s.t)] || { live: [], rets: [] }).live.push(s));
  x.rets.forEach(r => (by[dayKey(r.t)] = by[dayKey(r.t)] || { live: [], rets: [] }).rets.push(r));
  const list = Array.from({ length: days }, (_, i) => { const k = addDays(from, i), g = by[k], K = g ? kstats(g.live, g.rets) : { rev: 0, bills: 0 }; return { k, sales: K.rev, bills: K.bills }; });
  const P = periodData(addDays(from, -days), addDays(from, -1), "");
  return { days: list, total: list.reduce((a, d) => a + d.sales, 0), prevTotal: kstats(P.live, P.rets).rev };
}

/* The latest bills with their state (paid / unpaid / cancelled, returned …) */
export function recentBills(limit = 5){
  const ctx = billContext();
  return D().sales.slice().sort((a, b) => b.t - a.t).slice(0, limit).map(s => ({ s, st: billState(s, ctx) }));
}
