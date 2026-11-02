// The owner's morning briefing (domain/reports/daily-briefing.js): yesterday's facts and what needs doing, gathered through
// the calculations the app already uses — the report figures and Business today's fact gatherers (services/business-today.js:
// the sales and their explanation, what customers owe, the reconciliation checks), Smart reorder and the stock and expiry
// alerts, purchase orders and what has been received on them. Read-only: nothing here changes a record.
import { store } from '../../../shared/state/store.js';
import { addDays, dayKey, dayLab, daysBetween, fmtDate } from '../../../shared/formatting/dates.js';
import { dailyBriefing } from '../../../domain/reports/daily-briefing.js';
import { pickComparison } from '../../../domain/reports/business-today.js';
import { poProgress } from '../../../domain/inventory/purchase-orders.js';
import { roundQty } from '../../../domain/catalog/units.js';
import { D } from '../../inventory/services/ledger.js';
import { dayUpTo, duesFacts, reconFacts, salesFacts } from './business-today.js';
import { kstats, netLines, periodData } from './report-data.js';
import { createReadOnlyBusinessQuery } from '../../assistant/services/business-query.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';
import { expiryAlerts, stockAlerts } from '../../inventory/services/alerts.js';
import { purchasesList, supplierById } from '../../inventory/services/purchase-state.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { logger } from '../../../shared/logging/logger.js';

const part = (section, f, empty) => { try{ return f(); }catch(e){ logger.event("home", "briefing-failed", { op: section, code: e && e.code }, "warn"); return empty; } };

function stockFacts(now, today){
  const week = periodData(addDays(today, -7), addDays(today, -1), ""), sold = {};
  netLines(week.live, week.rets).forEach(l => { sold[l.pid] = roundQty((sold[l.pid] || 0) + l.q); });
  const out = [], seen = new Set();
  stockAlerts().filter(a => a.level === "out").forEach(a => { if(seen.has(a.p.id) || !(sold[a.p.id] > 0)) return; seen.add(a.p.id); out.push({ id: a.p.id, name: a.p.name, sold: sold[a.p.id] }); });
  out.sort((a, b) => b.sold - a.sold);
  const inv = inventoryIntelligence({ now });
  const runningOut = inv.products.filter(r => r.shouldReorder && r.currentStock > 0 && r.lowestDaysRemaining != null && r.lowestDaysRemaining <= 3 && !seen.has(r.id))
    .sort((a, b) => a.lowestDaysRemaining - b.lowestDaysRemaining).map(r => ({ id: r.id, name: r.name, days: Math.max(1, Math.round(r.lowestDaysRemaining)) }));
  const rising = inv.products.filter(r => r.risingRisk).map(r => ({ id: r.id, name: r.name, trend: Math.max(0, r.trendPercent || 0) }));
  const expiring = expiryAlerts().map(a => ({ name: a.r.p.name, batch: a.b.b, days: daysBetween(today, a.b.exp) }));
  return { soldOut: out, runningOut, rising, expiring, dead: { value: inv.summary.deadStockValue, products: inv.summary.deadStock, days: inv.config.deadDays } };
}
function purchaseOrders(today){
  const purchases = purchasesList();
  return bizRepository().list("po").filter(o => o && o.status === "sent").map(o => ({ o, p: poProgress(o, purchases) })).filter(x => x.p.status !== "received")
    .map(({ o, p }) => ({ id: o.id, no: o.no || "Purchase order", supplier: (supplierById(o.supplierId) || {}).name || "the supplier",
      value: Math.round(p.lines.reduce((a, l) => a + l.remaining * (+l.price || 0), 0) * 100) / 100,
      expected: o.expected ? dayLab(o.expected) : "", late: o.expected ? daysBetween(o.expected, today) : null }));
}

let memo = null;
const versionOf = now => [D(), dayKey(now), Object.keys(store.cashMoves || {}).length, Object.keys(store.dayCloses || {}).length, Object.keys(store.collections || {}).length,
  Object.keys(store.moves || {}).length, Object.values(store.biz || {}).reduce((a, x) => a + Object.keys(x || {}).length, 0), store.unmatched, store.settings, Math.floor(now / 60000)];
/* The briefing for the morning of `now` (about yesterday): { title, sections, first, quiet, text } */
export function briefingView(now = Date.now()){
  const v = versionOf(now);
  if(memo && memo.v.every((x, i) => x === v[i])) return memo.out;
  const today = dayKey(now), yk = addDays(today, -1), full = k => dayUpTo(k, Infinity);
  const weekday = fmtDate(new Date(yk + "T12:00:00"), { weekday: "long" });
  const days = { today: full(yk), weekdays: [7, 14, 21, 28].map(n => full(addDays(yk, -n))), yesterday: full(addDays(yk, -1)), weekday };
  const comparison = pickComparison({ ...days, whole: true }), S = salesFacts(now, days, comparison);
  const wk = periodData(addDays(yk, -6), yk, ""), prev = periodData(addDays(yk, -13), addDays(yk, -7), "");
  const best = part("best", () => createReadOnlyBusinessQuery({ now: () => now }).products("yesterday", "quantity", 1)[0] || null, null);
  const dues = part("dues", () => duesFacts(today, now), { open: [], overdueDays: 30 });
  const out = dailyBriefing({
    dayLabel: fmtDate(new Date(yk + "T12:00:00"), { weekday: "long", day: "numeric", month: "long" }), weekday,
    yesterday: S.today, weekdays: days.weekdays, dayBefore: days.yesterday, products: S.products, biggest: S.biggest, cancelled: S.cancelled,
    week: { total: kstats(wk.live, wk.rets).rev, prev: kstats(prev.live, prev.rets).rev },
    best: best ? { id: best.id, name: best.name, q: best.quantity, amount: best.sales } : null,
    stock: part("stock", () => stockFacts(now, today), {}), dues: { overdueDays: dues.overdueDays, open: dues.open },
    pos: part("pos", () => purchaseOrders(today), []), recon: part("reconciliation", () => reconFacts(today), null),
  });
  memo = { v, out };
  return out;
}
