// Business today: the day's money in one place, and WHY a figure is out of the ordinary.
//   sales against a meaningful comparison (a usual <weekday> by this time, else last <weekday>, else yesterday), bills, the
//   average bill, gross profit when cost prices cover enough of the sales, cash / UPI / card, what customers owe, the
//   stock's value and whether the money reconciles (the cash close, bills whose receipts don't add up, UPI checked only by
//   hand, money received that isn't on a bill, UPI or card money that lands in no bank account).
// Pure. It is handed figures the app already works out — the report summary and gross profit (sales-report.js), the books
// and the day close (domain/finance), customer credit, Smart reorder's stock valuation — and only compares and words
// them: nothing is calculated a second way and nothing is guessed. A reason is given only when the figures behind it are
// there, and it may name where to look: ref { target: bill | customer | product | report | reconcile | reorder |
// cashbook | bankbook | customers | banks, id }.
import { inr } from '../../shared/formatting/money.js';

/* How far a figure must move to be called unusual, and how much history a comparison needs */
export const THRESHOLDS = Object.freeze({
  sales: 20,          // % against the comparison
  avgBill: 25,        // %
  marginPts: 5,       // percentage points against the last 30 days
  mixPts: 25,         // percentage points of the money taken, one method against the last 30 days
  minBills: 3,        // bills the comparison needs (by this time) before today can be called unusual
  profitCoverage: 0.8,// gross profit shows only when cost prices are known for this share of the sales
  deadShare: 25,      // % of the stock (at selling price) not sold for a long time
  quietMinutes: 90,   // no bill for this long, when bills usually come in
});
const TH = THRESHOLDS;
const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const share = (a, b) => b ? Math.round(a / b * 100) : 0;
const r2 = x => Math.round(x * 100) / 100;
const one = x => { const v = Math.round(x * 10) / 10; return Number.isInteger(v) ? String(v) : v.toFixed(1); };
const plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + "s"}`;
const why = (id, text, ref) => ref ? { id, text, ref } : { id, text };
const METHOD = { cash: "Cash", upi: "UPI", card: "Card" };
/* What a reason's ref opens, in words (Home's buttons and the Agent's) */
export const REF_LABELS = Object.freeze({ bill: "Open bill", customer: "Open account", product: "Open product", report: "Reports", reconcile: "Reconcile",
  reorder: "Smart reorder", cashbook: "Cash book", bankbook: "Bank book", customers: "Customers", bills: "Bills", banks: "Bank accounts", pos: "Purchase orders", stock: "Stock" });

/* What today is compared with, by this time of day: a usual <weekday> (the same weekday of the last four weeks — those
   with sales, at least two of them), else last <weekday>, else yesterday.
   day: { k (yyyy-mm-dd), total, bills, avgBill, pieces, discounts } (the report summary of that day up to this time)
   → { kind: usual | lastweek | yesterday, label ("a usual Tuesday by this time"), when ("on a usual Tuesday"), short
       ("usually"), vs ("usual": a tile's "▼ 12% vs usual"), days, dayKeys (the days used), total, bills, avgBill, pieces,
       discounts } (per day) or null when there is nothing to compare with yet */
export function pickComparison({ weekdays = [], yesterday = null, weekday = "", whole = false } = {}){
  const by = whole ? "" : " by this time";   // whole: a whole day that is over (the morning briefing's yesterday)
  const of = (list, kind, label, when, short, vs) => {
    const n = list.length, sum = k => list.reduce((a, d) => a + (+d[k] || 0), 0), bills = sum("bills");
    return { kind, label, when, short, vs, days: n, dayKeys: list.map(d => d.k).filter(Boolean), total: r2(sum("total") / n), bills: Math.round(bills / n * 10) / 10,
      avgBill: bills ? r2(list.reduce((a, d) => a + (+d.avgBill || 0) * (+d.bills || 0), 0) / bills) : 0,
      pieces: Math.round(sum("pieces") / n * 10) / 10, discounts: r2(sum("discounts") / n) };
  };
  const open = (weekdays || []).filter(d => d && d.bills > 0);
  if(open.length >= 2) return of(open, "usual", `a usual ${weekday}${by}`, `on a usual ${weekday}`, "usually", "usual");
  if(weekdays && weekdays[0] && weekdays[0].bills > 0) return of([weekdays[0]], "lastweek", `last ${weekday}${by}`, `last ${weekday}`, `last ${weekday}`, `last ${weekday}`);
  if(yesterday && yesterday.bills > 0) return whole ? of([yesterday], "yesterday", "the day before", "the day before", "the day before", "the day before")
    : of([yesterday], "yesterday", "yesterday by this time", "yesterday", "yesterday", "yesterday");
  return null;
}

/* Sales. f: { today: { total, bills, avgBill, pieces, gross, returns, returnCount, discounts }, comparison,
   products: [{ id, name, today, usual }] (sales by product today and on the comparison day(s), up to this time),
   whole (a whole day that is over: the morning briefing's yesterday — no "so far", no quiet spell), dayWord ("yesterday"),
   lastBill: { t, time } | null, minutesSinceLastBill, usualBillsSince (bills the comparison has from the time of today's
   last bill to now), biggest: { id, no, total, customer } | null, cancelled: { count, value } } */
export function explainSales(f){
  const t = f.today, c = f.comparison, d = c ? pct(t.total, c.total) : null;
  const W = f.whole ? { soFar: "", byThis: "", day: f.dayWord || "yesterday", none: `No bills ${f.dayWord || "yesterday"}` } : { soFar: " so far", byThis: " by this time", day: "today", none: "No bills yet today" };
  // the tile says it short ("vs usual"); the card's line above the figures says what usual is
  const sub = d == null ? (t.bills ? "after returns" : "no bills yet") : d === 0 ? `same as ${c.vs}` : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}% vs ${c.vs}`;
  const out = { key: "sales", label: "Sales", value: t.total, sub, tone: !d ? "" : d > 0 ? "up" : "down", change: d, unusual: false, headline: "", reasons: [] };
  if(!c){
    out.headline = t.bills ? `${inr(t.total)} from ${plural(t.bills, "bill")}${W.soFar}. There is no earlier day to compare with yet.` : W.none + ".";
    return out;
  }
  const enough = c.bills >= TH.minBills;
  out.unusual = enough && d != null && Math.abs(d) >= TH.sales;
  out.headline = d == null ? `${inr(t.total)}${W.soFar}; ${c.when} there was nothing${W.byThis}.`
    : !enough && Math.abs(d) >= TH.sales ? `Sales are ${Math.abs(d)}% ${d > 0 ? "above" : "below"} ${c.label}, but that is only ${plural(Math.round(c.bills), "bill")} to compare with.`
    : out.unusual ? `Sales are ${Math.abs(d)}% ${d > 0 ? "above" : "below"} ${c.label}: ${inr(t.total)} against ${inr(c.total)}.`
    : `Sales are in line with ${c.label}: ${inr(t.total)} against ${inr(c.total)}.`;
  const down = (d || 0) < 0, R = [];
  // nothing coming in: no bill yet today, or none for a while when bills usually come in
  if(down && !t.bills && c.bills >= 2) R.push({ w: 9, r: why("quiet", `${W.none}; ${c.when} there are about ${one(c.bills)}${W.byThis}.`) });
  else if(down && !f.whole && f.lastBill && f.minutesSinceLastBill >= TH.quietMinutes && f.usualBillsSince >= 2)
    R.push({ w: 9, r: why("quiet", `No bill since ${f.lastBill.time}; ${c.when} about ${one(f.usualBillsSince)} bills come in between then and now.`) });
  // how many bills and how big: whichever moved the total more comes first
  const bd = pct(t.bills, c.bills), ad = c.avgBill && t.bills ? pct(t.avgBill, c.avgBill) : null;
  if(bd != null && Math.abs(bd) >= 15 && (t.bills > 0 || !R.length))
    R.push({ w: 5 + Math.abs((t.bills - c.bills) * c.avgBill) / Math.max(1, Math.abs(t.total - c.total)), r: why("bills", `${t.bills < c.bills ? "Fewer" : "More"} bills: ${t.bills}${W.soFar} against ${one(c.bills)} ${c.when}${W.byThis}.`) });
  if(ad != null && Math.abs(ad) >= 15)
    R.push({ w: 5 + Math.abs((t.avgBill - c.avgBill) * t.bills) / Math.max(1, Math.abs(t.total - c.total)), r: why("avg", `${t.avgBill < c.avgBill ? "Smaller" : "Bigger"} bills: ${inr(t.avgBill)} on average against ${inr(c.avgBill)} ${c.when}.`) });
  // which products made the difference
  const gap = Math.abs(t.total - c.total), movers = (f.products || []).map(p => ({ ...p, diff: r2((+p.today || 0) - (+p.usual || 0)) }))
    .filter(p => (down ? p.diff < 0 : p.diff > 0) && Math.abs(p.diff) >= Math.max(1, gap * 0.1)).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 2);
  if(d && movers.length) R.push({ w: 4, r: why("products", `Selling ${down ? "less" : "more"} than ${c.when}: ${movers.map(p => `${p.name} ${inr(p.today)} against ${inr(p.usual)}`).join(", ")}.`, { target: "product", id: movers[0].id }) });
  // one big bill
  if(!down && f.biggest && t.bills >= 2 && t.total > 0 && f.biggest.total >= 0.4 * t.total)
    R.push({ w: 8, r: why("big", `One bill is ${share(f.biggest.total, t.total)}% of ${W.day === "today" ? "today" : W.day + "'s sales"}: ${f.biggest.no}, ${inr(f.biggest.total)}${f.biggest.customer ? ` to ${f.biggest.customer}` : ""}.`, { target: "bill", id: f.biggest.id }) });
  // what came off: returns, cancelled bills
  if(t.returns > 0 && t.gross > 0 && t.returns >= 0.1 * t.gross)
    R.push({ w: down ? 6 : 2, r: why("returns", `${inr(t.returns)} came back in ${plural(t.returnCount || 1, "return")} ${W.day}, taken off sales.`, { target: "report", id: W.day === "today" ? "today" : "yesterday" }) });
  if(f.cancelled && f.cancelled.value > 0 && f.cancelled.value >= 0.1 * (t.total + f.cancelled.value))
    R.push({ w: down ? 6 : 1, r: why("cancelled", `${plural(f.cancelled.count, "bill")} cancelled ${W.day} (${inr(f.cancelled.value)}) ${f.cancelled.count === 1 ? "isn't" : "aren't"} counted.`, { target: "bills" }) });
  out.reasons = R.sort((a, b) => b.w - a.w).slice(0, 4).map(x => x.r);
  return out;
}

