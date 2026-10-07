// Business today: the facts the day's money is judged on, gathered through the calculations the app already uses — the
// report summary and gross profit (report-data.js, domain/reports/sales-report.js), the payment split, the cash book and
// the day close (finance), what customers owe (customer credit), Smart reorder's stock valuation and the reconciliation
// checks — and handed to domain/reports/business-today.js, which compares them and says why a figure is out of the
// ordinary. Read-only: nothing here changes a record. Home's Business today card, the Agent's get_business_today tool
// and Automation's "unusual sales" rule all read it, so no figure is worked out two ways.
import { store } from '../../../shared/state/store.js';
import { logger } from '../../../shared/logging/logger.js';
import { addDays, dayKey, dayLong, fmtDate, hhmm } from '../../../shared/formatting/dates.js';
import { businessToday, pickComparison } from '../../../domain/reports/business-today.js';
import { groupLines, paymentSummary, profitSummary } from '../../../domain/reports/sales-report.js';
import { reconcileSale } from '../../../domain/finance/books.js';
import { PAY_METHODS, dueAmtOf, isUnverified, unverifiedPayments } from '../../../domain/sales/payments.js';
import { automationOf } from '../../../domain/automation/rules.js';
import { D } from '../../inventory/services/ledger.js';
import { periodData, kstats, netLines } from './report-data.js';
import { dayBounds, shopTransactions } from '../../finance/services/books-data.js';
import { closeOf, closeState, dayCash, scopeTransactions } from '../../finance/use-cases/cash-moves.js';
import { bankAccounts, methodLanding } from '../../finance/use-cases/bank-accounts.js';
import { createReadOnlyBusinessQuery } from '../../assistant/services/business-query.js';
import { collectionsList, openBillBalances } from '../../customers/services/customer-account.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';

const DAY = 864e5;
const r2 = x => Math.round(x * 100) / 100;
const paise = x => Math.round((+x || 0) * 100);
const sum = (list, f) => r2(list.reduce((a, x) => a + (+f(x) || 0), 0));

/* The same time of day on another day */
export const clockOf = (k, now) => { const d = new Date(now), x = new Date(k + "T00:00:00"); x.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0); return +x; };
/* A day's bills and returns up to a time of that day, with its summary (the report's figures) */
export function dayUpTo(k, until){
  const x = periodData(k, k, ""), live = x.live.filter(s => s.t <= until), rets = x.rets.filter(r => r.t <= until), K = kstats(live, rets);
  return { k, live, rets, all: x.all.filter(s => s.t <= until), total: K.rev, bills: K.bills, avgBill: K.avg, pieces: K.pcs, gross: K.gross,
    returns: K.retVal, returnCount: K.returnCount, discounts: K.dsc };
}
/* Today up to now, and the days it can be compared with, each up to this time of day: the same weekday of the last four
   weeks (latest first) and yesterday. { today, weekdays, yesterday, weekday } */
export function sameTimeDays(now = Date.now()){
  const k = dayKey(now), at = n => { const d = addDays(k, -n); return dayUpTo(d, clockOf(d, now)); };
  return { today: dayUpTo(k, now), weekdays: [7, 14, 21, 28].map(at), yesterday: at(1), weekday: fmtDate(now, { weekday: "long" }) };
}
/* What today's sales are compared with: a usual <weekday> by this time, else last <weekday>, else yesterday (or null) */
export const salesComparison = (now = Date.now(), days = sameTimeDays(now)) => pickComparison(days);

