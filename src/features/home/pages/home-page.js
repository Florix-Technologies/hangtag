// Home: the day at a glance, compact and operational (services/home-signals.js and reports/services/business-today.js
// work out every figure from the shop's own records). Quick actions by role beside the shop's name; then Business today
// (sales against a usual <weekday> by this time, bills, average bill and, for those who see reports, gross profit when cost
// prices allow, what customers owe and the stock's value — each opening why it is what it is), Needs attention (only what
// this person can act on, each with where to act), the Hangtag Agent's insights, recent bills and the last 7 days. By role:
//   owner:   everything, with cash / UPI / card taken today and reconciliation
//   manager: everything but the money split and reconciliation
//   cashier: today, what needs them (held bills, orders, receipts not sent), recent bills, customers
//   server / kitchen: today and their tables or the kitchen queue (quick actions)
// An action shows only when its module is shown in this shop (services/modules.js); the actions still check the role.
// The greeting (#welcome) sits above, once a day.
import { store } from '../../../shared/state/store.js';
import { syncSummary } from '../../sync/components/sync-status.js';
import { can, canAny, currentPerms, currentRole } from '../../shop/services/access.js';
import { businessScope, homeSections } from '../../../domain/shop/role-workspace.js';
import { setTab } from '../../../shared/ui/render.js';
import { heldHTML, opsRowHTML, ownerRowHTML, shiftHTML, tablesHTML } from '../components/role-sections.js';
import { briefingHTML, briefingText } from '../components/briefing-card.js';
import { watchSettings } from '../../automation/services/watchers.js';
import { savePrefs } from '../../../shared/state/persistence.js';
import { moduleShown } from '../../shop/services/modules.js';
import { homeActions } from '../../shop/services/quick-actions.js';
import { shopTypeLabel } from '../../shop/services/shop-caps.js';
import { agentInsights, attentionItems, recentBills, salesTrend, stockAlerts } from '../services/home-signals.js';
import { businessTodayView } from '../../reports/services/business-today.js';
import { REF_LABELS } from '../../../domain/reports/business-today.js';
import { salesByChannel } from '../../commerce/services/channels.js';
import { subscriptionBannerHTML } from '../../billing/components/plans-billing.js';
import { billChips } from '../../bills/services/bill-status.js';
import { NAV_ICONS } from '../../../shared/constants/nav-icons.js';
import { UI_ICON, statusChip } from '../../../shared/ui/kit.js';
import { $, esc } from '../../../shared/dom.js';
import { agoText, dayKey, dayLab, dayLong, fmtDate, hhmm } from '../../../shared/formatting/dates.js';
import { inr, inrShort } from '../../../shared/formatting/money.js';

export { stockAlerts };
const card = (title, link, body, cls = "", aria = "") => `<section class="card hcard${cls ? " " + cls : ""}"${aria ? ` aria-label="${esc(aria)}"` : ""}><div class="card-h"><h3>${title}</h3>${link || ""}</div>${body}</section>`;
const linkTo = (attr, label) => `<button class="link xs" type="button" ${attr}>${esc(label)} ${UI_ICON.chevron}</button>`;

/* Business today (reports/services/business-today.js): the day's figures against a usual <weekday> by this time, each a
   button that opens WHY it is what it is — an unusual figure is marked, and the worst of them opens by itself. What it
   shows is the role's (role-workspace.js businessScope): the owner sales, gross profit (when cost prices cover enough of
   the sales), what customers owe, the stock's value, cash / UPI / card and reconciliation; a manager sales, what customers
   owe and the stock; anyone else who sells plain sales, bills and the average bill. */
const MONEY_KEYS = ["cash", "upi", "card", "reconciliation"];
const ASK = { sales: x => x.change < 0 ? "Why are sales down today?" : x.change > 0 ? "Why are sales up today?" : "Explain today's sales", bills: () => "Explain today's sales",
  avgBill: () => "Why is the average bill different today?", profit: () => "Explain today's margin", cash: () => "Explain today's payments", upi: () => "Explain today's payments",
  card: () => "Explain today's payments", receivables: () => "Explain what customers owe", stock: () => "Explain the stock value", reconciliation: () => "Why doesn't the money reconcile?" };
