// The kitchen screen: every table order still to prepare, oldest first, by step — New, Accepted, Preparing, Ready — with
// what the cooks need: the ticket number, the table, the items and quantities, the notes, how long ago it came in. No
// prices, bills or anything else of the shop. A tap moves a ticket to its next step (served takes it off the screen).
import { KITCHEN_LABELS, kitchenTickets, nextKitchenStep } from '../../../domain/restaurant/tables.js';
import { kitchenOrders, mayUseKitchen, tableName } from '../services/restaurant-state.js';
import { can } from '../../shop/services/access.js';
import { $, esc } from '../../../shared/dom.js';
import { hhmm } from '../../../shared/formatting/dates.js';
import { fmtQty } from '../../../domain/catalog/units.js';

const STEP_BUTTON = { new: "Accept", accepted: "Start preparing", preparing: "Ready", ready: "Served" };
const age = t => { const m = Math.max(0, Math.round((Date.now() - (t || 0)) / 60000)); return m < 1 ? "just now" : m + " min"; };
function ticketHTML(o){
  const next = nextKitchenStep(o.status), late = Date.now() - (o.t || 0) > 20 * 60000 && o.status !== "ready";
  return `<div class="kt st-${esc(o.status)}${late ? " late" : ""}" data-kt="${esc(o.id)}"><div class="kt-h"><b class="kt-table">${esc(tableName(o.tableId) || "Table")}</b><span>${esc(o.no || "")}</span><span class="kt-age" title="${esc(hhmm(o.t))}">${esc(age(o.t))}</span></div>
    ${o.source === "customer" ? `<p class="kt-src">Ordered by the guests (QR)</p>` : ""}
    <ul>${(o.items || []).map(l => `<li><b>${esc(fmtQty(l.q))} ×</b> ${esc(l.name)}${l.vl ? ` <small>${esc(l.vl)}</small>` : ""}${l.note ? `<em>${esc(l.note)}</em>` : ""}</li>`).join("")}</ul>
    ${o.notes ? `<p class="kt-note">${esc(o.notes)}</p>` : ""}
    <div class="kt-a">${next && (next !== "served" || can("create_order") || can("manage_kitchen")) ? `<button class="btn sm primary" data-kstep="${esc(o.id)}:${next}">${STEP_BUTTON[o.status]}</button>` : ""}<button class="link xs danger" data-kstep="${esc(o.id)}:cancelled">Cancel</button></div></div>`;
}
export function renderKitchenPage(){
  const host = $("#v-kitchen"); if(!host) return;
  if(!mayUseKitchen()){ host.innerHTML = `<div class="empty"><h2 class="vt">Kitchen</h2><p class="muted">The kitchen screen isn't in use for your role here.</p></div>`; return; }
  const by = kitchenTickets(kitchenOrders()), n = Object.values(by).reduce((a, l) => a + l.length, 0);
  host.innerHTML = `<div class="viewhead"><div><h2 class="vt">Kitchen</h2><p>${n ? `${n} order${n === 1 ? "" : "s"} to prepare, oldest first.` : "No orders to prepare."}</p></div></div>
    <div class="kcols">${["new", "accepted", "preparing", "ready"].map(st => `<section class="kcol" aria-label="${KITCHEN_LABELS[st]}"><h3>${KITCHEN_LABELS[st]} <span>${by[st].length}</span></h3>${by[st].map(ticketHTML).join("") || `<p class="muted">—</p>`}</section>`).join("")}</div>`;
}