/* Sales by product of a day's bills and returns: { [product id]: { id, name, amt } } */
function productSales(live, rets){
  const m = {};
  netLines(live, rets).forEach(l => { const o = m[l.pid] || (m[l.pid] = { id: l.pid, name: l.name, amt: 0 }); o.amt += l.amt; });
  return m;
}
const notExchange = s => (s.kind || "sale") !== "exchange";
export function salesFacts(now, days, comparison){
  const T = days.today, used = comparison ? [...days.weekdays, days.yesterday].filter(d => comparison.dayKeys.includes(d.k)) : [];
  const today = productSales(T.live, T.rets), usual = {};
  used.forEach(d => Object.values(productSales(d.live, d.rets)).forEach(p => { const o = usual[p.id] || (usual[p.id] = { id: p.id, name: p.name, amt: 0 }); o.amt += p.amt / used.length; }));
  const products = [...new Set([...Object.keys(today), ...Object.keys(usual)])].map(id => ({ id, name: (today[id] || usual[id]).name, today: r2((today[id] || {}).amt || 0), usual: r2((usual[id] || {}).amt || 0) }));
  const bills = T.live.filter(notExchange), last = T.live.length ? T.live.reduce((a, s) => s.t > a.t ? s : a) : null;
  const big = bills.length ? bills.reduce((a, s) => +s.total > +a.total ? s : a) : null, voided = T.all.filter(s => s.void);
  // the bills the comparison has between the time of today's last bill and now
  const since = last && used.length ? used.reduce((a, d) => { const from = clockOf(d.k, last.t), to = clockOf(d.k, now); return a + d.live.filter(s => notExchange(s) && s.t > from && s.t <= to).length; }, 0) / used.length : 0;
  return { today: { total: T.total, bills: T.bills, avgBill: T.avgBill, pieces: T.pieces, gross: T.gross, returns: T.returns, returnCount: T.returnCount, discounts: T.discounts },
    products, lastBill: last ? { t: last.t, time: hhmm(last.t) } : null, minutesSinceLastBill: last ? Math.floor((now - last.t) / 60000) : null,
    usualBillsSince: Math.round(since * 10) / 10, biggest: big ? { id: big.id, no: big.no || "Bill", total: +big.total || 0, customer: big.cust && big.cust.name || "" } : null,
    cancelled: { count: voided.length, value: sum(voided, s => s.total) } };
}
/* Gross profit today against the 30 days before, with the discounts and each product's sales and cost */
function profitFacts(T, past){
  const lines = netLines(T.live, T.rets), U = past.live.length ? profitSummary(netLines(past.live, past.rets)) : null, K = kstats(past.live, past.rets);
  return { today: profitSummary(lines), usual: U, discounts: { today: T.discounts, todayGross: T.gross, usual: K.dsc, usualGross: K.gross },
    products: groupLines(lines, l => l.pid).map(g => ({ id: g.key, name: g.first.name, rev: g.rev, cost: g.cost, q: g.q })) };
}
/* Money taken today by method, against the 30 days before; the drawer now; today's close; UPI still checked by hand */
function paymentFacts(k, T, past){
  const S = paymentSummary(T.live, T.rets).methods, U = paymentSummary(past.live, past.rets).methods, B = dayCash(k, "shop");
  const live = B.entries.filter(e => e.status === "posted"), close = closeOf(k, "shop") || closeOf(k, store.dev), unv = T.live.filter(isUnverified);
  return { today: { cash: S.cash.in, upi: S.upi.in, card: S.card.in }, refunds: { cash: S.cash.refunds, upi: S.upi.refunds, card: S.card.refunds },
    count: { cash: S.cash.bills, upi: S.upi.bills, card: S.card.bills }, usual: { cash: U.cash.in, upi: U.upi.in, card: U.card.in, bills: past.live.length },
    drawer: { opening: B.opening, closing: B.closing, in: sum(live, e => e.in), out: sum(live, e => e.out) },
    close: close ? { counted: close.counted, diff: close.diff } : null,
    unverified: { count: unv.length, amount: sum(unv, s => sum(unverifiedPayments(s), p => p.amount)) } };
}
/* What customers owe: the total, the bills still owed on (oldest first), what was added and collected today */
export function duesFacts(k, now){
  const q = createReadOnlyBusinessQuery({ now: () => now }).dues(), names = Object.fromEntries(q.rows.map(r => [r.id, r.name])), d = D();
  const open = Object.entries(openBillBalances()).map(([sid, amount]) => { const s = d.saleById[sid]; if(!s) return null; const cid = s.cust && s.cust.id;
    return { saleId: sid, no: s.no || "Bill", id: cid, name: names[cid] || (s.cust && s.cust.name) || "Customer", amount, t: s.t, days: Math.max(0, Math.floor((now - s.t) / DAY)) }; })
    .filter(Boolean).sort((a, b) => a.t - b.t);
  const added = d.sales.filter(s => !s.void && dayKey(s.t) === k && dueAmtOf(s) > 0), got = collectionsList().filter(c => c && c.status !== "cancelled" && dayKey(c.t) === k);
  return { total: q.total, customers: q.customers, rows: q.rows, open, addedToday: { amount: sum(added, dueAmtOf), bills: added.length },
    collectedToday: { amount: sum(got, c => c.amount), count: got.length }, overdueDays: automationOf(store.settings).dueDays };
}
/* The stock's value (Smart reorder's valuation), what isn't selling, and today's stock in and out at cost */
function stockFacts(k, now, profitToday){
  const inv = inventoryIntelligence({ now }), s = inv.summary, b = dayBounds(k, k);
  const received = D().ledger.filter(e => e.t >= b.from && e.t <= b.to && (e.type === "RESTOCK" || e.type === "OPENING") && e.q > 0 && e.cost != null).reduce((a, e) => a + e.q * e.cost, 0);
  const top = inv.products.filter(p => p.deadStockValue > 0).sort((a, b2) => b2.deadStockValue - a.deadStockValue).slice(0, 3).map(p => ({ id: p.id, name: p.name, value: p.deadStockValue }));
  return { value: s.inventoryValue, cost: s.inventoryCost, coverage: (s.marginCoverage == null ? 100 : s.marginCoverage) / 100,
    dead: { value: s.deadStockValue, products: s.deadStock, days: inv.config.deadDays, top }, today: { received: r2(received), sold: profitToday ? profitToday.cogs : 0 } };
}
/* Reconciliation: the latest cash close of the last week that didn't match (and the entries of exactly that amount), bills
   whose receipts don't add up, UPI checked only by hand, money received that isn't on a bill, money that lands nowhere */
