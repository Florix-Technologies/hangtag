// Orders tab: held bills (every shop), quotations and sales orders (where the shop uses them). A list per part; an order
// opens in the editor (components/order-editor.js). Nothing here changes stock.
import { KIND_LABELS, STATUS_LABELS, cartBlock, isExpired, remaining, shownStatus } from '../../../domain/orders/orders.js';
import { store } from '../../../shared/state/store.js';
import { orderViews } from '../module.js';
import { listHeldCarts } from '../use-cases/held-carts.js';
import { ordersOf, orderTotals, todayKey } from '../use-cases/orders.js';
import { billTotals } from '../../sales/services/totals.js';
import { can } from '../../shop/services/access.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';

/* The part of Orders shown now: the one chosen, if this person still has it, else the first one they have */
export function currentOrdersView(){
  const views = orderViews();
  return views.find(v => v.id === store.ordersView) ? store.ordersView : (views[0] ? views[0].id : "");
}
const chip = (st, label) => `<span class="ostat ostat-${esc(st)}">${esc(label || STATUS_LABELS[st] || st)}</span>`;
const pieces = lines => (lines || []).reduce((a, l) => a + (+l.q || 0), 0);

function heldHTML(){
  const list = listHeldCarts();
  if(!list.length) return `<div class="empty"><b>No held bills</b><p>On the Sell screen, tap <b>Hold</b> to put a bill aside (a customer who went to get something, a second queue) and finish it later on any till. Holding doesn't take anything off the shelf.</p></div>`;
  return `<div class="olist">${list.map(h => { const d = h.data || {}, cart = Array.isArray(d.cart) ? d.cart : [], T = billTotals(cart, d.disc || null, d.cust || null);
    return `<div class="ocard" data-heldrow="${esc(h.id)}"><div class="oc-main"><b>${esc(h.name)}</b><small>${cart.length} line${cart.length === 1 ? "" : "s"} · ${pieces(cart)} piece${pieces(cart) === 1 ? "" : "s"} · held ${esc(dayLab(dayKey(h.t)))} ${esc(hhmm(h.t))}${d.order && d.order.no ? " · " + esc(d.order.no) : ""}</small></div>
      <div class="oc-side"><b>${inr(T.total)}</b><span class="oc-acts"><button class="btn xs primary" data-heldrecall="${esc(h.id)}">Recall</button><button class="btn xs" data-helddel="${esc(h.id)}">Remove</button></span></div></div>`; }).join("")}</div>`;
}
function orderRowHTML(o, today){
  const T = orderTotals(o), st = shownStatus(o, today), left = (o.items || []).reduce((a, l) => a + remaining(l), 0), billable = !cartBlock(o, today);
  const sub = [dayLab(dayKey(o.t)), (o.items || []).length + " line" + ((o.items || []).length === 1 ? "" : "s"),
    o.kind === "quote" && o.validUntil ? (isExpired(o, today) ? "expired " : "valid till ") + dayLab(o.validUntil) : "",
    o.kind === "sales" && (st === "partial" || st === "confirmed") && left ? left + " to deliver" : ""].filter(Boolean).join(" · ");
  return `<div class="ocard" data-orderrow="${esc(o.id)}"><button class="oc-main asbtn" data-ordopen="${esc(o.id)}"><b>${esc(o.no || KIND_LABELS[o.kind])} · ${esc(o.cust && o.cust.name || "No customer")}</b><small>${esc(sub)}</small></button>
    <div class="oc-side"><b>${inr(T.total)}</b>${chip(st)}<span class="oc-acts">${o.kind === "quote" && billable && can("create_order") ? `<button class="btn xs" data-ordconvert="${esc(o.id)}">To sales order</button>` : ""}${billable && can("create_sale") ? `<button class="btn xs primary" data-ordbill="${esc(o.id)}">Bill</button>` : ""}</span></div></div>`;
}
function ordersHTML(kind){
  const list = ordersOf(kind), today = todayKey(), what = KIND_LABELS[kind].toLowerCase(), mayEdit = can("create_order");
  const tools = mayEdit ? `<div class="otools"><button class="btn primary sm" data-ordnew="${kind}">+ New ${what}</button>${store.cart.length ? `<button class="btn sm" data-ordfromcart="${kind}">From the bill on the screen</button>` : ""}</div>` : "";
  if(!list.length) return tools + `<div class="empty"><b>No ${what}s yet</b><p>${kind === "quote" ? "Price items for a customer, with discounts and GST, valid until a date. When they agree, turn it into a sales order or bill it." : "Items a customer ordered, billed when you deliver them (all at once or in parts). Orders never take anything off the shelf; the bill does."}</p></div>`;
  return tools + `<div class="olist">${list.map(o => orderRowHTML(o, today)).join("")}</div>`;
}
export function renderOrders(){
  const host = $("#ordersBody"); if(!host) return;
  const views = orderViews(), cur = currentOrdersView();
  if(!views.length){ host.innerHTML = `<div class="empty"><b>Nothing to open here</b><p class="muted">Your role can't hold bills or make orders.</p></div>`; return; }
  const seg = views.length > 1 ? `<div class="seg oseg" role="group" aria-label="Orders">${views.map(v => `<button type="button" data-ordview="${v.id}" aria-pressed="${v.id === cur}">${esc(v.label)}${v.id === "held" && listHeldCarts().length ? ` (${listHeldCarts().length})` : ""}</button>`).join("")}</div>` : "";
  host.innerHTML = seg + `<div id="ordersList">${cur === "held" ? heldHTML() : ordersHTML(cur)}</div>`;
}
