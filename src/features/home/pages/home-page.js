// Home: the shop at a glance — today's sales and bills, what is running low or sold out, where this device stands with the
// cloud, and quick actions. Every part is shown only to someone whose role may use it, and a quick action only when its
// module is shown in this shop (services/modules.js); the actions themselves still check the role.
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { stockOf } from '../../inventory/services/stock.js';
import { levelOf, lowAt } from '../../inventory/services/stock-levels.js';
import { liveProducts } from '../../products/services/catalog.js';
import { todayStats } from '../../sales/services/sales-log.js';
import { syncSummary } from '../../sync/components/sync-status.js';
import { can, canAny, currentRole } from '../../shop/services/access.js';
import { moduleShown } from '../../shop/services/modules.js';
import { orderMobileActions } from '../../../domain/shop/mobile-workflow.js';
import { shopTypeLabel } from '../../shop/services/shop-caps.js';
import { vLabel, variantsOf } from '../../../domain/catalog/variants.js';
import { payLabel } from '../../../domain/sales/payments.js';
import { kpi } from '../../../shared/components/kpi.js';
import { ICON } from '../../../shared/constants/icons.js';
import { NAV_ICONS } from '../../../shared/constants/nav-icons.js';
import { $, esc } from '../../../shared/dom.js';
import { agoText, dayKey, hhmm } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';

/* Quick actions: [label, the button's data attribute, the module it belongs to, any of these permissions] */
const ACTIONS = [
  { id:"sale", label:"New sale", attr:'data-tab="sell"', module:"sell", perms:["create_sale"], icon:"sell" },
  { id:"scan", label:"Scan", attr:'data-act="scan"', module:"sell", perms:["create_sale"], icon:"sell" },
  { id:"orders", label:"Orders", attr:'data-tab="orders"', module:"orders", perms:["create_sale", "create_order"], icon:"orders" },
  { id:"stock", label:"Stock", attr:'data-tab="stock"', module:"stock", perms:["manage_inventory", "create_purchase"], icon:"stock" },
  { id:"reorder", label:"Smart reorder", attr:'data-tab="stock" data-subview="stock:smart"', module:"stock", perms:["manage_inventory", "view_reports"], icon:"stock" },
  { id:"suppliers", label:"Suppliers", attr:'data-tab="stock" data-subview="stock:suppliers"', module:"stock", perms:["create_purchase"], icon:"stock" },
  { id:"products", label:"Products", attr:'data-tab="products"', module:"products", perms:["manage_products"], icon:"products" },
  { id:"customers", label:"Customers", attr:'data-tab="customers"', module:"customers", perms:["create_sale", "collect_credit", "create_order"], icon:"customers" },
  { id:"reports", label:"Reports & profit", attr:'data-tab="report"', module:"report", perms:["view_reports"], icon:"report" },
  { id:"tables", label:"Tables", attr:'data-tab="tables"', module:"tables", perms:["manage_tables", "create_order"], icon:"tables" },
  { id:"kitchen", label:"Kitchen queue", attr:'data-tab="kitchen"', module:"kitchen", perms:["manage_kitchen"], icon:"kitchen" },
  { id:"settings", label:"Settings", attr:'data-tab="settings"', module:"settings", perms:[], icon:"settings" },
];
/* The quick actions this person has in this shop: [{ label, attr }] */
export const homeActions = () => orderMobileActions(currentRole(), ACTIONS.filter(a => moduleShown(a.module) && (!a.perms.length || canAny(a.perms))));

/* Variants running low or sold out (products on sale), fewest first */
export function stockAlerts(){
  const out = [];
  liveProducts().forEach(p => variantsOf(p).forEach(v => { const n = stockOf(v.id), lv = levelOf(n); if(lv !== "ok") out.push({ p, v, n, level: lv }); }));
  return out.sort((a, b) => a.n - b.n);
}