const figureValue = x => x.display != null ? esc(x.display) : x.value == null ? "—" : x.key === "bills" ? esc(String(x.value)) : inr(x.value);
/* The figure whose reasons show: the one tapped; untouched, the most pressing unusual one; "" when closed */
const openFigure = V => { const w = store.homeWhy; return w === undefined ? (V.unusual[0] || "") : V.figures.some(x => x.key === w) ? w : ""; };
function whyHTML(V, key){
  const byKey = Object.fromEntries(V.figures.map(x => [x.key, x])), base = byKey[key] && byKey[key].opens ? byKey[byKey[key].opens] : byKey[key];
  if(!base) return "";
  const x = byKey[key].opens ? { ...base, headline: byKey[key].headline + " " + base.headline } : base;
  const rs = x.reasons.map(r => `<li><span>${esc(r.text)}</span>${r.ref ? `<button type="button" class="link xs" data-agentopen="${esc(r.ref.target)}|${esc(r.ref.id || "")}">${esc(REF_LABELS[r.ref.target] || "Open")} ${UI_ICON.chevron}</button>` : ""}</li>`).join("");
  const ask = moduleShown("assistant") ? `<button type="button" class="btn sm" data-tab="assistant" data-ask-question="${esc((ASK[key] || ASK.sales)(byKey[key]))}">${NAV_ICONS.assistant || ""}<span>Ask the Agent</span></button>` : "";
  return `<div class="bt-why${x.unusual ? " " + esc(x.tone || "warn") : ""}" id="btWhy" role="region" aria-label="${esc(byKey[key].label)}: why" aria-live="polite">
    <p class="bt-h">${esc(x.headline)}</p>${rs ? `<ul class="bt-rs">${rs}</ul>` : ""}${x.check ? `<p class="bt-check"><b>Worth checking:</b> ${esc(x.check)}</p>` : ""}
    <div class="bt-acts">${ask}<button type="button" class="link xs" data-bt="">Close</button></div></div>`;
}
function todayHTML(role){
  const reports = can("view_reports"), V = businessTodayView(Date.now(), businessScope(role, currentPerms()));
  const open = reports ? openFigure(V) : "";
  const tile = x => {
    const inner = `<span>${esc(x.label)}</span><b>${figureValue(x)}</b><small>${esc(x.sub) || "&nbsp;"}</small>${x.unusual ? `<em class="bt-flag">${x.tone === "bad" ? "Check" : "Why?"}</em>` : ""}`;
    const cls = `hkpi bt-${esc(x.key)}${x.tone ? " " + esc(x.tone) : ""}${x.unusual ? " unusual" : ""}`;
    return reports ? `<button type="button" class="${cls}${open === x.key ? " on" : ""}" data-bt="${esc(x.key)}" aria-expanded="${open === x.key}" aria-controls="btWhy">${inner}</button>` : `<div class="${cls}">${inner}</div>`;
  };
  const main = V.figures.filter(x => !MONEY_KEYS.includes(x.key)), money = V.figures.filter(x => MONEY_KEYS.includes(x.key));
  let channels = [];
  try{ channels = salesByChannel(dayKey(Date.now()), dayKey(Date.now()), ""); }catch{ channels = []; }
  const chan = channels.length > 1 ? `<p class="hchan">${channels.map(c => `<span data-channel="${esc(c.key)}">${esc(c.label)} <b>${inr(c.sales)}</b></span>`).join("")}</p>` : "";
  const body = `${V.comparison ? `<p class="bt-basis">Compared with ${esc(V.comparison.label)}${V.comparison.kind === "usual" ? ` (the last ${V.comparison.days} ${esc(fmtDate(Date.now(), { weekday: "long" }))}s)` : ""}.</p>` : ""}
    <div class="hkpis">${main.map(tile).join("")}</div>${chan}
    ${money.length ? `<h4 class="bt-sub">Money today</h4><div class="hkpis bt-money">${money.map(tile).join("")}</div>` : ""}${open ? whyHTML(V, open) : ""}`;
  return card(reports ? "Business today" : "Today", moduleShown("report") ? linkTo('data-tab="report"', "Reports") : "", body, "htoday", reports ? "Business today" : "Today");
}
/* A figure tapped: its reasons open (tapped again, or Close: they close) */
let installed = false;
export function installHomeEvents(){
  if(installed) return; installed = true;
  document.addEventListener("click", e => {
    // the morning briefing: shared as text (the share sheet, else WhatsApp), or hidden until tomorrow
    const br = e.target && e.target.closest ? e.target.closest("[data-brief]") : null;
    if(br){
      if(br.dataset.brief === "hide"){ store.prefs.briefingHidden = dayKey(Date.now()); savePrefs(); renderHome(); return; }
      const text = briefingText(Date.now());
      if(navigator.share) navigator.share({ text }).catch(() => {}); else window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
      return;
    }
    const tb = e.target && e.target.closest ? e.target.closest("[data-hometable]") : null;
    if(tb){ store.tableView = Object.assign({ mode: "floor", edit: null }, store.tableView, { sel: tb.dataset.hometable }); setTab("tables"); return; }
    const b = e.target && e.target.closest ? e.target.closest("[data-bt]") : null; if(!b) return;
    const key = b.dataset.bt, on = document.querySelector("#homeBody [data-bt][aria-expanded=\"true\"]"), openNow = on ? on.dataset.bt : "";
    store.homeWhy = !key || openNow === key ? "" : key;
    renderHome();
    if(store.homeWhy){ const w = $("#btWhy"); if(w && w.getBoundingClientRect().bottom > innerHeight) w.scrollIntoView({ block: "nearest" }); }
  });
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
  const label = k => fmtDate(k + "T12:00:00", { weekday: "short" });
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
  let h = `<div class="viewhead hhead"><div><div class="eyebrow">${esc(fmtDate(now, { weekday: "long", day: "numeric", month: "long" }))}</div>
    <h2 class="vt">${esc(p.shop_name || "Your shop")}</h2><p>${esc(shopTypeLabel())}</p></div>${acts.length ? `<div class="qa" role="group" aria-label="Quick actions">${acts.map((a, i) => `<button type="button" class="btn ${i === 0 ? "primary" : ""} qa-b" ${a.attr}>${NAV_ICONS[a.icon] || ""}<span>${esc(a.label)}</span></button>`).join("")}</div>` : ""}</div>`;
  h += subscriptionBannerHTML();   // the free trial's days left, or a paid plan ending within a week (owner and managers)
  // what this role's day is about (domain/shop/role-workspace.js): full-width sections first, then two columns
  const SEC = homeSections(role, currentPerms()), has = k => SEC.includes(k), sells = canAny(["create_sale", "view_reports"]), reports = can("view_reports");
  const top = [has("briefing") && can("view_reports") && watchSettings().briefing === "notify" ? briefingHTML(now) : "", has("business") && sells ? todayHTML(role) : "", has("shift") ? shiftHTML(now) : "", has("tables") ? tablesHTML() : "",
    has("owner") ? ownerRowHTML(now, () => { if(store.prefs.tab === "home") renderHome(); }) : "", has("ops") ? opsRowHTML(now) : ""].join("");
  const left = [has("held") ? heldHTML(now) : "", has("attention") ? attentionHTML() : "", has("bills") && sells ? billsHTML() : ""].join("");
  const right = [has("agent") && reports ? insightsHTML() : "", has("trend") && reports ? trendHTML() : "", has("customers") && moduleShown("customers") ? customersHTML() : ""].join("");
  h += `<div class="homegrid wide">${top}<div class="hcol">${left}</div>${right ? `<div class="hcol">${right}</div>` : ""}</div>`;
  // the line takes the state's tone only: the header's sync chip (class "sync") hides its words on a phone
  const S = syncSummary();
  h += `<p class="hsync ${esc(S.cls.replace(/\bsync\b/, "").trim())}"><i></i><span><b>Sync:</b> ${esc(S.txt)}${store.lastSyncAt ? ` · last fully synced ${esc(agoText(store.lastSyncAt))}` : ""}</span><button class="link xs" type="button" data-act="syncpanel">Details</button></p>`;
  return h;
}
export function renderHome(){ const host = $("#homeBody"); if(host) host.innerHTML = homeHTML(); }
