// The owner's morning briefing: yesterday and what needs doing, in a few lines, from the shop's own records —
//   yesterday   sales against a usual <weekday> and why (Business today's explanation, for a whole day), the last 7 days
//               against the 7 before, the best seller
//   products    sold out with recent sales, running out within days, demand rising, batches expiring, money in stock that
//               isn't selling
//   customers   payments overdue (owed longer than the shop's reminder days), oldest first
//   purchases   purchase orders expected (late first, then due today, then the rest)
//   money       whether yesterday's money reconciled (the cash close, UPI to verify, payments on no bill …)
//   first       ONE recommendation: the most pressing of the above, with where to act on it
// Pure. Nothing is guessed or padded: every line comes from a figure handed in; a part with nothing in it is left out, and
// a quiet day says so.
import { inr } from '../../shared/formatting/money.js';
import { explainReconciliation, explainSales, pickComparison } from './business-today.js';

const plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + "s"}`;
const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const line = (id, text, ref) => ref ? { id, text, ref } : { id, text };
const TREND_PTS = 15;   // the week moved this much (%) to be worth a word

/* f: {
     dayLabel ("Monday, 6 October"), weekday ("Monday"),
     yesterday: { total, bills, avgBill, pieces, gross, returns, returnCount, discounts }, weekdays: [the same four, full days]
       (the same weekday of the last four weeks, latest first), dayBefore: the same, products: [{ id, name, today, usual }],
       biggest, cancelled (as Business today's sales facts),
     week: { total, prev } (the last 7 days to yesterday, and the 7 before), best: { id, name, q, amount } | null,
     stock: { soldOut: [{ id, name, sold }] (sold in the last 7 days), runningOut: [{ id, name, days, qty, unit }],
              rising: [{ id, name, days, trend }], expiring: [{ name, batch, days }], dead: { value, products, days } },
     dues: { overdueDays, open: [{ id, name, amount, days, no }] } (bills still owed on, oldest first),
     pos: [{ id, no, supplier, value, expected (dd Mon | ""), late (days late, 0 = due today, null = no date) }],
     recon: Business today's reconciliation facts }
   → { title, sections: [{ key, title, lines: [{ id, text, ref? }] }], first: { text, ref? }, quiet, text (to share) } */
export function dailyBriefing(f){
  const sections = [], add = (key, title, lines) => { const L = lines.filter(Boolean); if(L.length) sections.push({ key, title, lines: L }); };

  // yesterday: the sales and why, the week, the best seller
  const comparison = pickComparison({ weekdays: f.weekdays || [], yesterday: f.dayBefore || null, weekday: f.weekday || "", whole: true });
  const S = explainSales({ whole: true, dayWord: "yesterday", today: f.yesterday || { total: 0, bills: 0 }, comparison, products: f.products || [], biggest: f.biggest || null, cancelled: f.cancelled || null });
  const W = f.week || {}, wd = pct(W.total || 0, W.prev || 0);
  add("yesterday", "Yesterday", [
    line("sales", (f.yesterday && f.yesterday.bills) ? S.headline : "No bills yesterday.", { target: "report", id: "yesterday" }),
    ...S.reasons.slice(0, 2).map((r, i) => line("why" + i, r.text, r.ref)),
    W.total > 0 && wd != null && Math.abs(wd) >= TREND_PTS ? line("week", `The last 7 days: ${inr(W.total)}, ${Math.abs(wd)}% ${wd > 0 ? "up on" : "down on"} the 7 days before.`, { target: "report", id: "7d" })
      : W.total > 0 ? line("week", `The last 7 days: ${inr(W.total)}${wd == null ? "" : `, about the same as the 7 days before`}.`, { target: "report", id: "7d" }) : null,
    f.best && f.best.q >= 2 ? line("best", `Best seller yesterday: ${f.best.name}, ${f.best.q} sold for ${inr(f.best.amount)}.`, { target: "product", id: f.best.id }) : null,
  ]);

  // products that need attention
  const P = f.stock || {}, smart = { target: "reorder", id: "smart" };
  add("products", "Products", [
    (P.soldOut || []).length ? line("soldout", `Sold out but selling: ${P.soldOut.slice(0, 3).map(p => `${p.name} (${p.sold} sold this week)`).join(", ")}${P.soldOut.length > 3 ? ` and ${P.soldOut.length - 3} more` : ""}.`, smart) : null,
    (P.runningOut || []).length ? line("running", `Running out: ${P.runningOut.slice(0, 3).map(p => `${p.name} (about ${plural(p.days, "day")} left)`).join(", ")}.`, smart) : null,
    (P.rising || []).length ? line("rising", `Demand rising: ${P.rising.slice(0, 2).map(p => `${p.name} (up ${p.trend}%)`).join(", ")} — order sooner than usual.`, smart) : null,
    (P.expiring || []).length ? line("expiring", `Expiring: ${P.expiring.slice(0, 3).map(b => `${b.name} batch ${b.batch} (${b.days <= 0 ? "expired" : `in ${plural(b.days, "day")}`})`).join(", ")}.`, { target: "stock" }) : null,
    P.dead && P.dead.value > 0 ? line("dead", `${inr(P.dead.value)} is in ${plural(P.dead.products, "product")} with no sale for ${P.dead.days}+ days.`, smart) : null,
  ]);

  // customers to collect from
  const D = f.dues || {}, days = D.overdueDays || 30, late = (D.open || []).filter(b => b.days >= days), lateTotal = late.reduce((a, b) => a + b.amount, 0);
  const byCust = {}; late.forEach(b => { const o = byCust[b.id] || (byCust[b.id] = { id: b.id, name: b.name, amount: 0, days: 0 }); o.amount += b.amount; o.days = Math.max(o.days, b.days); });
  const owe = Object.values(byCust).sort((a, b) => b.days - a.days || b.amount - a.amount);
  add("dues", "Payments overdue", owe.length ? [
    line("total", `${inr(lateTotal)} owed for more than ${plural(days, "day")} by ${plural(owe.length, "customer")}.`, { target: "customers" }),
    ...owe.slice(0, 3).map((c, i) => line("c" + i, `${c.name}: ${inr(c.amount)}, the oldest ${plural(c.days, "day")} ago.`, { target: "customer", id: c.id })),
  ] : []);

  // purchase orders expected
  const POS = (f.pos || []).slice().sort((a, b) => (b.late == null ? -1e9 : b.late) - (a.late == null ? -1e9 : a.late));
  add("pos", "Purchase orders expected", POS.slice(0, 3).map((o, i) => line("po" + i,
    `${o.no} from ${o.supplier}${o.value ? ` (${inr(o.value)})` : ""}: ${o.late == null ? "no date given" : o.late > 0 ? `${plural(o.late, "day")} late (was due ${o.expected})` : o.late === 0 ? "due today" : `due ${o.expected}`}.`,
    { target: "pos" })).concat(POS.length > 3 ? [line("more", `${POS.length - 3} more on order.`, { target: "pos" })] : []));

  // the money
  const R = f.recon ? explainReconciliation(f.recon) : null;
  if(R) add("money", "Money", R.count ? [line("recon", R.headline, { target: "reconcile", id: "30d" }), ...R.reasons.slice(0, 2).map((r, i) => line("r" + i, r.text, r.ref))]
    : [line("recon", R.headline)]);

  // first: the most pressing, in this order — money that doesn't add up, lost sales, overdue payments, late deliveries, a
  // falling week, stock not selling
  const C = f.recon && f.recon.close && f.recon.close.diff ? f.recon.close : null, unmatched = f.recon && f.recon.unmatched && f.recon.unmatched.count;
  let first = null;
  if(C) first = { text: `Check the cash: it was ${inr(Math.abs(C.diff))} ${C.diff < 0 ? "short" : "over"} at ${C.dayLabel === "today" || C.dayLabel === "yesterday" ? C.dayLabel + "'s close" : "the close on " + C.dayLabel}.`, ref: { target: "cashbook" } };
  else if(unmatched) first = { text: `Resolve ${plural(f.recon.unmatched.count, "payment")} received that ${f.recon.unmatched.count === 1 ? "isn't" : "aren't"} on any bill (${inr(f.recon.unmatched.amount)}): refund or add to a bill.`, ref: { target: "reconcile", id: "30d" } };
  else if((P.soldOut || []).length) first = { text: `Reorder ${P.soldOut[0].name}: sold out, and ${P.soldOut[0].sold} sold in the last 7 days.`, ref: smart };
  else if(owe.length) first = { text: `Collect ${inr(owe[0].amount)} from ${owe[0].name}: owed for ${plural(owe[0].days, "day")}.`, ref: { target: "customer", id: owe[0].id } };
  else if(POS.length && POS[0].late > 0) first = { text: `Chase ${POS[0].supplier}: ${POS[0].no} is ${plural(POS[0].late, "day")} late.`, ref: { target: "pos" } };
  else if((P.runningOut || []).length) first = { text: `Order ${P.runningOut[0].name} today: about ${plural(P.runningOut[0].days, "day")} of stock left.`, ref: smart };
  else if(W.total > 0 && wd != null && wd <= -TREND_PTS) first = { text: `Sales are down ${-wd}% on the week before: see which products and days in Reports.`, ref: { target: "report", id: "7d" } };
  else if(P.dead && P.dead.value > 0) first = { text: `${inr(P.dead.value)} of stock isn't selling: a sale on the slowest of it would free money.`, ref: smart };
  const quiet = !first;
  if(!first) first = { text: "Nothing needs you first thing: no money to check, nothing sold out, nothing overdue." };

  const title = `Your morning briefing${f.dayLabel ? ` · ${f.dayLabel}` : ""}`;
  const text = [title, "", `First: ${first.text}`, ...sections.flatMap(s => ["", `${s.title}:`, ...s.lines.map(l => `• ${l.text}`)])].join("\n");
  return { title, sections, first, quiet, text };
}
