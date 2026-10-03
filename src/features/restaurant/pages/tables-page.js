// Tables (restaurant / hotel): the floor — every table with its state (available, occupied, preparing, ready, billing);
// a table opens with its session (seated when, by whom, guests), its orders (each a kitchen ticket), their items, the
// amount so far and the bill — and Set up (tables, their QR codes). Taking an order: components/table-order.js.
// store.tableView = { mode: "floor" | "setup", sel (the table open), edit ({ id?, name, area, seats, err } being set up) }
import { store } from '../../../shared/state/store.js';
import { KITCHEN_LABELS, TABLE_STATES, sessionBillLines } from '../../../domain/restaurant/tables.js';
import { billTotals } from '../../sales/services/totals.js';
import { cartTable, kitchenOn, liveSessions, maySetUpTables, mayTakeTableOrder, mayWorkTables, ordersOfSessions, tableById, tableQrOn, tableStateOf, tablesList, tableOrders, guestOrderingOn } from '../services/restaurant-state.js';
import { tableRepository } from '../repositories/table-repository.js';
import { D } from '../../inventory/services/ledger.js';
import { can, userLabel } from '../../shop/services/access.js';
import { $, esc } from '../../../shared/dom.js';
import { hhmm } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { fmtQty } from '../../../domain/catalog/units.js';