/* Bills: how many, with the pieces on them (no reasons of its own: Sales has them) */
export function explainBills(f){
  const t = f.today, c = f.comparison;
  return { key: "bills", label: "Bills", value: t.bills, sub: t.pieces ? plural(t.pieces, "piece") : c ? `${one(c.bills)} ${c.short}` : "", tone: "", unusual: false,
    headline: c ? `${plural(t.bills, "bill")} so far against ${one(c.bills)} ${c.when} by this time.` : `${plural(t.bills, "bill")} so far.`, reasons: [], opens: "sales" };
}

/* The average bill. f: as for Sales */
export function explainAverageBill(f){
  const t = f.today, c = f.comparison;
  const out = { key: "avgBill", label: "Average bill", value: t.bills ? t.avgBill : null, sub: c && c.avgBill ? `${inr(c.avgBill)} ${c.short}` : "per bill", tone: "", unusual: false, headline: "", reasons: [] };
  if(!c || !t.bills || !c.avgBill){ out.headline = t.bills ? `${inr(t.avgBill)} a bill on ${plural(t.bills, "bill")}.` : "No bills yet today."; return out; }
  const d = pct(t.avgBill, c.avgBill);
  out.change = d; out.tone = Math.abs(d) >= TH.avgBill ? (d > 0 ? "up" : "down") : "";
  out.unusual = t.bills >= TH.minBills && c.bills >= TH.minBills && Math.abs(d) >= TH.avgBill;
  out.headline = d === 0 ? `The average bill is the same as ${c.when}: ${inr(t.avgBill)}.` : `The average bill is ${Math.abs(d)}% ${d > 0 ? "higher" : "lower"} than ${c.when}: ${inr(t.avgBill)} against ${inr(c.avgBill)}.`;
  const R = [];
  const ppt = t.pieces / t.bills, ppc = c.bills ? c.pieces / c.bills : 0, pd = ppc ? pct(ppt, ppc) : null;
  if(pd != null && Math.abs(pd) >= 20) R.push(why("pieces", `${one(ppt)} ${one(ppt) === "1" ? "piece" : "pieces"} a bill against ${one(ppc)} ${c.when}.`));
  if(d > 0 && f.biggest && t.bills >= 2 && f.biggest.total >= 3 * c.avgBill){
    const without = (t.avgBill * t.bills - f.biggest.total) / (t.bills - 1);
    R.push(why("big", `${f.biggest.no} at ${inr(f.biggest.total)} lifts the average; without it the average bill is ${inr(Math.max(0, without))}.`, { target: "bill", id: f.biggest.id }));
  }
  const dt = (+t.discounts || 0) / t.bills, dc = c.bills ? (+c.discounts || 0) / c.bills : 0;
  if(d < 0 && dt - dc >= Math.max(1, 0.05 * c.avgBill)) R.push(why("discounts", `${inr(dt)} off each bill on average against ${inr(dc)} ${c.when}.`));
  out.reasons = R;
  return out;
}

