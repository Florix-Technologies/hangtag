// Home: the day at a glance, compact and operational (services/home-signals.js works out every figure from the shop's
// own records). Quick actions by role beside the shop's name; then Today (sales, bills, average bill and, for those who
// see reports, gross profit when cost prices allow), Needs attention (only what this person can act on, each with where
// to act), the Hangtag Agent's insights, recent bills and the last 7 days. By role:
//   owner:   everything, with cash / UPI / card taken today
//   manager: everything but the money split
//   cashier: today, what needs them (held bills, orders, receipts not sent), recent bills, customers
//   server / kitchen: today and their tables or the kitchen queue (quick actions)
// An action shows only when its module is shown in this shop (services/modules.js); the actions still check the role.
// The greeting (#welcome) sits above, once a day.
import { store } from '../../../shared/state/store.js';
import { syncSummary } from '../../sync/components/sync-status.js';
import { can, canAny, currentRole } from '../../shop/services/access.js';
import { moduleShown } from '../../shop/services/modules.js';
import { orderMobileActions } from '../../../domain/shop/mobile-workflow.js';
import { shopTypeLabel } from '../../shop/services/shop-caps.js';
import { agentInsights, attentionItems, recentBills, salesTrend, stockAlerts, todayFigures } from '../services/home-signals.js';
import { subscriptionBannerHTML } from '../../billing/components/plans-billing.js';
import { billChips } from '../../bills/services/bill-status.js';
import { NAV_ICONS } from '../../../shared/constants/nav-icons.js';
import { UI_ICON, statusChip } from '../../../shared/ui/kit.js';
import { $, esc } from '../../../shared/dom.js';
import { agoText, dayKey, dayLab, dayLong, hhmm } from '../../../shared/formatting/dates.js';
import { inr, inrShort } from '../../../shared/formatting/money.js';

/* Quick actions by role (domain/shop/mobile-workflow.js orders them): the few that start the day's work */
const ACTIONS = [
  { id:"sale", label:"Quick sell", attr:'data-tab="sell"', module:"sell", perms:["create_sale"], icon:"sell" },
  { id:"scan", label:"Scan to sell", attr:'data-act="scan"', module:"sell", perms:["create_sale"], icon:"tracking" },
  { id:"stock", label:"Quick receive", attr:'data-act="stockin"', module:"stock", perms:["manage_inventory"], icon:"purchases" },
  { id:"reorder", label:"Smart reorder", attr:'data-tab="stock" data-subview="stock:smart"', module:"stock", perms:["manage_inventory", "view_reports"], icon:"smart" },
  { id:"orders", label:"Orders", attr:'data-tab="orders"', module:"orders", perms:["create_sale", "create_order"], icon:"orders" },
  { id:"customers", label:"Customers", attr:'data-tab="customers"', module:"customers", perms:["create_sale", "collect_credit", "create_order"], icon:"customers" },
  { id:"tables", label:"Tables", attr:'data-tab="tables"', module:"tables", perms:["manage_tables", "create_order"], icon:"tables" },
  { id:"kitchen", label:"Kitchen queue", attr:'data-tab="kitchen"', module:"kitchen", perms:["manage_kitchen"], icon:"kitchen" },
];
const ROLE_ACTIONS = { owner: ["sale", "scan", "stock", "tables"], manager: ["stock", "reorder", "tables"], cashier: ["sale", "scan", "tables"], server: ["tables"], kitchen: ["kitchen"] };
/* The quick actions this person has in this shop: [{ label, attr, icon }] (a restaurant's tables take the place of scanning) */
export const homeActions = () => { const want = ROLE_ACTIONS[currentRole()] || ROLE_ACTIONS.owner, tables = moduleShown("tables");
  return orderMobileActions(currentRole(), ACTIONS.filter(a => moduleShown(a.module) && (!a.perms.length || canAny(a.perms)) && !(a.id === "scan" && tables))).filter(a => want.includes(a.id)); };

export { stockAlerts };
const card = (title, link, body, cls = "", aria = "") => `<section class="card hcard${cls ? " " + cls : ""}"${aria ? ` aria-label="${esc(aria)}"` : ""}><div class="card-h"><h3>${title}</h3>${link || ""}</div>${body}</section>`;
const linkTo = (attr, label) => `<button class="link xs" type="button" ${attr}>${esc(label)} ${UI_ICON.chevron}</button>`;
const kpi = (label, value, sub, tone) => `<div class="hkpi${tone ? " " + tone : ""}"><span>${esc(label)}</span><b>${value}</b><small>${sub || "&nbsp;"}</small></div>`;

