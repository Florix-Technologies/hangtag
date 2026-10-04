// Home, by role — focused, not every screen again as buttons:
//   owner:   today's sales, cash / UPI / card, orders, low stock and Smart reorder, Quick sell and Quick receive
//   manager: sales, orders, stock, reorder, purchases
//   cashier: sell, held bills, recent bills, customers
//   server / kitchen: their tables or the kitchen queue
// Each card shows only to a role that may use it, and an action only when its module is shown in this shop (services/
// modules.js); the actions themselves still check the role. The greeting (#welcome) sits above, once a day.
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { stockOf } from '../../inventory/services/stock.js';
import { levelOf } from '../../inventory/services/stock-levels.js';
import { liveProducts } from '../../products/services/catalog.js';
import { todayStats } from '../../sales/services/sales-log.js';
import { syncSummary } from '../../sync/components/sync-status.js';
import { can, canAny, currentRole } from '../../shop/services/access.js';
import { moduleShown } from '../../shop/services/modules.js';
import { orderMobileActions } from '../../../domain/shop/mobile-workflow.js';
import { shopTypeLabel } from '../../shop/services/shop-caps.js';
import { vLabel, variantsOf } from '../../../domain/catalog/variants.js';
import { paymentSummary } from '../../../domain/reports/sales-report.js';
import { periodData, kstats } from '../../reports/services/report-data.js';
import { createReadOnlyBusinessQuery } from '../../assistant/services/business-query.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';
import { NAV_ICONS } from '../../../shared/constants/nav-icons.js';
import { UI_ICON, statusChip } from '../../../shared/ui/kit.js';
import { $, esc } from '../../../shared/dom.js';
import { addDays, agoText, dayKey, hhmm } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';

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
const ROLE_ACTIONS = { owner: ["sale", "stock", "tables"], manager: ["stock", "reorder", "tables"], cashier: ["sale", "scan", "tables"], server: ["tables"], kitchen: ["kitchen"] };
/* The quick actions this person has in this shop: [{ label, attr, icon }] */
export const homeActions = () => { const want = ROLE_ACTIONS[currentRole()] || ROLE_ACTIONS.owner;
  return orderMobileActions(currentRole(), ACTIONS.filter(a => moduleShown(a.module) && (!a.perms.length || canAny(a.perms)))).filter(a => want.includes(a.id)); };