/* Gross profit and margin. f.profit: { today: profitSummary of today's lines, usual: profitSummary of the 30 days before,
   discounts: { today, todayGross, usual, usualGross }, products: [{ id, name, rev, cost (null: unknown), q }] (today, by
   product), bills } */
export function explainMargin(f){
  const P = f.today, U = f.usual, cov = Math.round((P.coverage || 0) * 100), shown = !P.netSales || P.coverage >= TH.profitCoverage;
  const out = { key: "profit", label: "Gross profit", value: shown ? P.grossProfit : null,
    sub: shown ? (P.margin == null ? "sales less cost" : `${P.margin}% margin${P.complete ? "" : ` · cost known on ${cov}% of sales`}`) : `cost prices missing on ${100 - cov}% of sales`,
    tone: shown ? "" : "muted", unusual: false, headline: "", reasons: [] };
  const products = f.products || [], noCost = products.filter(p => p.cost == null && p.rev > 0).sort((a, b) => b.rev - a.rev);
  if(!shown){
    out.headline = `Gross profit isn't worked out: cost prices are missing on ${100 - cov}% of today's sales, and a guess would mislead.`;
    if(noCost.length) out.reasons.push(why("nocost", `No cost price: ${noCost.slice(0, 3).map(p => `${p.name} (${inr(p.rev)} of sales)`).join(", ")}. Add it on the product.`, { target: "product", id: noCost[0].id }));
    return out;
  }
  if(!P.netSales){ out.headline = "No sales yet today."; return out; }
  if(P.margin == null) return out;
  out.headline = `${inr(P.grossProfit)} gross profit at a ${P.margin}% margin.`;
  if(!U || U.margin == null || U.coverage < TH.profitCoverage){
    if(!P.complete) out.reasons.push(why("coverage", `Cost prices are missing on ${100 - cov}% of today's sales; the margin is on the rest.`, noCost[0] ? { target: "product", id: noCost[0].id } : null));
    return out;
  }
  const gap = Math.round((P.margin - U.margin) * 10) / 10;
  out.change = gap;
  out.tone = gap <= -TH.marginPts ? "down" : gap >= TH.marginPts ? "up" : "";
  out.unusual = Math.abs(gap) >= TH.marginPts && (f.bills || 0) >= 2;
  out.headline = Math.abs(gap) < 0.5 ? `A ${P.margin}% margin, as over the last 30 days.` : `The margin is ${P.margin}% today against ${U.margin}% over the last 30 days.`;
  const R = [], down = gap < 0;
  const D = f.discounts || {}, dT = D.todayGross ? Math.round(D.today / D.todayGross * 1000) / 10 : 0, dU = D.usualGross ? Math.round(D.usual / D.usualGross * 1000) / 10 : 0;
  if(down && dT - dU >= 3) R.push({ w: 6, r: why("discounts", `Discounts were ${dT}% of sales today (${inr(D.today)}) against ${dU}% over the last 30 days.`) });
  if(!down && dU - dT >= 3) R.push({ w: 6, r: why("discounts", `Fewer discounts: ${dT}% of sales today against ${dU}% over the last 30 days.`) });
  const below = products.filter(p => p.cost != null && p.q > 0 && p.rev < p.cost).sort((a, b) => (a.rev - a.cost) - (b.rev - b.cost));
  if(down && below.length) R.push({ w: 8, r: why("belowcost", `Sold below cost: ${below.slice(0, 2).map(p => `${p.name} (${inr(p.rev)} for what cost ${inr(p.cost)})`).join(", ")}.`, { target: "product", id: below[0].id }) });
  // the mix: a product that was a big part of today's sales at a margin far from the usual one
  const covered = P.covered || 0;
  const mix = covered > 0 ? products.filter(p => p.cost != null && p.rev > 0).map(p => { const m = (p.rev - p.cost) / p.rev * 100, s = p.rev / covered * 100; return { ...p, m: Math.round(m * 10) / 10, s: Math.round(s), effect: s / 100 * (m - U.margin) }; })
    .filter(p => down ? p.effect <= -2 : p.effect >= 2).sort((a, b) => down ? a.effect - b.effect : b.effect - a.effect) : [];
  if(mix.length && !(mix[0].rev < mix[0].cost && below.length)) R.push({ w: 5, r: why("mix", `${mix[0].name} was ${mix[0].s}% of today's sales at a ${mix[0].m}% margin.`, { target: "product", id: mix[0].id }) });
  if(!P.complete) R.push({ w: 1, r: why("coverage", `Cost prices are missing on ${100 - cov}% of today's sales; the margin is on the rest.`, noCost[0] ? { target: "product", id: noCost[0].id } : null) });
  out.reasons = R.sort((a, b) => b.w - a.w).map(x => x.r);
  return out;
}

