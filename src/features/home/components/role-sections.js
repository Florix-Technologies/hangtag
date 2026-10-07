// Home's sections by role (domain/shop/role-workspace.js HOME_SECTIONS): what each role's day is about, brought forward.
//   owner    GST (this month so far; last month's return, prepared or when it is due), bank and cash (the drawer, the
//            accounts, UPI and card today), the team today (who sold what, who hasn't yet)
//   manager  orders (to deliver, late, quotations waiting), purchases (to receive, suppliers to pay, received today),
//            stock (sold out, running low, to reorder, not selling)
//   cashier  my shift (my bills, the money I took, this till's drawer), held bills (to recall)
//   server   the tables now (ready to serve, asking for the bill, waiting on the kitchen)
// Every figure comes from the calculations the app already uses (the business query, the books, Smart reorder, the watch
// rules, the restaurant's table states); nothing here changes a record — each line links to where the work is done.
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { UI_ICON } from '../../../shared/ui/kit.js';
import { inr } from '../../../shared/formatting/money.js';
import { agoText, dayKey, dayLab, fmtDate, hhmm, pad } from '../../../shared/formatting/dates.js';
import { bankBook } from '../../../domain/finance/books.js';
import { paymentSummary } from '../../../domain/reports/sales-report.js';
import { ROLE_LABELS } from '../../../domain/shop/permissions.js';
import { D } from '../../inventory/services/ledger.js';
import { stockAlerts } from '../../inventory/services/alerts.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';
import { periodData, kstats } from '../../reports/services/report-data.js';
import { createReadOnlyBusinessQuery } from '../../assistant/services/business-query.js';
import { dayBounds, shopTransactions } from '../../finance/services/books-data.js';
import { closeOf, dayCash } from '../../finance/use-cases/cash-moves.js';
import { accountBalances } from '../../finance/use-cases/bank-accounts.js';
import { lateOrders } from '../../automation/services/watchers.js';
import { listHeldCarts } from '../../orders/use-cases/held-carts.js';
import { billTotals } from '../../sales/services/totals.js';
import { kitchenOn, tableStateOf, tablesList, tablesOn } from '../../restaurant/services/restaurant-state.js';
import { can, canAny, userId, userLabel } from '../../shop/services/access.js';
import { moduleShown, subviewsOf } from '../../shop/services/modules.js';
import { shopRegion } from '../../shop/services/region.js';
import { refreshTeamRoster, teamRoster } from '../../shop/services/team-roster.js';

const plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + "s"}`;
const card = (cls, title, link, body, aria) => `<section class="card hcard ${cls}" aria-label="${esc(aria || title)}"><div class="card-h"><h3>${esc(title)}</h3>${link || ""}</div>${body}</section>`;
const linkTo = (attr, label) => `<button class="link xs" type="button" ${attr}>${esc(label)} ${UI_ICON.chevron}</button>`;
/* a line: what, the figure, a note; a button when it opens somewhere */
const line = (what, value, note, attr, tone) => { const inner = `<span class="hl-w">${esc(what)}</span><b class="hl-v">${value}</b>${note ? `<small class="hl-n">${esc(note)}</small>` : ""}`;
  return attr ? `<button type="button" class="hline${tone ? " " + tone : ""}" ${attr}>${inner}${UI_ICON.chevron}</button>` : `<div class="hline${tone ? " " + tone : ""}">${inner}</div>`; };
const lines = list => `<div class="hlines">${list.filter(Boolean).join("")}</div>`;

/* ---------- the owner: GST, bank and cash, the team today ---------- */
function gstCardHTML(now){
  if(!(can("view_reports") && moduleShown("report") && store.settings && store.settings.taxOn && shopRegion().tax === "gst")) return "";
  const q = createReadOnlyBusinessQuery({ now: () => now }), M = q.gst("month"), L = q.gst("lastmonth"), d = new Date(now);
  const last = new Date(d.getFullYear(), d.getMonth() - 1, 1), key = `${last.getFullYear()}-${pad(last.getMonth() + 1)}`, name = fmtDate(last, { month: "long" });
  const done = (store.settings.gstExports || []).some(x => x.period === key), due = n => dayLab(dayKey(new Date(d.getFullYear(), d.getMonth(), n)));
  const late = !done && L.taxable > 0 && d.getDate() > 11;
  const body = lines([
    line("This month so far", inr(M.gst), `on ${inr(M.taxable)} of taxable sales`),
    line(name, inr(L.gst), done ? "Prepared" : L.taxable > 0 ? `${late ? "GSTR-1 was due" : "GSTR-1 due"} ${due(11)} · GSTR-3B ${due(20)}` : "No sales to file", null, done ? "ok" : late ? "bad" : L.taxable > 0 ? "warn" : ""),
  ]) + (!done && L.taxable > 0 ? `<div class="hacts"><button type="button" class="btn sm" data-act="gstview" data-gstmonth="${esc(key)}">Prepare ${esc(name)}</button></div>` : "");
  return card("hgst", "GST", linkTo('data-reportgo="month"', "Reports"), body);
}
function bankCardHTML(now){
  if(!can("view_reports")) return "";
  const k = dayKey(now), drawer = dayCash(k, "shop"), B = accountBalances(), rows = B.rows.filter(r => r.account.active !== false);
  const bb = bankBook(shopTransactions(""), dayBounds(k, k)), today = Math.round(((bb.upiIn || 0) + (bb.cardIn || 0)) * 100) / 100;
  const body = lines([
    line("Cash in the drawer", inr(drawer.closing), closeOf(k, "shop") ? "closed today" : "the books, now", 'data-agentopen="cashbook|"'),
    ...rows.slice(0, 3).map(r => line(r.account.name || "Bank account", inr(r.balance), "", 'data-agentopen="bankbook|"')),
    rows.length > 3 ? line(`${rows.length - 3} more ${rows.length - 3 === 1 ? "account" : "accounts"}`, inr(B.total - rows.slice(0, 3).reduce((a, r) => a + r.balance, 0)), "", 'data-agentopen="bankbook|"') : "",
    line("UPI and card today", inr(today), bb.upiUnverified > 0 ? `${inr(bb.upiUnverified)} UPI to verify` : "", bb.upiUnverified > 0 ? 'data-reportgo="30d|reconcileCard"' : "", bb.upiUnverified > 0 ? "warn" : ""),
  ]) + (rows.length ? "" : `<p class="note hnote">Add your bank accounts to see their balances here.${can("manage_settings") ? ` <button type="button" class="link xs" data-setgo="payments">Bank accounts</button>` : ""}</p>`);
  return card("hbank", "Bank & cash", linkTo('data-agentopen="bankbook|"', "Bank book"), body);
}
function teamCardHTML(now, rerender){
  if(!can("manage_users")) return "";   // the owner's
  refreshTeamRoster(rerender);
  const k = dayKey(now), me = userId(), R = teamRoster(), by = {};
  periodData(k, k, "").live.filter(s => (s.kind || "sale") !== "exchange").forEach(s => {
    const id = s.user || "", o = by[id] || (by[id] = { id, bills: 0, sales: 0, cash: 0, last: 0 });
    o.bills++; o.sales += +s.total || 0; o.last = Math.max(o.last, s.t);
    o.cash += paymentSummary([s], []).methods.cash.in;
  });
  const people = Object.values(by), known = id => id === me || !!(R[id] && R[id].name);
  const others = people.filter(p => p.id !== me);
  if(!others.length && !Object.keys(R).length) return "";   // no team: nothing to show
  const named = people.filter(p => known(p.id)), unnamed = people.filter(p => !known(p.id));
  const who = p => p.id === me ? "You" : `${R[p.id].name}${R[p.id].role ? " · " + (ROLE_LABELS[R[p.id].role] || R[p.id].role) : ""}`;
  const row = (label, p) => line(label, inr(p.sales), `${plural(p.bills, "bill")}${p.cash ? ` · ${inr(p.cash)} cash` : ""} · last ${hhmm(p.last)}`);
  const merged = unnamed.reduce((a, p) => ({ bills: a.bills + p.bills, sales: a.sales + p.sales, cash: a.cash + p.cash, last: Math.max(a.last, p.last) }), { bills: 0, sales: 0, cash: 0, last: 0 });
  const idle = Object.entries(R).filter(([id, m]) => m.active && ["manager", "cashier"].includes(m.role) && !by[id]).map(([, m]) => m.name).filter(Boolean);
  const body = (people.length ? lines([...named.sort((a, b) => b.sales - a.sales).map(p => row(who(p), p)), unnamed.length ? row(unnamed.length === 1 ? userLabel(unnamed[0].id).replace(/^./, c => c.toUpperCase()) : "Team members", merged) : ""]) : `<p class="muted">No bills yet today.</p>`)
    + (idle.length ? `<p class="note hnote">Not selling today: ${esc(idle.slice(0, 4).join(", "))}${idle.length > 4 ? ` and ${idle.length - 4} more` : ""}.</p>` : "");
  return card("hteam", "Team today", linkTo('data-tab="team"', "Team"), body);
}
export function ownerRowHTML(now, rerender){
  const cards = [gstCardHTML(now), bankCardHTML(now), teamCardHTML(now, rerender)].filter(Boolean);
  return cards.length ? `<div class="hrow">${cards.join("")}</div>` : "";
}

/* ---------- the manager: orders, purchases, stock ---------- */
function ordersCardHTML(now){
  if(!(moduleShown("orders") && canAny(["create_sale", "create_order"]))) return "";
  const has = id => subviewsOf("orders").some(s => s.id === id), o = createReadOnlyBusinessQuery({ now: () => now }).orders(), late = lateOrders(now);
  if(!has("sales") && !has("quote")) return "";
  const body = lines([
    has("sales") ? line("To deliver", o.sales ? `${o.sales} · ${inr(o.salesValue)}` : "None", late.length ? `${plural(late.length, "order")} late` : o.mobile ? `${o.mobile} from your online store` : "", 'data-tab="orders" data-subview="orders:sales"', late.length ? "bad" : "") : "",
    has("quote") ? line("Quotations waiting", o.quotes ? `${o.quotes} · ${inr(o.quoteValue)}` : "None", "", 'data-tab="orders" data-subview="orders:quote"') : "",
  ]);
  return card("hords", "Orders", "", body);
}
function purchasesCardHTML(now){
  if(!(moduleShown("stock") && canAny(["create_purchase", "manage_inventory"]))) return "";
  const q = createReadOnlyBusinessQuery({ now: () => now }), sd = q.supplierDues(), has = id => subviewsOf("stock").some(s => s.id === id), b = dayBounds(dayKey(now), dayKey(now));
  const got = D().ledger.filter(e => e.t >= b.from && e.t <= b.to && e.type === "RESTOCK" && e.q > 0), pieces = got.reduce((a, e) => a + e.q, 0), value = got.reduce((a, e) => a + (e.cost == null ? 0 : e.q * e.cost), 0);
  const po = has("pos") ? q.purchaseOrders() : null;
  const body = lines([
    po ? line("To receive", po.sent ? `${plural(po.sent, "order")} · ${inr(po.value)}` : "None", po.drafts ? `${plural(po.drafts, "draft")} not sent` : "", 'data-navsub="stock:pos"', po.sent ? "warn" : "") : "",
    has("suppliers") && canAny(["create_purchase", "view_reports"]) ? line("Suppliers to pay", sd.total > 0 ? inr(sd.total) : "Nothing", sd.total > 0 ? plural(sd.suppliers, "supplier") : "", 'data-navsub="stock:suppliers"') : "",
    line("Received today", pieces ? plural(Math.round(pieces * 1000) / 1000, "piece") : "Nothing yet", value ? `${inr(value)} at cost` : "", has("purchases") ? 'data-navsub="stock:purchases"' : ""),
  ]);
  return card("hpur", "Purchases", "", body);
}
function stockCardHTML(now){
  if(!(moduleShown("stock") && canAny(["manage_inventory", "create_purchase", "view_reports"]))) return "";
  const al = stockAlerts(), out = al.filter(a => a.level === "out").length, low = al.length - out;
  let s = null; try{ const inv = inventoryIntelligence({ now }); s = { ...inv.summary, deadDays: inv.config.deadDays }; }catch{ s = null; }
  const smart = 'data-tab="stock" data-subview="stock:smart"';
  const body = lines([
    line("Sold out", String(out), low ? `${low} more running low` : "nothing running low", 'data-tab="stock"', out ? "bad" : low ? "warn" : ""),
    s ? line("To reorder", s.reorderProducts ? plural(s.reorderProducts, "product") : "Nothing", s.reorderProducts && s.reorderCost ? `about ${inr(s.reorderCost)}` : "", smart, s.reorderProducts ? "warn" : "") : "",
    s && s.deadStockValue > 0 ? line("Not selling", inr(s.deadStockValue), `${plural(s.deadStock, "product")}, no sale for ${s.deadDays}+ days`, smart) : "",
  ]);
  return card("hstk", "Stock", "", body);
}
export function opsRowHTML(now){
  const cards = [ordersCardHTML(now), purchasesCardHTML(now), stockCardHTML(now)].filter(Boolean);
  return cards.length ? `<div class="hrow">${cards.join("")}</div>` : "";
}

/* ---------- the cashier: my shift, held bills ---------- */
export function shiftHTML(now){
  if(!can("create_sale")) return "";
  const k = dayKey(now), me = userId(), mine = x => me ? x.user === me : x.dev === store.dev, x = periodData(k, k, "");
  const live = x.live.filter(mine), rets = x.rets.filter(mine), K = kstats(live, rets), M = paymentSummary(live, rets).methods;
  const last = live.length ? live.reduce((a, s) => s.t > a.t ? s : a) : null, drawer = dayCash(k, store.dev), closed = closeOf(k, store.dev) || closeOf(k, "shop");
  const body = `<div class="hkpis"><div class="hkpi"><span>My sales</span><b>${inr(K.rev)}</b><small>${plural(K.bills, "bill")}${rets.length ? ` · ${plural(rets.length, "return")}` : ""}</small></div>
      <div class="hkpi bt-cash"><span>Cash I took</span><b>${inr(M.cash.in)}</b><small>UPI ${inr(M.upi.in)} · card ${inr(M.card.in)}</small></div></div>`
    + lines([
      last ? line("Last bill", esc(last.no || "Bill"), `${hhmm(last.t)} · ${inr(last.total)}`, `data-billview="${esc(last.id)}"`) : "",
      line("This till's drawer", inr(drawer.closing), closed ? `closed: counted ${inr(closed.counted)}` : "count it when you close the day", closed ? "" : 'data-cashform="close"'),
    ]);
  return card("hshift", "My shift", "", body);
}
export function heldHTML(now){
  if(!can("create_sale")) return "";
  const list = listHeldCarts();
  if(!list.length) return "";
  const rows = list.slice(0, 4).map(h => { const d = h.data || {}, cart = Array.isArray(d.cart) ? d.cart : [], T = billTotals(cart, d.disc || null, d.cust || null);
    return `<div class="hline"><span class="hl-w">${esc(h.name)}</span><b class="hl-v">${inr(T.total)}</b><small class="hl-n">${plural(cart.length, "line")} · held ${esc(agoText(h.t))}${h.user && h.user !== userId() ? ` by ${esc(userLabel(h.user))}` : ""}</small><button type="button" class="btn xs primary" data-heldrecall="${esc(h.id)}">Recall</button></div>`; }).join("");
  return card("hheld", `Held bills`, list.length > 4 ? linkTo('data-tab="orders" data-subview="orders:held"', `All ${list.length}`) : "", `<div class="hlines">${rows}</div>`);
}

/* ---------- a server: the tables now ---------- */
const TABLE_WORDS = { ready: "Ready to serve", billing: "Asking for the bill", preparing: "In the kitchen", occupied: "Seated" };
export function tablesHTML(){
  if(!(tablesOn() && moduleShown("tables"))) return "";
  const all = tablesList().map(t => ({ t, st: tableStateOf(t.id) })), busy = all.filter(x => x.st !== "available");
  const rank = { ready: 0, billing: 1, preparing: 2, occupied: 3 };
  const counts = st => all.filter(x => x.st === st).length;
  const sum = `${busy.length} of ${plural(all.length, "table")} in use${kitchenOn() && counts("ready") ? ` · ${counts("ready")} ready to serve` : ""}${counts("billing") ? ` · ${counts("billing")} asking for the bill` : ""}`;
  const rows = busy.sort((a, b) => rank[a.st] - rank[b.st]).slice(0, 6).map(x => line(x.t.name, esc(TABLE_WORDS[x.st] || x.st), "", `data-hometable="${esc(x.t.id)}"`, x.st === "ready" ? "warn" : x.st === "billing" ? "bad" : ""));
  return card("htables", "Tables now", linkTo('data-tab="tables"', "All tables"), `<p class="htrend-sum">${esc(sum)}</p>${rows.length ? lines(rows) : `<p class="muted">Every table is free.</p>`}`);
}