/* Variants running low or sold out (products on sale), fewest first */
export function stockAlerts(){
  const out = [];
  liveProducts().forEach(p => variantsOf(p).forEach(v => { const n = stockOf(v.id), lv = levelOf(n, p); if(lv !== "ok") out.push({ p, v, n, level: lv }); }));
  return out.sort((a, b) => a.n - b.n);
}
const card = (title, link, body, cls = "") => `<section class="card hcard${cls ? " " + cls : ""}"><div class="card-h"><h3>${esc(title)}</h3>${link || ""}</div>${body}</section>`;
const linkTo = (attr, label) => `<button class="link xs" type="button" ${attr}>${esc(label)} ${UI_ICON.chevron}</button>`;
const stat = (label, value, sub, tone) => `<div class="hstat${tone ? " " + tone : ""}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

function todayCard(withMoney){
  const t = todayStats(), k = dayKey(Date.now()), y = kstats(...(x => [x.live, x.rets])(periodData(addDays(k, -1), addDays(k, -1), "")));
  const diff = y.total ? Math.round((t.rev - y.total) / y.total * 100) : null;
  let body = `<div class="hstats">${stat("Sales", inr(t.rev), diff == null ? "after refunds" : `${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff)}% vs yesterday`, diff == null ? "" : diff >= 0 ? "up" : "down")}${stat("Bills", String(t.bills), t.pcs ? t.pcs + (t.pcs === 1 ? " piece" : " pieces") : "")}</div>`;
  if(withMoney){
    const x = periodData(k, k, ""), m = paymentSummary(x.live, x.rets).methods, inOf = key => inr((m[key] || {}).in || 0);
    body += `<div class="hmoney"><span class="pm cash">Cash <b>${inOf("cash")}</b></span><span class="pm upi">UPI <b>${inOf("upi")}</b></span><span class="pm card">Card <b>${inOf("card")}</b></span></div>`;
  }
  return card("Today", moduleShown("report") ? linkTo('data-tab="report"', "Reports") : "", body);
}
function billsCard(){
  const bills = D().sales.filter(s => dayKey(s.t) === dayKey(Date.now())).sort((a, b) => b.t - a.t);
  return card("Recent bills", moduleShown("report") ? linkTo('data-tab="report"', "All bills") : "", bills.length ? `<div class="olist hlist">${bills.slice(0, 6).map(s => `<button type="button" class="orow chev${s.void ? " void" : ""}" data-billview="${esc(s.id)}"><span class="o-main"><span class="o-t">${esc(s.no || "Bill")}</span><span class="o-s">${esc(hhmm(s.t))}${s.cust && s.cust.name ? " · " + esc(s.cust.name) : ""}</span></span><span class="o-end"><span class="o-amt">${inr(s.total)}</span>${s.void ? statusChip("Cancelled", "muted") : ""}</span></button>`).join("")}</div>${bills.length > 6 ? `<p class="note">and ${bills.length - 6} more today</p>` : ""}` : `<p class="muted">No bills yet today.</p>`);
}
function heldCard(){
  const held = Object.values(store.heldCarts || {}).filter(Boolean).sort((a, b) => (b.t || 0) - (a.t || 0));
  return card("Held bills", moduleShown("orders") ? linkTo('data-tab="orders" data-subview="orders:held"', "Open") : "", held.length ? `<div class="olist hlist">${held.slice(0, 4).map(h => `<button type="button" class="orow chev" data-tab="orders" data-subview="orders:held"><span class="o-main"><span class="o-t">${esc(h.name || h.label || (h.cust && h.cust.name) || "Held bill")}</span><span class="o-s">${esc(h.t ? agoText(h.t) : "")}${(h.lines || h.items || []).length ? " · " + (h.lines || h.items).length + " item" + ((h.lines || h.items).length === 1 ? "" : "s") : ""}</span></span></button>`).join("")}</div>` : `<p class="muted">No bills on hold.</p>`);
}
function ordersCard(){
  const o = createReadOnlyBusinessQuery().orders();
  if(!moduleShown("orders")) return "";
  return card("Orders", linkTo('data-tab="orders"', "Orders"), `<div class="hstats">${stat("To deliver", String(o.sales), o.sales ? inr(o.salesValue) : "sales orders")}${stat("Quotations", String(o.quotes), o.quotes ? inr(o.quoteValue) : "waiting")}${o.mobile ? stat("From your store", String(o.mobile), "new online orders", "up") : ""}</div>`);
}
function stockCard(reorder){
  const al = stockAlerts(), out = al.filter(a => a.level === "out"), low = al.length - out.length, stockIn = can("manage_inventory");
  let n = 0;
  if(reorder){ try{ n = inventoryIntelligence().products.filter(r => r.shouldReorder).length; }catch{ n = 0; } }
  const head = `<div class="hstats">${stat("Running low", String(low), "variants", low ? "warn" : "")}${stat("Sold out", String(out.length), "variants", out.length ? "bad" : "")}${reorder ? stat("To reorder", String(n), "Smart reorder", n ? "warn" : "") : ""}</div>`;
  const list = al.length ? `<div class="olist hlist">${al.slice(0, 5).map(a => { const inner = `<span class="o-main"><span class="o-t">${esc(a.p.name)}${vLabel(a.v) ? ` <span class="szl">${esc(vLabel(a.v))}</span>` : ""}</span></span><span class="o-end">${statusChip(a.n <= 0 ? "Sold out" : a.n + " left", a.level === "out" ? "bad" : "warn")}</span>`;
    return stockIn ? `<button type="button" class="orow chev" data-stockin="${esc(a.p.id)}">${inner}</button>` : `<div class="orow">${inner}</div>`; }).join("")}</div>${al.length > 5 ? `<p class="note">+${al.length - 5} more</p>` : ""}`
    : `<p class="muted">${liveProducts().length ? "Everything is in stock." : "No products yet."}</p>`;
  const link = reorder && moduleShown("stock") ? linkTo('data-tab="stock" data-subview="stock:smart"', "Smart reorder") : moduleShown("stock") ? linkTo('data-tab="stock"', "Stock") : "";
  return card("Low stock", link, head + list);
}
function purchasesCard(){
  if(!can("create_purchase") && !can("view_reports")) return "";
  const q = createReadOnlyBusinessQuery(), d = q.supplierDues(), po = q.purchaseOrders();
  return card("Purchases", moduleShown("stock") ? linkTo('data-navsub="stock:purchases"', "Purchases") : "", `<div class="hstats">${stat("Owed to suppliers", inr(d.total), d.suppliers ? d.suppliers + " supplier" + (d.suppliers === 1 ? "" : "s") : "all paid", d.total ? "warn" : "")}${stat("Orders to receive", String(po.open), po.open ? inr(po.value) : "purchase orders")}</div>`);
}
function customersCard(){
  return card("Customers", linkTo('data-tab="customers"', "All customers"), `<div class="btnrow"><button type="button" class="btn" data-act="custadd">${UI_ICON.plus} New customer</button><button type="button" class="btn" data-tab="customers">${UI_ICON.search} Find a customer</button></div>`);
}

export function homeHTML(){
  const p = (store.access && store.access.shopName) ? { shop_name: store.access.shopName } : (store.profile || {}), now = Date.now(), role = currentRole();
  let h = `<div class="viewhead"><div><div class="eyebrow">${esc(new Date(now).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }))}</div>
    <h2 class="vt">${esc(p.shop_name || "Your shop")}</h2><p>${esc(shopTypeLabel())}</p></div></div>`;
  const acts = homeActions();
  if(acts.length) h += `<div class="qa" role="group" aria-label="Quick actions">${acts.map((a, i) => `<button type="button" class="btn ${i === 0 ? "primary" : ""} lg qa-b" ${a.attr}>${NAV_ICONS[a.icon] || ""}<span>${esc(a.label)}</span></button>`).join("")}</div>`;
  const cards = [];
  const sells = canAny(["create_sale", "view_reports"]), seesStock = canAny(["view_products", "manage_inventory", "create_purchase", "manage_products"]);
  if(role === "cashier"){
    if(sells) cards.push(todayCard(false), heldCard(), billsCard());
    if(moduleShown("customers")) cards.push(customersCard());
  }else if(role === "server" || role === "kitchen"){
    if(sells) cards.push(todayCard(false));
  }else if(role === "manager"){
    if(sells) cards.push(todayCard(false));
    cards.push(ordersCard());
    if(seesStock) cards.push(stockCard(true));
    cards.push(purchasesCard());
  }else{
    if(sells) cards.push(todayCard(true));
    cards.push(ordersCard());
    if(seesStock) cards.push(stockCard(true));
  }
  h += `<div class="homegrid">${cards.filter(Boolean).join("")}</div>`;
  const S = syncSummary();
  h += `<p class="hsync ${esc(S.cls)}"><i></i><span><b>Sync:</b> ${esc(S.txt)}${store.lastSyncAt ? ` · last fully synced ${esc(agoText(store.lastSyncAt))}` : ""}</span><button class="link xs" type="button" data-act="syncpanel">Details</button></p>`;
  return h;
}
export function renderHome(){ const host = $("#homeBody"); if(host) host.innerHTML = homeHTML(); }