/* Today: sales, bills, average bill and (for those who see reports) gross profit when cost prices allow; cash / UPI / card for the owner */
function todayHTML(withMoney){
  const T = todayFigures(), d = T.vsYesterday;
  let k = kpi("Sales", inr(T.sales), d == null ? (T.bills ? "after returns" : "no bills yet") : d === 0 ? "same as this time yesterday" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}% vs this time yesterday`, d == null || d === 0 ? "" : d > 0 ? "up" : "down")
    + kpi("Bills", String(T.bills), T.pieces ? T.pieces + (T.pieces === 1 ? " piece" : " pieces") : "")
    + kpi("Average bill", T.bills ? inr(T.avg) : "—", "per bill");
  if(T.profit) k += T.profit.shown ? kpi("Gross profit", inr(T.profit.value), T.profit.margin == null ? "sales less cost" : `${T.profit.margin}% margin${T.profit.complete ? "" : ` · cost known on ${Math.round(T.profit.coverage * 100)}% of sales`}`)
    : kpi("Gross profit", "—", `cost prices missing on ${100 - Math.round(T.profit.coverage * 100)}% of sales`, "muted");
  const chan = T.channels.length > 1 ? `<p class="hchan">${T.channels.map(c => `<span data-channel="${esc(c.key)}">${esc(c.label)} <b>${inr(c.sales)}</b></span>`).join("")}</p>` : "";
  const money = withMoney && T.money ? `<div class="hmoney"><span class="pm cash">Cash <b>${inr(T.money.cash)}</b></span><span class="pm upi">UPI <b>${inr(T.money.upi)}</b></span><span class="pm card">Card <b>${inr(T.money.card)}</b></span></div>` : "";
  return card("Today", moduleShown("report") ? linkTo('data-tab="report"', "Reports") : "", `<div class="hkpis">${k}</div>${chan}${money}`, "htoday", "Today");
}
/* What needs someone, worst first, each with where to act on it */
function attentionHTML(){
  const items = attentionItems();
  const body = items.length ? `<ul class="hatt">${items.map(it => { const inner = `<i class="hatt-dot" aria-hidden="true"></i><span class="hatt-t"><b>${esc(it.title)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span>${it.attr ? `<span class="hatt-cta">${esc(it.cta)} ${UI_ICON.chevron}</span>` : ""}`;
      return `<li class="${esc(it.tone)}" data-attn="${esc(it.id)}">${it.attr ? `<button type="button" class="hatt-row" ${it.attr}>${inner}</button>` : `<div class="hatt-row">${inner}</div>`}</li>`; }).join("")}</ul>`
    : `<p class="hclear">${UI_ICON.check}<span>All clear — nothing needs you right now.</span></p>`;
  return card(`Needs attention${items.length ? ` <span class="hcount">${items.length}</span>` : ""}`, "", body, "hattn", "Needs attention");
}
/* The Hangtag Agent's few observations from the data, each with where to look */
function insightsHTML(){
  const list = agentInsights(), ask = moduleShown("assistant") ? linkTo('data-tab="assistant"', "Ask the Agent") : "";
  const body = list.length ? `<ul class="hins">${list.map(i => `<li data-insight="${esc(i.id)}"><p>${esc(i.text)}</p>${i.attr && i.cta ? `<button type="button" class="link xs" ${i.attr}>${esc(i.cta)} ${UI_ICON.chevron}</button>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted">Nothing unusual in your sales and stock right now.</p>`;
  return card(`${NAV_ICONS.assistant || ""}<span>Hangtag Agent</span>`, ask, body + `<p class="note">From your shop&rsquo;s own records. It suggests; it never changes anything by itself.</p>`, "hagent", "Hangtag Agent");
}
/* The last 7 days of sales as bars (today last) */
function trendHTML(){
  const T = salesTrend(), max = Math.max(1, ...T.days.map(d => d.sales)), today = dayKey(Date.now());
  const label = k => new Date(k + "T12:00:00").toLocaleDateString("en-IN", { weekday: "short" });
  const ch = T.prevTotal ? Math.round((T.total - T.prevTotal) / T.prevTotal * 100) : null;
  const delta = ch == null ? "" : `<span class="delta ${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch)}% <span>vs the 7 days before</span></span>`;
  const bars = T.days.map(d => `<div class="hbar${d.k === today ? " on" : ""}" title="${esc(dayLong(d.k))}: ${esc(inr(d.sales))} · ${d.bills} bill${d.bills === 1 ? "" : "s"}"><span class="hbar-v">${d.sales ? esc(inrShort(d.sales)) : ""}</span><span class="hbar-c"><i style="height:${d.sales > 0 ? Math.max(4, Math.round(d.sales / max * 100)) : 0}%"></i></span><span class="hbar-d">${esc(d.k === today ? "Today" : label(d.k))}</span></div>`).join("");
  const aria = "Sales, last 7 days: " + T.days.map(d => `${label(d.k)} ${inr(d.sales)}`).join(", ");
  return card("Last 7 days", moduleShown("report") ? linkTo('data-reportgo="7d"', "Reports") : "", `<p class="htrend-sum"><b>${inr(T.total)}</b>${delta}</p><div class="htrend" role="img" aria-label="${esc(aria)}">${bars}</div>`, "htrendc", "Sales, last 7 days");
}
/* The latest bills with their state */
function billsHTML(){
  const list = recentBills(5), today = dayKey(Date.now());
  const body = list.length ? `<div class="olist hlist">${list.map(({ s, st }) => { const chips = billChips(s, st).slice(0, 2).map(([l, t]) => statusChip(l, t)).join("");
      return `<button type="button" class="orow chev${s.void ? " void" : ""}" data-billview="${esc(s.id)}"><span class="o-main"><span class="o-t hbill-t"><span class="hno">${esc(s.no || "Bill")}</span>${chips}</span><span class="o-s">${esc(dayKey(s.t) === today ? hhmm(s.t) : dayLab(dayKey(s.t)) + " · " + hhmm(s.t))} · ${esc(s.cust && s.cust.name || "Walk-in")}</span></span><span class="o-end"><span class="o-amt">${inr(s.total)}</span></span></button>`; }).join("")}</div>`
    : `<p class="muted">No bills yet. The first one you make on Sell shows up here.</p>`;
  return card("Recent bills", moduleShown("bills") ? linkTo('data-tab="bills"', "All bills") : "", body, "hbills", "Recent bills");
}
function customersHTML(){
  return card("Customers", linkTo('data-tab="customers"', "All customers"), `<div class="btnrow"><button type="button" class="btn" data-act="custadd">${UI_ICON.plus} New customer</button><button type="button" class="btn" data-tab="customers">${UI_ICON.search} Find a customer</button></div>`, "hcust");
}

export function homeHTML(){
  const p = (store.access && store.access.shopName) ? { shop_name: store.access.shopName } : (store.profile || {}), now = Date.now(), role = currentRole();
  const acts = homeActions();
  let h = `<div class="viewhead hhead"><div><div class="eyebrow">${esc(new Date(now).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }))}</div>
    <h2 class="vt">${esc(p.shop_name || "Your shop")}</h2><p>${esc(shopTypeLabel())}</p></div>${acts.length ? `<div class="qa" role="group" aria-label="Quick actions">${acts.map((a, i) => `<button type="button" class="btn ${i === 0 ? "primary" : ""} qa-b" ${a.attr}>${NAV_ICONS[a.icon] || ""}<span>${esc(a.label)}</span></button>`).join("")}</div>` : ""}</div>`;
  h += subscriptionBannerHTML();   // the free trial's days left, or a paid plan ending within a week (owner and managers)
  const sells = canAny(["create_sale", "view_reports"]), reports = can("view_reports");
  const today = sells ? todayHTML(role === "owner") : "";
  if(reports) h += `<div class="homegrid wide">${today}<div class="hcol">${attentionHTML()}${sells ? billsHTML() : ""}</div><div class="hcol">${insightsHTML()}${trendHTML()}</div></div>`;
  else h += `<div class="homegrid">${today}${attentionHTML()}${sells && role === "cashier" ? billsHTML() : ""}${role === "cashier" && moduleShown("customers") ? customersHTML() : ""}</div>`;
  // the line takes the state's tone only: the header's sync chip (class "sync") hides its words on a phone
  const S = syncSummary();
  h += `<p class="hsync ${esc(S.cls.replace(/\bsync\b/, "").trim())}"><i></i><span><b>Sync:</b> ${esc(S.txt)}${store.lastSyncAt ? ` · last fully synced ${esc(agoText(store.lastSyncAt))}` : ""}</span><button class="link xs" type="button" data-act="syncpanel">Details</button></p>`;
  return h;
}
export function renderHome(){ const host = $("#homeBody"); if(host) host.innerHTML = homeHTML(); }
