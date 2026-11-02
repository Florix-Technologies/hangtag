// Taking an order for a table (a server at the table, or the till): the menu (search, categories), what the guests want
// with quantities and notes, then Send to the kitchen — an order of kind "table" for the table's session. Nothing here
// changes stock or money: the table's bill does, when it is paid.
// store.tableView.order = { table, lines: [{ v, q, note }], q (search), cat, note, err }
import { store } from '../../../shared/state/store.js';
import { vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { categories, liveProducts } from '../../products/services/catalog.js';
import { productText, variantText } from '../../sales/services/search.js';
import { vRec } from '../../inventory/services/ledger.js';
import { sendTableOrder } from '../use-cases/tables.js';
import { kitchenOn, tableById } from '../services/restaurant-state.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { norm } from '../../../shared/utils/text.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';

const MAX_SHOWN = 60;
export function openTableOrder(tableId){
  const t = tableById(tableId); if(!t) return;
  store.tableView = Object.assign({}, store.tableView, { sel: tableId, order: { table: tableId, lines: [], q: "", cat: "", note: "", err: "" } });
  renderTableOrder();
  const q = $("#toQ"); if(q) q.focus({ preventScroll: true });
}
const O = () => store.tableView && store.tableView.order;
function menuHTML(o){
  const toks = norm(o.q).split(/\s+/).filter(Boolean), out = [];
  liveProducts().forEach(p => { if(o.cat && p.cat !== o.cat) return; variantsOf(p).forEach(v => {
    if(out.length < MAX_SHOWN && (!toks.length || toks.every(k => productText(p).includes(k) || variantText(p, v).includes(k)))) out.push({ p, v }); }); });
  if(!out.length) return `<p class="muted">Nothing on the menu matches.</p>`;
  return out.map(({ p, v }) => { const n = o.lines.filter(l => l.v === v.id).reduce((a, l) => a + l.q, 0);
    return `<button type="button" class="tomenu" data-toadd="${esc(v.id)}"><b>${esc(p.name)}</b>${vLabel(v) ? `<small>${esc(vLabel(v))}</small>` : ""}<span class="tnum">${inr(vPrice(p, v))}</span>${n ? `<em>${n}</em>` : ""}</button>`; }).join("");
}
function linesHTML(o){
  if(!o.lines.length) return `<p class="muted">Tap an item to add it.</p>`;
  return o.lines.map((l, i) => { const r = vRec(l.v); if(!r) return "";
    return `<div class="toline"><div class="tol-n"><b>${esc(r.p.name)}</b>${vLabel(r.v) ? `<small>${esc(vLabel(r.v))}</small>` : ""}<input data-tonote="${i}" value="${esc(l.note || "")}" maxlength="120" placeholder="Note (less spicy, no onion…)" aria-label="Note for ${esc(r.p.name)}"></div>
      <span class="step"><button type="button" data-todec="${i}" aria-label="One less">−</button><b>${l.q}</b><button type="button" data-toinc="${i}" aria-label="One more">+</button></span></div>`; }).join("");
}
export function renderTableOrder(){
  const o = O(); if(!o){ closeModal(); return; }
  const t = tableById(o.table); if(!t){ closeModal(); return; }
  const cats = categories(), n = o.lines.reduce((a, l) => a + l.q, 0), amt = o.lines.reduce((a, l) => { const r = vRec(l.v); return a + (r ? l.q * vPrice(r.p, r.v) : 0); }, 0);
  $("#modalHost").innerHTML = `<div class="scrim" data-modal-scrim data-keep><div class="sheet tosheet" id="tableOrderSheet" role="dialog" aria-modal="true" aria-label="New order for table ${esc(t.name)}">
    <div class="sh-head"><div class="sh-t"><h3>New order · ${esc(t.name)}</h3><p>${kitchenOn() ? "Sent to the kitchen screen." : "Kept on the table until its bill."}</p></div><button class="iconbtn" data-toclose aria-label="Close">${ICON.x}</button></div>
    <div class="search"><input id="toQ" type="search" placeholder="Search the menu" value="${esc(o.q)}" autocomplete="off" aria-label="Search the menu"></div>
    ${cats.length ? `<div class="chips tocats"><button type="button" class="chip${o.cat ? "" : " on"}" data-tocat="">All</button>${cats.map(c => `<button type="button" class="chip${o.cat === c ? " on" : ""}" data-tocat="${esc(c)}">${esc(c)}</button>`).join("")}</div>` : ""}
    <div class="tomenus" id="toMenu">${menuHTML(o)}</div>
    <h4 class="custh">This order</h4>
    <div class="tolines">${linesHTML(o)}</div>
    <label class="f"><span class="lab">Note for the kitchen <small>(optional)</small></span><input id="toNote" value="${esc(o.note)}" maxlength="200"></label>
    ${o.err ? `<p class="autherr" role="alert">${esc(o.err)}</p>` : ""}
    <div class="sh-foot"><span class="pk-sum">${n ? `<b>${n} item${n === 1 ? "" : "s"}</b> · ${inr(amt)}` : "Nothing yet"}</span><div class="sh-acts"><button class="btn sm" data-toclose>Cancel</button><button class="btn sm primary" data-tosend${n ? "" : " disabled"}>${kitchenOn() ? "Send to kitchen" : "Save order"}</button></div></div>
  </div></div>`;
}
/* ---------- events (app/events/restaurant-events.js) ---------- */
export function tableOrderClick(t){
  const o = O(); if(!o || !t.closest("#tableOrderSheet, [data-modal-scrim]")) return false;
  if(t.matches("[data-modal-scrim]")) return true;   // a tap beside the sheet never loses the order being taken
  if(t.closest("[data-toclose]")){ store.tableView.order = null; closeModal(); return true; }
  const add = t.closest("[data-toadd]");
  if(add){ const l = o.lines.find(x => x.v === add.dataset.toadd && !x.note); if(l) l.q++; else o.lines.push({ v: add.dataset.toadd, q: 1, note: "" }); o.err = ""; renderTableOrder(); return true; }
  const inc = t.closest("[data-toinc]"); if(inc){ const l = o.lines[+inc.dataset.toinc]; if(l) l.q++; renderTableOrder(); return true; }
  const dec = t.closest("[data-todec]"); if(dec){ const i = +dec.dataset.todec, l = o.lines[i]; if(l){ l.q--; if(l.q <= 0) o.lines.splice(i, 1); } renderTableOrder(); return true; }
  const cat = t.closest("[data-tocat]"); if(cat){ o.cat = cat.dataset.tocat; renderTableOrder(); return true; }
  if(t.closest("[data-tosend]")){
    const r = sendTableOrder(o.table, o.lines, o.note);
    if(r.error){ o.err = r.error; renderTableOrder(); return true; }
    store.tableView.order = null; closeModal(); renderAll();
    toast(`${r.order.no} ${kitchenOn() ? "sent to the kitchen" : "saved"} · ${(tableById(o.table) || {}).name || ""}`);
    return true;
  }
  return false;
}
export function tableOrderInput(t){
  const o = O(); if(!o || !t.closest || !t.closest("#tableOrderSheet")) return false;
  if(t.id === "toQ"){ o.q = t.value; const m = $("#toMenu"); if(m) m.innerHTML = menuHTML(o); return true; }
  if(t.dataset.tonote != null){ const l = o.lines[+t.dataset.tonote]; if(l) l.note = t.value; return true; }
  if(t.id === "toNote"){ o.note = t.value; return true; }
  return false;
}