export function homeHTML(){
  const p = store.profile || {}, now = Date.now();
  const sells = canAny(["create_sale", "view_reports"]), seesStock = canAny(["view_products", "manage_inventory", "create_purchase", "manage_products"]);
  let h = `<div class="viewhead"><div><div class="eyebrow">${esc(new Date(now).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }))}</div>
    <h2 class="vt">${esc(p.shop_name || "Your shop")}</h2><p>${esc(shopTypeLabel())}</p></div></div>`;
  const acts = homeActions();
  if(acts.length) h += `<div class="qa" role="group" aria-label="Quick actions">${acts.map(a => `<button type="button" class="qa-b" ${a.attr}>${NAV_ICONS[a.icon] || ""}<span>${esc(a.label)}</span></button>`).join("")}</div>`;
  h += `<div class="homegrid">`;
  if(sells){
    const t = todayStats(), k = dayKey(now);
    const bills = D().sales.filter(s => dayKey(s.t) === k).sort((a, b) => b.t - a.t);
    h += `<div class="card"><div class="card-h"><h3>Today</h3>${moduleShown("report") ? `<button class="link xs" type="button" data-tab="report">Reports</button>` : ""}</div>
      <div class="kpis hk3">${kpi("Sold today", inr(t.rev), "after refunds")}${kpi("Bills", String(t.bills), "")}${kpi("Pieces", String(t.pcs), "")}</div>
      <h4 class="subh">Bills today</h4>${bills.length ? `<div class="hbills">${bills.slice(0, 6).map(s => `<button type="button" class="hbill${s.void ? " void" : ""}" data-billview="${esc(s.id)}"><span><b>${esc(s.no || "Bill")}</b><small>${esc(hhmm(s.t))} · ${esc(payLabel(s))}${s.void ? " · cancelled" : ""}</small></span><b>${inr(s.total)}</b></button>`).join("")}</div>`
        + (bills.length > 6 ? `<p class="note">and ${bills.length - 6} more today</p>` : "") : `<p class="muted">No bills yet today.</p>`}</div>`;
  }
  if(seesStock){
    const al = stockAlerts(), out = al.filter(a => a.level === "out"), low = al.length - out.length, stockIn = can("manage_inventory");
    h += `<div class="card"><div class="card-h"><h3>Stock</h3>${moduleShown("stock") ? `<button class="link xs" type="button" data-tab="stock">Inventory</button>` : ""}</div>
      <div class="kpis">${kpi("Running low", String(low), `variants with 1–${lowAt()} pieces`, low ? "warn" : "")}${kpi("Sold out", String(out.length), "variants at zero", out.length ? "crit" : "")}</div>
      ${al.length ? `<div class="alerts">${al.slice(0, 8).map(a => { const inner = `${a.level === "out" ? ICON.out : ICON.warn}<b>${esc(a.p.name)}</b>${vLabel(a.v) ? `<span class="szl">${esc(vLabel(a.v))}</span>` : ""}<span class="st">${a.n < 0 ? a.n + " (below zero)" : a.level === "out" ? "sold out" : a.n + " left"}</span>`;
          return stockIn ? `<button type="button" class="al ${a.level}" data-stockin="${esc(a.p.id)}">${inner}</button>` : `<span class="al ${a.level}">${inner}</span>`; }).join("")}${al.length > 8 ? `<span class="note">+${al.length - 8} more</span>` : ""}</div>`
        : `<p class="muted">${liveProducts().length ? "Everything is in stock." : "No products yet."}</p>`}</div>`;
  }
  const S = syncSummary();
  h += `<div class="card"><div class="card-h"><h3>Sync</h3><button class="link xs" type="button" data-act="syncpanel">Details</button></div>
    <p class="hsync ${esc(S.cls)}"><i></i><b>${esc(S.txt)}</b></p><p class="note" style="margin:0">${esc(S.tip)}</p>
    ${store.lastSyncAt ? `<p class="note" style="margin:6px 0 0">Last fully synced ${esc(agoText(store.lastSyncAt))}.</p>` : ""}</div>`;
  h += `</div>`;
  return h;
}
export function renderHome(){ const host = $("#homeBody"); if(host) host.innerHTML = homeHTML(); }
