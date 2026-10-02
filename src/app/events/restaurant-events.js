// Delegated events of the restaurant: the tables floor and set-up, taking a table order, table QR codes, billing a
// table, and the kitchen screen. Each handler answers whether it took the event.
import { store } from '../../shared/state/store.js';
import { archiveTable, billTable, resetTableQr, restoreTable, saveTable, seatTable, setTableOrderStatus } from '../../features/restaurant/use-cases/tables.js';
import { openTableOrder, tableOrderClick, tableOrderInput } from '../../features/restaurant/components/table-order.js';
import { downloadTableQr, openTableQr, printTableQrs } from '../../features/restaurant/components/table-qr.js';
import { renderTablesPage } from '../../features/restaurant/pages/tables-page.js';
import { renderKitchenPage } from '../../features/restaurant/pages/kitchen-page.js';
import { tableById } from '../../features/restaurant/services/restaurant-state.js';
import { pullOrderChanges } from '../../features/sync/services/pull.js';
import { isMember } from '../../features/shop/services/access.js';
import { closeModal } from '../../shared/components/modal.js';
import { toast } from '../../shared/components/toast.js';
import { renderAll, setTab } from '../../shared/ui/render.js';

const V = () => store.tableView || (store.tableView = { mode: "floor", sel: null, edit: null });
const done = r => { if(r && r.error){ toast(r.error); return false; } renderAll(); return true; };
export function restaurantClick(t){
  if(tableOrderClick(t)) return true;
  const F = V();
  const sel = t.closest("[data-tbl]"); if(sel){ F.sel = F.sel === sel.dataset.tbl ? null : sel.dataset.tbl; renderTablesPage(); return true; }
  const close = t.closest("[data-tsel]"); if(close){ F.sel = close.dataset.tsel || null; renderTablesPage(); return true; }
  const mode = t.closest("[data-tmode]"); if(mode){ F.mode = mode.dataset.tmode; F.edit = null; renderTablesPage(); return true; }
  const no = t.closest("[data-tneworder]"); if(no){ openTableOrder(no.dataset.tneworder); return true; }
  const seat = t.closest("[data-tseat]"); if(seat){ done(seatTable(seat.dataset.tseat)); return true; }
  const serve = t.closest("[data-tserve]"); if(serve){ done(setTableOrderStatus(serve.dataset.tserve, "served")); return true; }
  const cancel = t.closest("[data-tcancel]"); if(cancel){ if(confirm("Cancel this order? The kitchen stops preparing it and it won't be on the bill.")) done(setTableOrderStatus(cancel.dataset.tcancel, "cancelled")); return true; }
  const bill = t.closest("[data-tbill]"); if(bill){ const r = billTable(bill.dataset.tbill); if(r.error){ toast(r.error); return true; } setTab("sell"); renderAll(); toast(`${(tableById(bill.dataset.tbill) || {}).name || "The table"} is on the bill: take the payment.`); return true; }
  if(t.closest("[data-tgobill]")){ setTab("sell"); renderAll(); return true; }
  const ed = t.closest("[data-tedit]"); if(ed){ const id = ed.dataset.tedit, x = id && id !== "new" ? tableById(id) : null;
    F.edit = id ? (x ? { id: x.id, name: x.name, name0: x.name, area: x.area, seats: x.seats, err: "" } : { name: "", area: "", seats: "", err: "" }) : null; renderTablesPage();
    const n = document.querySelector("#tableForm [name=name]"); if(n) n.focus(); return true; }
  const arch = t.closest("[data-tarch]"); if(arch){ if(confirm("Remove this table? Its QR code stops working; its history stays.")) done(archiveTable(arch.dataset.tarch)); return true; }
  const rest = t.closest("[data-trest]"); if(rest){ done(restoreTable(rest.dataset.trest)); return true; }
  const qr = t.closest("[data-tqr]"); if(qr){ openTableQr(qr.dataset.tqr); return true; }
  const qp = t.closest("[data-tqrprint]"); if(qp){ printTableQrs([qp.dataset.tqrprint]); return true; }
  const qd = t.closest("[data-tqrdl]"); if(qd){ downloadTableQr(qd.dataset.tqrdl); return true; }
  const qn = t.closest("[data-tqrreset]"); if(qn){ if(confirm("Make a new QR code for this table? The old one (printed cards) stops working.")){ const r = resetTableQr(qn.dataset.tqrreset); if(r.error) toast(r.error); else { openTableQr(qn.dataset.tqrreset); toast("New QR code made: print it for the table."); } } return true; }
  if(t.closest("[data-tqrall]")){ printTableQrs(); return true; }
  const ks = t.closest("[data-kstep]"); if(ks){ const i = ks.dataset.kstep.lastIndexOf(":"), id = ks.dataset.kstep.slice(0, i), st = ks.dataset.kstep.slice(i + 1);
    if(st === "cancelled" && !confirm("Cancel this order?")) return true;
    const r = setTableOrderStatus(id, st); if(r.error) toast(r.error); else renderKitchenPage(); return true; }
  return false;
}
export const restaurantInput = t => tableOrderInput(t);
export const restaurantChange = () => false;
export function restaurantSubmit(e){
  if(e.target.id !== "tableForm") return false;
  e.preventDefault();
  const F = V(), f = new FormData(e.target), E = F.edit || {};
  const r = saveTable({ id: E.id, name: f.get("name"), area: f.get("area"), seats: f.get("seats") });
  if(r.error){ F.edit = { ...E, name: f.get("name"), area: f.get("area"), seats: f.get("seats"), err: r.error }; renderTablesPage(); return true; }
  F.edit = null; closeModal(); renderAll(); toast(`Table ${r.table.name} saved.`);
  return true;
}
/* Registered once at start-up: the kitchen's and the floor's clocks ("12 min"), and — on a team member's phone, which
   gets no live updates — a quicker look for new orders while one of these screens is open */
let installed = false;
export function installRestaurantTimers(){
  if(installed) return; installed = true;
  setInterval(() => {
    const tab = store.prefs && store.prefs.tab;
    if(tab !== "kitchen" && tab !== "tables") return;
    if(isMember() && store.sbStatus === "connected") pullOrderChanges().catch(() => {});
    const a = document.activeElement; if(a && a.matches && a.matches("input, select, textarea")) return;
    if(tab === "kitchen") renderKitchenPage(); else if(!store.tableView || !store.tableView.order) renderTablesPage();
  }, 10000);
}
