// What a customer's own bills say about them, in plain words — for serving them well, not for watching them. From the
// shop's records only (their bills, returns and account); nothing is guessed, and a line appears only when there is
// enough history behind it:
//   summary   total purchases (and what came back), bills, the average bill, what they owe (and since when), the first and
//             the last purchase
//   products  what they buy most: how many, how much, on how many bills, when last
//   payments  how they pay (cash, UPI, card, gift voucher, on account) and, for what they took on account, how long they
//             usually take to pay
//   insights  how often they come (and whether it has been longer than usual), favourites, the size they usually take,
//             what they buy together, returns, an old due against their usual time to pay, where they stand among the
//             shop's customers — each marked "serve" (helps whoever serves them) or "money" (for those who see money)
// Pure; rupees, added up in paise.
import { inr } from '../../shared/formatting/money.js';

const DAY = 864e5;
const r2 = x => Math.round(x * 100) / 100;
const plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + "s"}`;
const median = list => { if(!list.length) return null; const s = list.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmtQ = q => String(Math.round(q * 1000) / 1000);
export const METHOD_LABELS = Object.freeze({ cash: "Cash", upi: "UPI", card: "Card", voucher: "Gift voucher", due: "On account" });

/* How long each amount taken on account took to be paid off (collections and refunds to the account pay the oldest first).
   entries: the account's, oldest first: { t, charge, credit } → { paid: [days], open: [{ t, amount }] } */
export function daysToPay(entries){
  const queue = [], paid = [];
  (entries || []).forEach(e => {
    if(e.charge > 0) queue.push({ t: e.t, left: Math.round(e.charge * 100) });
    let c = Math.round((e.credit || 0) * 100);
    while(c > 0 && queue.length){ const q = queue[0], use = Math.min(c, q.left); q.left -= use; c -= use; if(q.left === 0){ paid.push(Math.max(0, (e.t - q.t) / DAY)); queue.shift(); } }
  });
  return { paid, open: queue.map(q => ({ t: q.t, amount: q.left / 100 })) };
}

/* input: {
     bills: [{ id, no, t, total (less an exchange's credit), lines: [{ pid, name, size, q, amt }], payments: [{ method, amount }], due }]
            (cancelled bills left out), newest or oldest first
     returns: [{ t, saleId, pieces, value, lines: [{ pid, name, q }] }]
     account: { purchases, paid, outstanding, entries (newest first, as customerAccount gives them) }
     peers: [total purchases of every customer with purchases] (for where they stand), now }
   → { summary, products, payments, insights } */
export function customerInsight({ bills = [], returns = [], account = null, peers = [], now = Date.now() } = {}){
  const B = bills.slice().sort((a, b) => a.t - b.t), A = account || { purchases: 0, paid: 0, outstanding: 0, entries: [] };
  const returned = r2(returns.reduce((a, r) => a + (+r.value || 0), 0)), purchases = r2(B.reduce((a, b) => a + (+b.total || 0), 0));
  const last = B.length ? B[B.length - 1].t : 0, first = B.length ? B[0].t : 0;
  const pay = daysToPay(A.entries.slice().reverse()), oldest = pay.open.length ? pay.open[0] : null;
  const summary = { purchases, returned, net: r2(purchases - returned), bills: B.length, avgBill: B.length ? r2(purchases / B.length) : 0, outstanding: A.outstanding || 0,
    oldestDueDays: oldest ? Math.floor((now - oldest.t) / DAY) : null, first, last, daysSinceLast: last ? Math.floor((now - last) / DAY) : null };

  // what they buy: by product, net of returns; on how many bills; when last
  const P = {};
  B.forEach(b => { const seen = new Set(); (b.lines || []).forEach(l => { const o = P[l.pid] || (P[l.pid] = { id: l.pid, name: l.name, q: 0, amount: 0, bills: 0, last: 0 });
    o.q += +l.q || 0; o.amount += +l.amt || 0; o.last = Math.max(o.last, b.t); if(!seen.has(l.pid)){ seen.add(l.pid); o.bills++; } }); });
  returns.forEach(r => (r.lines || []).forEach(l => { const o = P[l.pid]; if(o){ o.q -= +l.q || 0; o.amount -= +l.amt || 0; } }));
  const products = Object.values(P).map(p => ({ ...p, q: Math.round(p.q * 1000) / 1000, amount: r2(p.amount) })).filter(p => p.q > 0)
    .sort((a, b) => b.bills - a.bills || b.q - a.q || b.amount - a.amount || a.name.localeCompare(b.name));

  // how they pay
  const M = {}, add = (k, v) => { if(!(v > 0)) return; const o = M[k] || (M[k] = { key: k, label: METHOD_LABELS[k] || k, amount: 0, count: 0 }); o.amount += v; o.count++; };
  B.forEach(b => { (b.payments || []).forEach(p => add(p.method, +p.amount || 0)); add("due", +b.due || 0); });
  const mTotal = Object.values(M).reduce((a, m) => a + m.amount, 0);
  const methods = Object.values(M).map(m => ({ ...m, amount: r2(m.amount), share: mTotal ? Math.round(m.amount / mTotal * 100) : 0 })).sort((a, b) => b.amount - a.amount);
  const usualPay = median(pay.paid);
  const payments = { methods, paid: A.paid || 0, onAccount: { bills: B.filter(b => b.due > 0).length, amount: r2(B.reduce((a, b) => a + (+b.due || 0), 0)), paidOff: pay.paid.length,
    usualDays: usualPay == null ? null : Math.round(usualPay) } };

  // what the bills show
  const insights = [], say = (id, kind, text, ref) => insights.push(ref ? { id, kind, text, ref } : { id, kind, text });
  const days = [...new Set(B.map(b => new Date(b.t).toDateString()))].map(d => +new Date(d)).sort((a, b) => a - b);
  if(days.length >= 3){
    const gap = Math.round(median(days.slice(1).map((d, i) => (d - days[i]) / DAY)));
    if(gap >= 1){
      const since = summary.daysSinceLast;
      if(since > Math.max(2 * gap, gap + 14)) say("rhythm", "serve", `Usually comes about every ${plural(gap, "day")}; the last visit was ${plural(since, "day")} ago — longer than usual.`);
      else say("rhythm", "serve", `Comes about every ${plural(gap, "day")}${since != null ? ` (last visit ${since === 0 ? "today" : since === 1 ? "yesterday" : plural(since, "day") + " ago"})` : ""}.`);
    }
  }
  const fav = products.find(p => p.bills >= 2);
  if(fav){ const perBill = fav.q / fav.bills;
    say("favourite", "serve", B.length >= 3 && fav.bills / B.length >= 0.5 ? `Buys ${fav.name} on most visits (${fav.bills} of ${B.length} bills)${perBill >= 1.5 ? `, usually ${fmtQ(Math.round(perBill))} at a time` : ""}.`
      : `Has bought ${fav.name} on ${plural(fav.bills, "bill")}.`, { target: "product", id: fav.id }); }
  const sizes = {}; let sized = 0;
  B.forEach(b => (b.lines || []).forEach(l => { if(l.size){ sizes[l.size] = (sizes[l.size] || 0) + (+l.q || 0); sized += +l.q || 0; } }));
  const topSize = Object.entries(sizes).sort((a, b) => b[1] - a[1])[0];
  if(topSize && sized >= 3 && topSize[1] / sized >= 0.6) say("size", "serve", `Usually takes size ${topSize[0]} (${fmtQ(topSize[1])} of ${fmtQ(sized)} pieces).`);
  const pairs = {};
  B.forEach(b => { const ids = [...new Set((b.lines || []).map(l => l.pid))].sort(); for(let i = 0; i < ids.length; i++) for(let j = i + 1; j < ids.length; j++){ const k = ids[i] + "|" + ids[j]; pairs[k] = (pairs[k] || 0) + 1; } });
  const pair = Object.entries(pairs).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  if(pair){ const [x, y] = pair[0].split("|").map(id => P[id]).sort((a, b) => (b ? b.bills : 0) - (a ? a.bills : 0));   // the one bought more often first
    if(x && y) say("together", "serve", `Often buys ${x.name} with ${y.name} (${plural(pair[1], "bill")}).`); }
  const boughtPieces = B.reduce((a, b) => a + (b.lines || []).reduce((c, l) => c + (+l.q || 0), 0), 0), backPieces = returns.reduce((a, r) => a + (+r.pieces || 0), 0);
  if(backPieces >= 2 && boughtPieces > 0 && backPieces / boughtPieces >= 0.2){ const lastRet = returns.slice().sort((a, b) => b.t - a.t)[0], what = lastRet && (lastRet.lines || [])[0];
    say("returns", "money", `Returned ${fmtQ(backPieces)} of ${fmtQ(boughtPieces)} pieces bought (${Math.round(backPieces / boughtPieces * 100)}%)${what ? `, most recently ${what.name}` : ""}.`); }
  if(summary.outstanding > 0 && oldest){
    const age = summary.oldestDueDays, usual = payments.onAccount.usualDays;
    say("due", "money", `Owes ${inr(summary.outstanding)}, the oldest part from ${age === 0 ? "today" : plural(age, "day") + " ago"}${usual != null && payments.onAccount.paidOff >= 2 ? (age > Math.max(2 * usual, usual + 7) ? ` — longer than the ${plural(usual, "day")} they usually take to pay` : `; they usually pay within ${plural(usual, "day")}`) : ""}.`);
  }else if(payments.onAccount.paidOff >= 2 && usualPay != null) say("paysback", "money", `Has paid off ${plural(payments.onAccount.paidOff, "bill")} on account, usually within ${plural(Math.round(usualPay), "day")}.`);
  const others = (peers || []).filter(v => v > 0);
  if(others.length >= 10 && summary.net > 0){ const below = others.filter(v => v < summary.net).length, top = Math.max(1, Math.ceil((1 - below / others.length) * 100));
    if(top <= 20) say("standing", "money", `Among your top ${top <= 5 ? 5 : top <= 10 ? 10 : 20}% of customers by purchases.`); }
  return { summary, products, payments, insights };
}