const CLOSE_DAYS = 7;
function closeMatches(day, scope, diff){
  const b = dayBounds(day, day), a = Math.abs(paise(diff)), short = diff < 0, out = [];
  scopeTransactions(scope).filter(x => x.status === "posted" && x.t >= b.from && x.t <= b.to && paise(x.amount) === a).forEach(x => {
    const at = { saleId: x.saleId || null, no: x.billNo || "", time: hhmm(x.t), method: x.method };
    if(short){
      if(x.kind === "sale_receipt" && x.method === "cash") out.push({ kind: "cash_sale", ...at });
      else if(x.kind === "refund" && x.method !== "cash") out.push({ kind: "other_refund", ...at });
    }else{
      if(x.kind === "sale_receipt" && x.method !== "cash" && PAY_METHODS.includes(x.method)) out.push({ kind: "other_sale", ...at });
      else if(x.kind === "refund" && x.method === "cash") out.push({ kind: "cash_refund", ...at });
      else if(x.method === "cash" && x.dir === "out" && x.moveId) out.push({ kind: "cash_move", ...at, label: x.kind === "expense" ? "expense" : "cash out entry", reason: x.reason || "" });
    }
  });
  return out;
}
export function reconFacts(k){
  let close = null;
  for(let i = 0; i < CLOSE_DAYS && !close; i++){
    const day = addDays(k, -i);
    for(const scope of ["shop", store.dev]){
      const c = scope && closeOf(day, scope); if(!c) continue;
      const st = closeState(day, scope), diff = paise(c.diff) !== 0;
      if(!diff && !st.changed) continue;
      close = { dayLabel: i === 0 ? "today" : i === 1 ? "yesterday" : dayLong(day), scopeLabel: scope === "shop" ? "" : "this device", expected: c.expected, counted: c.counted,
        diff: diff ? c.diff : 0, changed: st.changed, expectedNow: st.expectedNow, matches: diff ? closeMatches(day, scope, c.diff) : [] };
      break;
    }
  }
  const from = addDays(k, -29), past = periodData(from, k, ""), t0 = dayBounds(from, k).from, bySale = {};
  shopTransactions("").forEach(x => { if(x.saleId) (bySale[x.saleId] = bySale[x.saleId] || []).push(x); });
  // bills saved with their payments (older bills kept only a payment label) whose receipts don't match what was due
  const bad = D().sales.filter(s => !s.void && s.t >= t0 && Array.isArray(s.payments)).map(s => ({ s, r: reconcileSale(s, bySale[s.id] || []) })).filter(x => !x.r.ok);
  const unv = past.live.filter(isUnverified), um = store.unmatched, open = (um || []).filter(I => !I.resolution || I.resolution === "open");
  const accts = bankAccounts().filter(a => a && a.active !== false), L = accts.length ? methodLanding() : {}, M = paymentSummary(past.live, past.rets).methods;
  return { close, bills: bad.slice(0, 3).map(x => ({ id: x.s.id, no: x.s.no || "Bill", due: x.r.due, received: x.r.received })), billCount: bad.length,
    upi: { count: unv.length, amount: sum(unv, s => sum(unverifiedPayments(s), p => p.amount)) },
    unmatched: { loaded: um != null, count: open.length, amount: sum(open, I => I.paidAmount), first: open[0] ? { amount: +open[0].amount || 0, paidAmount: +open[0].paidAmount || 0 } : null },
    landing: accts.length ? { upi: !L.upi && M.upi.in > 0, card: !L.card && M.card.in > 0 } : {} };
}