const V = () => store.tableView || (store.tableView = { mode: "floor", sel: null, edit: null });
const mins = t => Math.max(0, Math.round((Date.now() - (t || 0)) / 60000));
const ago = t => { const m = mins(t); return m < 1 ? "just now" : m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
const chip = st => `<span class="tchip st-${esc(st)}">${esc(TABLE_STATES[st] || KITCHEN_LABELS[st] || st)}</span>`;
/* What the table's orders come to (the bill as it would be now: discounts none, GST as the shop charges it) */
const sessionTotal = orders => { const lines = sessionBillLines(orders); return lines.length ? billTotals(lines, null, null).total : 0; };

function cardHTML(t, sel){
  const st = tableStateOf(t.id), live = liveSessions(t.id), s = live[0], orders = tableOrders(t.id), total = s && can("create_sale") ? sessionTotal(orders) : 0;
  return `<button type="button" class="tcard st-${st}" data-tbl="${esc(t.id)}" aria-pressed="${sel === t.id}"><b>${esc(t.name)}</b>${chip(st)}
    <small>${[t.seats ? t.seats + " seats" : "", s ? ago(s.t) : "", total ? inr(total) : ""].filter(Boolean).map(esc).join(" · ") || "&nbsp;"}</small></button>`;
}
function orderHTML(o){
  const acts = [];
  if((o.status === "ready" || (!kitchenOn() && o.status === "new")) && can("create_order")) acts.push(`<button class="btn xs primary" data-tserve="${esc(o.id)}">${kitchenOn() ? "Served" : "Complete"}</button>`);
  if(!["served", "cancelled"].includes(o.status) && (can("create_order") || can("manage_kitchen"))) acts.push(`<button class="link xs danger" data-tcancel="${esc(o.id)}">Cancel</button>`);
  return `<div class="tord${o.status === "cancelled" ? " off" : ""}"><div class="tord-h"><b>${esc(o.no || "Order")}</b>${chip(o.status)}<small>${esc(hhmm(o.t))} · ${o.source === "customer" ? "ordered by the guests (QR)" : esc(userLabel(o.user) || "staff")}</small></div>
    <ul>${(o.items || []).map(l => `<li><b>${esc(fmtQty(l.q))} ×</b> ${esc(l.name)}${l.vl ? ` <small>${esc(l.vl)}</small>` : ""}${l.note ? ` <em>${esc(l.note)}</em>` : ""}</li>`).join("")}</ul>
    ${o.notes ? `<p class="note">${esc(o.notes)}</p>` : ""}${acts.length ? `<div class="tord-a">${acts.join("")}</div>` : ""}</div>`;
}
function panelHTML(t){
  const live = liveSessions(t.id), s = live[0], st = tableStateOf(t.id), orders = ordersOfSessions(live.map(x => x.id)), billing = cartTable() && cartTable().table === t.id;
  const total = s ? sessionTotal(orders) : 0, open = orders.filter(o => o.status !== "cancelled").length;
  // the table's last bill today (a session closed with a bill): who paid what
  const last = tableRepository().sessions().filter(x => x.table === t.id && x.status === "closed" && x.sale).sort((a, b) => (b.closedT || 0) - (a.closedT || 0))[0];
  const lastSale = last && D().saleById[last.sale];
  const acts = [];
  if(mayTakeTableOrder()) acts.push(`<button class="btn sm primary" data-tneworder="${esc(t.id)}">+ New order</button>`);
  if(s && open && can("create_sale")) acts.push(billing ? `<button class="btn sm" data-tgobill>Go to the bill</button>` : `<button class="btn sm" data-tbill="${esc(t.id)}">Bill · ${inr(total)}</button>`);
  if(!s && can("manage_tables")) acts.push(`<button class="btn sm" data-tseat="${esc(t.id)}">Seat guests</button>`);
  return `<div class="card tpanel" id="tablePanel" data-tpanel="${esc(t.id)}"><div class="card-h"><div><h3>${esc(t.name)} ${chip(st)}</h3>
      <p class="note">${s ? `Seated ${esc(hhmm(s.t))} (${esc(ago(s.t))})${s.guests ? ` · ${s.guests} guest${s.guests === 1 ? "" : "s"}` : ""}${s.user ? ` · by ${esc(userLabel(s.user))}` : ""}${billing ? " · billing on the Sell screen" : ""}` : "Nobody seated"}${t.area ? " · " + esc(t.area) : ""}${t.seats ? ` · ${t.seats} seats` : ""}</p></div>
      <button class="iconbtn sm" data-tsel="" aria-label="Close ${esc(t.name)}">×</button></div>
    ${orders.length ? `<div class="tords">${orders.map(orderHTML).join("")}</div>${can("create_sale") ? `<div class="row tot tp-tot"><span>So far</span><span class="grand">${inr(total)}</span></div>` : ""}`
      : s ? `<p class="muted">No orders yet.</p>` : ""}
    ${acts.length ? `<div class="setactions">${acts.join("")}</div>` : ""}
    ${!s && lastSale ? `<p class="note">Last bill ${esc(lastSale.no || "")} at ${esc(hhmm(lastSale.t))} · ${inr(lastSale.total)}${lastSale.void ? " (cancelled)" : ""} <button class="link xs" data-billview="${esc(lastSale.id)}">Open bill</button></p>` : ""}</div>`;
}
function floorHTML(){
  const F = V(), list = tablesList();
  if(!list.length) return `<div class="empty"><b>No tables yet</b><p>${maySetUpTables() ? `Add your tables in <button class="link" data-tmode="setup">Set up</button>: a name or number each (T1, Garden 2…), with their QR codes for guests to order.` : "Ask the owner to add the restaurant's tables."}</p></div>`;
  const counts = {}; list.forEach(t => { const st = tableStateOf(t.id); counts[st] = (counts[st] || 0) + 1; });
  const sel = F.sel && tableById(F.sel);
  return `<div class="tsum">${Object.keys(TABLE_STATES).filter(k => counts[k]).map(k => `${chip(k)} <b>${counts[k]}</b>`).join(" ")}</div>
    <div class="tgrid">${list.map(t => cardHTML(t, F.sel)).join("")}</div>${sel ? panelHTML(sel) : ""}`;
}
function setupHTML(){
  const F = V(), all = tablesList(true), E = F.edit;
  const form = E ? `<form id="tableForm" class="card tform" autocomplete="off"><h4>${E.id ? "Edit " + esc(E.name0 || "table") : "New table"}</h4><div class="pgrid">
      <label class="f"><span class="lab">Name or number</span><input name="name" value="${esc(E.name)}" maxlength="20" placeholder="T1" required></label>
      <label class="f"><span class="lab">Seats <small>(optional)</small></span><input name="seats" value="${esc(E.seats == null ? "" : E.seats)}" inputmode="numeric" maxlength="2"></label>
      <label class="f"><span class="lab">Area <small>(optional)</small></span><input name="area" value="${esc(E.area || "")}" maxlength="30" placeholder="Garden, first floor…"></label></div>
      ${E.err ? `<p class="autherr" role="alert">${esc(E.err)}</p>` : ""}
      <div class="setactions"><button class="btn sm primary" type="submit">Save table</button><button class="btn sm" type="button" data-tedit="">Cancel</button></div></form>` : "";
  const qr = tableQrOn();
  return `<div class="otools"><button class="btn sm primary" data-tedit="new">+ Add table</button>${qr && all.some(t => t.active !== false) ? `<button class="btn sm" data-tqrall>Print all QR codes</button>` : ""}</div>
    ${!qr ? `<p class="note">Switch on <b>Table QR</b> in Settings → Capabilities to give each table a QR code guests scan to order.</p>` : guestOrderingOn() ? "" : `<p class="note">Guests see the menu from the QR code. To let them order from it too, switch on <b>Customer table ordering</b> in Settings → Capabilities.</p>`}
    ${form}
    ${all.length ? `<div class="olist">${all.map(t => `<div class="ocard${t.active === false ? " off" : ""}"><div class="oc-main"><b>${esc(t.name)}</b><small>${esc([t.area, t.seats ? t.seats + " seats" : "", t.active === false ? "not in use" : ""].filter(Boolean).join(" · ") || " ")}</small></div>
      <div class="oc-side"><span class="oc-acts">${t.active === false ? `<button class="btn xs" data-trest="${esc(t.id)}">Use again</button>` : `${qr ? `<button class="btn xs" data-tqr="${esc(t.id)}">QR code</button>` : ""}<button class="btn xs" data-tedit="${esc(t.id)}">Edit</button><button class="btn xs" data-tarch="${esc(t.id)}">Remove</button>`}</span></div></div>`).join("")}</div>`
      : `<p class="muted">No tables yet.</p>`}`;
}
export function renderTablesPage(){
  const host = $("#v-tables"); if(!host) return;
  // someone typing in the table form isn't interrupted by a live update
  const a = document.activeElement; if(a && host.contains(a) && a.matches && a.matches("input, select, textarea")) return;
  if(!mayWorkTables()){ host.innerHTML = `<div class="empty"><h2 class="vt">Tables</h2><p class="muted">${!store.profile ? "" : "Tables aren't in use for your role here."}</p></div>`; return; }
  const F = V(), setup = F.mode === "setup" && maySetUpTables();
  host.innerHTML = `<div class="viewhead"><div><h2 class="vt">Tables</h2><p>${setup ? "Your tables and their QR codes." : `Tap a table for its orders and bill.${kitchenOn() ? " Orders go to the kitchen screen." : ""}`}</p></div>
    ${maySetUpTables() ? `<div class="seg" role="group" aria-label="Tables"><button data-tmode="floor" aria-pressed="${!setup}">Floor</button><button data-tmode="setup" aria-pressed="${setup}">Set up</button></div>` : ""}</div>
    <div id="tablesBody">${setup ? setupHTML() : floorHTML()}</div>`;
}