/* Cash, UPI and card taken today. f.payments: { today: { cash, upi, card }, refunds: { cash, upi, card },
   usual: { cash, upi, card, bills } (the 30 days before), bills (today), drawer: { closing, opening, in, out } | null,
   close: { counted, diff } | null (today's close), unverified: { count, amount } (today's UPI checked by hand),
   count: { cash, upi, card } (payments today) } → the three figures, the method that moved most marked unusual */
export function explainPayments(f){
  const P = f.today || {}, U = f.usual, total = r2((P.cash || 0) + (P.upi || 0) + (P.card || 0));
  const sh = { cash: share(P.cash || 0, total), upi: share(P.upi || 0, total), card: share(P.card || 0, total) };
  const usualTotal = U ? (U.cash || 0) + (U.upi || 0) + (U.card || 0) : 0, us = U && usualTotal ? { cash: share(U.cash, usualTotal), upi: share(U.upi, usualTotal), card: share(U.card, usualTotal) } : null;
  let moved = null;
  if(us && total > 0 && (U.bills || 0) >= 20 && (f.bills || 0) >= 5){
    const m = ["cash", "upi", "card"].map(k => ({ k, d: sh[k] - us[k] })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    if(Math.abs(m.d) >= TH.mixPts) moved = m;
  }
  const refunds = f.refunds || {};
  const split = total > 0 ? why("split", `Cash ${inr(P.cash || 0)} (${sh.cash}%), UPI ${inr(P.upi || 0)} (${sh.upi}%), card ${inr(P.card || 0)} (${sh.card}%)${us ? `; over the last 30 days ${us.cash}%, ${us.upi}% and ${us.card}%` : ""}.`) : null;
  return ["cash", "upi", "card"].map(k => {
    const n = (f.count || {})[k] || 0;
    const out = { key: k, label: METHOD[k], value: P[k] || 0, sub: total ? `${sh[k]}% of money taken${moved && moved.k === k ? ` · usually ${us[k]}%` : ""}` : "nothing taken yet", tone: "", unusual: false, headline: "", reasons: [] };
    out.headline = total ? `${METHOD[k]}: ${inr(P[k] || 0)}${n ? ` on ${plural(n, "payment")}` : ""} today, ${sh[k]}% of the ${inr(total)} taken.` : `Nothing taken by ${k === "cash" ? "cash" : METHOD[k]} yet today.`;
    if(moved && moved.k === k){
      out.unusual = true; out.tone = "warn";
      out.headline = `${METHOD[k]} was ${sh[k]}% of the money taken today against ${us[k]}% over the last 30 days.`;
      if((k === "cash" && moved.d > 0) || (k !== "cash" && moved.d < 0)) out.check = "If customers paid by UPI or card, check that the QR code or card machine is working and that those payments are recorded as UPI or card, not cash.";
    }
    if(split) out.reasons.push(split);
    if(k === "cash" && f.drawer) out.reasons.push(why("drawer", `The drawer should hold ${inr(f.drawer.closing)} now: ${inr(f.drawer.opening)} at the start of the day, ${inr(f.drawer.in)} in, ${inr(f.drawer.out)} out.`, { target: "cashbook" }));
    if(k === "cash" && f.close) out.reasons.push(why("close", f.close.diff ? `Today's close: counted ${inr(f.close.counted)}, ${inr(Math.abs(f.close.diff))} ${f.close.diff < 0 ? "short" : "over"}.` : `Today's close: counted ${inr(f.close.counted)}, as expected.`, { target: "cashbook" }));
    if(k === "upi" && f.unverified && f.unverified.count) out.reasons.push(why("unverified", `${plural(f.unverified.count, "UPI payment")} today (${inr(f.unverified.amount)}) checked only by hand, not yet matched with the payment provider.`, { target: "reconcile", id: "30d" }));
    if(refunds[k] > 0) out.reasons.push(why("refunds", `${inr(refunds[k])} paid back by ${k === "cash" ? "cash" : METHOD[k]} on returns today.`, { target: "report", id: "today" }));
    return out;
  });
}

/* What customers owe. f.dues: { total, customers, rows: [{ id, name, amount }] (largest first), open: [{ saleId, no, id
   (customer), name, amount, days }] (bills still owed on, oldest first), addedToday: { amount, bills }, collectedToday:
   { amount, count }, overdueDays } */
export function explainReceivables(f){
  const D = f, days = D.overdueDays || 30, open = D.open || [], late = open.filter(b => b.days >= days), lateAmt = r2(late.reduce((a, b) => a + b.amount, 0));
  const out = { key: "receivables", label: "Customers owe", value: D.total || 0, sub: D.total ? plural(D.customers, "customer") : "nothing owed", tone: "", unusual: false, headline: "", reasons: [] };
  if(lateAmt > 0){ out.unusual = true; out.tone = "warn"; out.sub = `${inr(lateAmt)} over ${days} days`;
    out.headline = `${inr(lateAmt)} has been owed for more than ${plural(days, "day")}, on ${plural(late.length, "bill")}.`; }
  else out.headline = D.total ? `${inr(D.total)} owed by ${plural(D.customers, "customer")}; nothing has been owed for more than ${plural(days, "day")}.` : "No customer owes the shop anything.";
  const R = [], oldest = open[0];
  if(oldest) R.push(why("oldest", `Oldest: ${oldest.name} — ${inr(oldest.amount)} on ${oldest.no} from ${plural(oldest.days, "day")} ago.`, { target: "customer", id: oldest.id }));
  const top = (D.rows || [])[0];
  if(top && D.customers >= 2 && top.amount >= 0.5 * D.total) R.push(why("top", `${top.name} owes ${inr(top.amount)}, ${share(top.amount, D.total)}% of the total.`, { target: "customer", id: top.id }));
  const add = D.addedToday || {}, col = D.collectedToday || {};
  if(add.amount > 0 || col.amount > 0) R.push(why("today", `Today: ${add.amount > 0 ? `${inr(add.amount)} added on ${plural(add.bills, "bill")} sold on account` : "nothing new on account"}${col.amount > 0 ? `; ${inr(col.amount)} collected` : ""}.`, { target: "customers" }));
  out.reasons = R;
  return out;
}

/* The stock's value. f.stock: { value (at selling price), cost (at cost, where known), coverage (0–1: share of the value
   with a cost price), dead: { value, products, days, top: [{ id, name, value }] }, today: { received (at cost), sold (at
   cost) } } */
export function explainStock(f){
  const S = f, cov = Math.round((S.coverage || 0) * 100), atCost = (S.coverage || 0) >= TH.profitCoverage;
  const out = { key: "stock", label: "Stock value", value: atCost ? S.cost : S.value, sub: !S.value ? "nothing in stock" : atCost ? `at cost${cov < 100 ? ` · cost known on ${cov}%` : ""}` : `at selling price${cov ? ` · cost known on ${cov}%` : ""}`,
    tone: "", unusual: false, headline: "", reasons: [] };
  if(!S.value){ out.headline = "No stock on hand."; return out; }
  out.headline = atCost ? `${inr(S.cost)} in stock at cost (${inr(S.value)} at selling price).` : `${inr(S.value)} in stock at selling price; cost prices are known for only ${cov}% of it.`;
  const dead = S.dead || {}, ds = share(dead.value || 0, S.value);
  if(dead.value > 0 && ds >= TH.deadShare){ out.unusual = true; out.tone = "warn";
    out.headline = `${inr(dead.value)} of stock (${ds}% of it, at selling price) hasn't sold for ${plural(dead.days, "day")} or more.`; }
  const R = [];
  if(dead.value > 0 && (dead.top || []).length) R.push(why("dead", `Not selling: ${dead.top.slice(0, 3).map(p => `${p.name} (${inr(p.value)})`).join(", ")}${dead.products > 3 ? ` and ${dead.products - 3} more` : ""}.`, { target: "reorder" }));
  const T = S.today || {};
  if(T.received > 0 || T.sold > 0) R.push(why("today", `Today: ${T.received > 0 ? `${inr(T.received)} of stock received at cost` : "no stock received"}; ${inr(T.sold || 0)} sold at cost.`));
  if(cov < 100) R.push(why("coverage", `Cost prices are missing on ${100 - cov}% of the stock (by selling price)${atCost ? "; it is left out of the value at cost" : ""}.`));
  out.reasons = R;
  return out;
}

/* Does the money reconcile? f.recon: {
     close: { dayLabel, scopeLabel, expected, counted, diff, changed, expectedNow, matches: [{ kind, amount, no, saleId, time,
              method, label, reason }] } | null — the latest close of the last days with a difference, or changed since,
     bills: [{ id, no, due, received }] (bills whose receipts don't match what was due; last 30 days), billCount,
     upi: { count, amount } (UPI checked only by hand, last 30 days),
     unmatched: { loaded, count, amount, first: { amount, paidAmount } },
     landing: { upi, card } (true: that money was taken but lands in no bank account) } */
export function explainReconciliation(f){
  const R = [], C = f.close, at = C ? (C.dayLabel === "today" || C.dayLabel === "yesterday" ? `${C.dayLabel}'s close` : `the close on ${C.dayLabel}`) : "";
  let bad = false, amount = 0, issues = 0;
  if(C && C.diff){
    bad = true; issues++; amount += Math.abs(C.diff);
    const a = inr(Math.abs(C.diff)), short = C.diff < 0;
    R.push(why("close", `Cash was ${a} ${short ? "short" : "over"} at ${at}${C.scopeLabel ? ` (${C.scopeLabel})` : ""}: counted ${inr(C.counted)}, the books expected ${inr(C.expected)}.`, { target: "cashbook" }));
    (C.matches || []).slice(0, 2).forEach((m, i) => {
      const on = m.no ? ` on ${m.no}${m.time ? ` (${m.time})` : ""}` : "", ref = m.saleId ? { target: "bill", id: m.saleId } : { target: "cashbook" };
      const text = m.kind === "cash_sale" ? `${a} is exactly the cash${on}: check it was collected, or whether it was paid by UPI or card.`
        : m.kind === "other_refund" ? `${a} is exactly the ${METHOD[m.method] || m.method} refund${on}: check it wasn't paid from the drawer.`
        : m.kind === "other_sale" ? `${a} is exactly the ${METHOD[m.method] || m.method} payment${on}: check it wasn't paid in cash.`
        : m.kind === "cash_refund" ? `${a} is exactly the cash refund${on}: check it was paid back.`
        : m.kind === "cash_move" ? `${a} is exactly the ${m.label}${m.reason ? ` “${m.reason}”` : ""}: check it was taken from the drawer.`
        : `${a} matches an entry that day.`;
      R.push(why("match" + i, text, ref));
    });
    if(!(C.matches || []).length) R.push(why("nomatch", `No single bill or entry that day is exactly ${a}: look for cash ${short ? "taken out or paid back" : "taken in"} without an entry.`, { target: "cashbook" }));
  }
  if(C && C.changed){ issues++;
    R.push(why("changed", `Entries were added after ${at}: the drawer should now hold ${inr(C.expectedNow)}, not ${inr(C.expected)}. Close the day again.`, { target: "cashbook" })); }
  const B = f.bills || [];
  if(B.length){ issues += f.billCount || B.length; amount += B.reduce((a, b) => a + Math.abs((+b.due || 0) - (+b.received || 0)), 0);
    R.push(why("bills", `${plural(f.billCount || B.length, "bill")} where what was received doesn't match what was due: ${B.slice(0, 3).map(b => `${b.no} (${inr(b.due)} due, ${inr(b.received)} received)`).join(", ")}.`, { target: "bill", id: B[0].id })); }
  const U = f.upi || {};
  if(U.count){ issues += U.count; amount += U.amount || 0;
    R.push(why("upi", `${plural(U.count, "UPI payment")} (${inr(U.amount)}) checked only by hand in the last 30 days, not yet matched with the payment provider.`, { target: "reconcile", id: "30d" })); }
  const M = f.unmatched || {};
  if(M.loaded && M.count){ bad = true; issues += M.count; amount += M.amount || 0;
    const x = M.first, detail = x ? (x.paidAmount !== x.amount ? ` — ${inr(x.paidAmount)} paid where ${inr(x.amount)} was asked` : " — paid after the QR or link was closed") : "";
    R.push(why("unmatched", `${plural(M.count, "payment")} (${inr(M.amount)}) received that ${M.count === 1 ? "isn't" : "aren't"} on any bill${detail}. Refund it or add it to a bill.`, { target: "reconcile", id: "30d" })); }
  const L = f.landing || {}, lost = ["upi", "card"].filter(k => L[k]);
  if(lost.length) R.push(why("landing", `${lost.map(k => METHOD[k]).join(" and ")} money isn't linked to a bank account, so bank balances leave it out.`, { target: "banks" }));
  const out = { key: "reconciliation", label: "Reconciliation", value: r2(amount), count: issues, display: issues ? `${issues} to check` : "All matched",
    sub: issues ? `${inr(r2(amount))} involved` : lost.length ? "bank accounts not linked" : "cash, UPI and card agree", tone: issues ? (bad ? "bad" : "warn") : "ok",
    unusual: issues > 0, headline: "", reasons: R };
  out.headline = issues ? `${plural(issues, "thing")} to check before the money reconciles.` : lost.length ? "Cash, UPI and card agree, but some money lands in no bank account." : "Cash, UPI and card reconcile: closes match, receipts match their bills and every UPI payment is verified.";
  return out;
}

/* Everything, in the order the card shows it. facts: { comparison inputs (weekdays, yesterday, weekday) or comparison,
   sales facts (today, products, lastBill, …), profit, payments, dues, stock, recon }; show: { profit, money, position }
   (what this person sees). → { comparison, figures: [figure], unusual: [key] (worst first), summary } */
const PRIORITY = { reconciliation: 0, sales: 1, profit: 2, cash: 3, upi: 3, card: 3, receivables: 4, stock: 5, avgBill: 6, bills: 7 };
export function businessToday(facts, show = {}){
  const comparison = facts.comparison !== undefined ? facts.comparison : pickComparison(facts);
  const S = { ...facts, comparison }, figures = [explainSales(S), explainBills(S), explainAverageBill(S)];
  if(show.profit && facts.profit) figures.push(explainMargin({ ...facts.profit, bills: S.today.bills }));
  if(show.money && facts.payments) figures.push(...explainPayments({ ...facts.payments, bills: S.today.bills }));
  if(show.position && facts.dues) figures.push(explainReceivables(facts.dues));
  if(show.position && facts.stock) figures.push(explainStock(facts.stock));
  if(show.money && facts.recon) figures.push(explainReconciliation(facts.recon));
  const unusual = figures.filter(x => x.unusual).sort((a, b) => (a.tone === "bad" ? -1 : 0) - (b.tone === "bad" ? -1 : 0) || PRIORITY[a.key] - PRIORITY[b.key]).map(x => x.key);
  const byKey = Object.fromEntries(figures.map(x => [x.key, x]));
  const summary = unusual.length ? `${plural(unusual.length, "thing")} out of the ordinary today: ${unusual.map(k => byKey[k].headline.replace(/\.$/, "")).join("; ")}.`
    : `Nothing out of the ordinary today${comparison ? ` against ${comparison.label}` : ""}.`;
  return { comparison, figures, unusual, summary };
}