/* One part failing (an old record it can't read) leaves that figure out; the rest still shows */
function part(figure, f){ try{ return f(); }catch(e){ logger.event("home", "figure-failed", { op: figure, code: e && e.code }, "warn"); return null; } }
let memo = null;
// the records as they are now: D() is rebuilt (a new object) whenever a bill, return or stock record changes
const versionOf = (now, show) => [D(), Object.keys(store.cashMoves || {}).length, Object.keys(store.dayCloses || {}).length, Object.keys(store.collections || {}).length,
  Object.keys(store.moves || {}).length, Object.values(store.biz || {}).reduce((a, x) => a + Object.keys(x || {}).length, 0), store.unmatched, store.settings,
  Math.floor(now / 60000), !!show.profit, !!show.money, !!show.position];
/* Today's figures for this person: show { profit, money, position } (what they may see) →
   { comparison, figures: [{ key, label, value, sub, tone, unusual, headline, reasons, check? }], unusual: [key], summary } */
export function businessTodayView(now = Date.now(), show = {}){
  const v = versionOf(now, show);
  if(memo && memo.v.length === v.length && memo.v.every((x, i) => x === v[i])) return memo.out;
  const days = sameTimeDays(now), comparison = pickComparison(days), k = dayKey(now), T = days.today;
  const past = periodData(addDays(k, -30), addDays(k, -1), "");
  const facts = { comparison, ...salesFacts(now, days, comparison) };
  if(show.profit) facts.profit = part("profit", () => profitFacts(T, past));
  if(show.money){ facts.payments = part("payments", () => paymentFacts(k, T, past)); facts.recon = part("reconciliation", () => reconFacts(k)); }
  if(show.position){ facts.dues = part("receivables", () => duesFacts(k, now)); facts.stock = part("stock", () => stockFacts(k, now, facts.profit && facts.profit.today)); }
  const out = businessToday(facts, show);
  memo = { v, out };
  return out;
}
