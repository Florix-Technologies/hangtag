// The quotation / sales order editor: customer, lines (quantity, price, discount; GST as a bill would charge it), bill
// discount, validity (quotations), notes and status, with the totals from the one bill calculation. Saving goes through
// the orders use cases (features/orders/use-cases/orders.js); a final order (converted, completed, cancelled) is shown
// read-only. store.orderForm = { o (the order being edited, a copy), q (product search), err, field, line }
import { KIND_LABELS, cartBlock, isFinal, nextStatuses, shownStatus, statusLabel } from '../../../domain/orders/orders.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { unitOf } from '../../../domain/catalog/units.js';
import { store } from '../../../shared/state/store.js';
import { convertToSalesOrder, duplicateQuotation, newOrderDraft, orderById, orderLine, orderToCart, orderTotals, saveOrder, todayKey } from '../use-cases/orders.js';
import { customerRepository } from '../../customers/repositories/customer-repository.js';
import { liveProducts } from '../../products/services/catalog.js';
import { productText, variantText } from '../../sales/services/search.js';
import { stockOf } from '../../inventory/services/stock.js';
import { discountRowsHTML, gstRowsHTML, roundRowHTML, sumRow } from '../../sales/components/bill-summary.js';
import { vLabel, vPrice } from '../../../domain/catalog/variants.js';
import { can } from '../../shop/services/access.js';
import { chooseSubview } from '../../shop/services/modules.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { norm } from '../../../shared/utils/text.js';
import { renderAll, setTab } from '../../../shared/ui/render.js';

const copy = o => JSON.parse(JSON.stringify(o));
/* Open an order (id), or a new one of a kind (from the bill on the screen when fromCart) */
export function openOrderEditor(id, kind, fromCart){
  const o = id ? orderById(id) : newOrderDraft(kind, fromCart ? { cart: store.cart, disc: store.disc, cust: store.cartCust } : {});
  if(!o) return;
  store.orderForm = { o: copy(o), q: "", err: "", field: "", line: null };
  renderOrderEditor(true);
}
const editable = F => can("create_order") && !isFinal(orderById(F.o.id) || F.o);
function hitsHTML(F){
  const toks = norm(F.q).split(/\s+/).filter(Boolean); if(!toks.length) return "";
  const out = [];
  liveProducts().forEach(p => { const pt = productText(p); variantsOf(p).forEach(v => { if(out.length < 8 && toks.every(t => pt.includes(t) || variantText(p, v).includes(t))) out.push({ p, v }); }); });
  if(!out.length) return `<p class="muted">Nothing matches “${esc(F.q)}”.</p>`;
  return out.map(({ p, v }) => `<button type="button" class="ohit" data-ofadd="${esc(v.id)}"><b>${esc(p.name)}</b><span>${esc(vLabel(v) || "")}</span><span class="tnum">${inr(vPrice(p, v))} · ${stockOf(v.id)} in stock</span></button>`).join("");
}
function linesHTML(F, T, ed){
  const o = F.o, dis = ed ? "" : " disabled";
  if(!o.items.length) return `<p class="muted">No items yet. Search below to add them.</p>`;
  return o.items.map((l, i) => { const L = T.lines[i] || {}, d = l.disc || null, bad = F.line === i ? " bad" : "";
    return `<div class="oline${bad}" data-ofline="${i}"><div class="ol-n"><b>${esc(l.name)}</b><small>${esc(l.vl || "")}${l.gst != null && T.mode !== "none" ? ` · GST ${esc(String(l.gst))}%` : ""}${+l.fq > 0 ? ` · ${l.fq} delivered` : ""}</small></div>
      <label class="f ol-q"><span class="lab">Qty${l.u&&l.u!=="pcs"?` (${esc(unitOf(l.u).sym)})`:""}</span><input data-ofl="q:${i}" value="${esc(l.q)}" type="number" inputmode="decimal" min="0" step="any"${dis}></label>
      <label class="f ol-p"><span class="lab">Price</span><input data-ofl="price:${i}" value="${esc(l.price)}" type="number" inputmode="decimal" min="0" step="any"${dis}></label>
      <label class="f ol-d"><span class="lab">Discount</span><span class="ol-dw"><select data-ofl="dt:${i}" aria-label="Discount in percent or rupees"${dis}><option value="percent"${!d || d.type === "percent" ? " selected" : ""}>%</option><option value="fixed"${d && d.type === "fixed" ? " selected" : ""}>₹</option></select><input data-ofl="dv:${i}" value="${esc(d ? d.value : "")}" type="number" inputmode="decimal" min="0" step="any" placeholder="0"${dis}></span></label>
      <span class="ol-t tnum" data-oflt="${i}">${inrx(L.total || 0)}</span>${ed && !(+l.fq > 0) ? `<button type="button" class="iconbtn sm" data-oflrm="${i}" aria-label="Remove ${esc(l.name)}">${ICON.x}</button>` : ""}</div>`; }).join("");
}
const totalsHTML = T => sumRow("Subtotal", inrx(T.sub)) + discountRowsHTML(T, null) + gstRowsHTML(T) + roundRowHTML(T) + `<div class="row tot"><span>Total</span><span class="grand">${inr(T.total)}</span></div>`;
export function renderOrderEditor(focus){
  const F = store.orderForm; if(!F){ return; }
  const o = F.o, saved = orderById(o.id), ed = editable(F), T = orderTotals(o), today = todayKey(), st = saved ? shownStatus(saved, today) : o.status, dis = ed ? "" : " disabled";
  const custs = customerRepository().list().slice().sort((a, b) => a.name.localeCompare(b.name));
  const bd = o.billDisc || null, what = KIND_LABELS[o.kind];
  const statuses = saved ? nextStatuses(saved) : [o.status];
  const billable = saved && !cartBlock(saved, today);
  $("#modalHost").innerHTML = `<div class="scrim" data-modal-scrim><div class="sheet ordersheet" id="orderSheet" role="dialog" aria-modal="true" aria-labelledby="ofT">
    <div class="sh-head"><div class="sh-t"><h3 id="ofT">${saved ? esc(what + " " + (saved.no || "")) : "New " + what.toLowerCase()}</h3><p>${saved ? `<span class="ostat ostat-${esc(st)}">${esc(statusLabel(saved.kind,st))}</span>` : "Not saved yet"}${saved && saved.convertedTo && orderById(saved.convertedTo) ? ` · became ${esc(orderById(saved.convertedTo).no)}` : ""}${saved&&saved.quoteNo?` · from ${esc(saved.quoteNo)}`:""}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <label class="f"><span class="lab">Customer</span><select data-ofcust${dis}><option value="">Choose the customer…</option>${custs.map(c => `<option value="${esc(c.id)}"${o.cust && o.cust.id === c.id ? " selected" : ""}>${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("")}${o.cust && o.cust.id && !custs.some(c => c.id === o.cust.id) ? `<option value="${esc(o.cust.id)}" selected>${esc(o.cust.name || "Customer")}</option>` : ""}</select></label>
    <h4 class="custh">Items</h4>
    <div class="olines">${linesHTML(F, T, ed)}</div>
    ${ed ? `<div class="search osearch"><input id="ofQ" type="search" placeholder="Add an item: search name, SKU or barcode" autocomplete="off" value="${esc(F.q)}" aria-label="Search products to add"></div><div class="ohits" id="ofHits">${hitsHTML(F)}</div>` : ""}
    <div class="pgrid2">
      <label class="f"><span class="lab">Bill discount</span><span class="ol-dw"><select data-off="bdt"${dis}><option value="percent"${!bd || bd.type === "percent" ? " selected" : ""}>%</option><option value="fixed"${bd && bd.type === "fixed" ? " selected" : ""}>₹</option></select><input data-off="bdv" value="${esc(bd ? bd.value : "")}" type="number" inputmode="decimal" min="0" step="any" placeholder="0"${dis}></span></label>
      ${o.kind === "quote" ? `<label class="f"><span class="lab">Valid until</span><input type="date" data-off="validUntil" value="${esc(o.validUntil || "")}"${dis}></label>` : ""}
      ${saved && ed && statuses.length > 1 ? `<label class="f"><span class="lab">Status</span><select data-off="status">${statuses.map(s => `<option value="${s}"${s === o.status ? " selected" : ""}>${esc(statusLabel(o.kind,s))}</option>`).join("")}</select></label>` : ""}
    </div>
    <label class="f"><span class="lab">Notes <small>(optional)</small></span><textarea data-off="notes" rows="2" maxlength="500"${dis}>${esc(o.notes || "")}</textarea></label>
    ${o.kind==="quote"?`<label class="f"><span class="lab">Terms &amp; conditions <small>(optional)</small></span><textarea data-off="terms" rows="3" maxlength="2000"${dis}>${esc(o.terms||"")}</textarea></label>`:""}
    <div class="paysum" id="ofTotals">${totalsHTML(T)}</div>
    <p class="err" id="ofErr" role="alert"${F.err ? "" : " hidden"}>${esc(F.err)}</p>
    <div class="setactions of-actions">${ed ? `<button class="btn primary sm" data-ofsave>${saved ? "Save changes" : "Save " + what.toLowerCase()}</button>` : ""}
      ${saved&&saved.kind==="quote"?`<button class="btn sm" data-qdoc="preview" data-id="${esc(saved.id)}">Preview</button><button class="btn sm" data-qdoc="print" data-id="${esc(saved.id)}">Print</button><button class="btn sm" data-qdoc="download" data-id="${esc(saved.id)}">Download PDF</button><button class="btn sm" data-qdoc="send" data-id="${esc(saved.id)}">Send</button>${can("create_order")?`<button class="btn sm" data-ofdup>Duplicate</button>`:""}`:""}
      ${saved && saved.kind === "quote" && billable && can("create_order") ? `<button class="btn sm" data-ofconvert>Make it a sales order</button>` : ""}
      ${billable && can("create_sale") ? `<button class="btn sm" data-ofbill>Bill ${saved.kind === "sales" && (saved.items || []).some(l => +l.fq > 0) ? "what's left" : "it"}</button>` : ""}</div>
  </div></div>`;
  if(focus){ const f = $("#orderSheet [data-ofcust]"); if(f && !o.cust) f.focus({ preventScroll: true }); }
}
/* A figure changed: redraw the totals and line amounts only (the box keeps its cursor) */
function updateTotals(){
  const F = store.orderForm, T = orderTotals(F.o), box = $("#ofTotals"); if(box) box.innerHTML = totalsHTML(T);
  T.lines.forEach((L, i) => { const el = $(`#orderSheet [data-oflt="${i}"]`); if(el) el.textContent = inrx(L.total); });
  const err = $("#ofErr"); if(err && F.err){ F.err = ""; err.hidden = true; }
}
/* A discount as typed: { type, value } (value may be "" while typing; an empty one is dropped when saving) */
const setDisc = (cur, type, value) => ({ type: type || (cur && cur.type) || "percent", value: value == null ? (cur ? cur.value : "") : value });
/* Typing in the editor → true when handled */
export function orderFormInput(t){
  const F = store.orderForm; if(!F || !t.closest || !t.closest("#orderSheet")) return false;
  if(t.id === "ofQ"){ F.q = t.value; const h = $("#ofHits"); if(h) h.innerHTML = hitsHTML(F); return true; }
  if(t.dataset.ofl){ const [k, i] = t.dataset.ofl.split(":"), l = F.o.items[+i]; if(!l) return true;
    if(k === "q" || k === "price") l[k] = t.value; else if(k === "dv") l.disc = setDisc(l.disc, null, t.value);
    updateTotals(); return true; }
  if(t.dataset.off === "bdv"){ F.o.billDisc = setDisc(F.o.billDisc, null, t.value); updateTotals(); return true; }
  if(t.dataset.off === "notes"){ F.o.notes = t.value; return true; }
  if(t.dataset.off === "terms"){ F.o.terms = t.value; return true; }
  return false;
}
/* Choices in the editor → true when handled */
export function orderFormChange(t){
  const F = store.orderForm; if(!F || !t.closest || !t.closest("#orderSheet")) return false;
  if(t.matches("[data-ofcust]")){ const c = customerRepository().get(t.value); F.o.cust = c ? { id:c.id,name:c.name,phone:c.phone||"",...(c.email?{email:c.email}:{}),...(c.gstin?{gstin:c.gstin}:{}),...(c.type==="business"?{type:"business"}:{}) } : null; renderOrderEditor(false); return true; }
  if(t.dataset.ofl && t.dataset.ofl.startsWith("dt:")){ const l = F.o.items[+t.dataset.ofl.slice(3)]; if(l) l.disc = setDisc(l.disc, t.value, null); updateTotals(); return true; }
  if(t.dataset.off === "bdt"){ F.o.billDisc = setDisc(F.o.billDisc, t.value, null); updateTotals(); return true; }
  if(t.dataset.off === "validUntil"){ F.o.validUntil = t.value; return true; }
  if(t.dataset.off === "status"){ F.o.status = t.value; return true; }
  if(t.dataset.ofl){ return orderFormInput(t); }
  return false;
}
/* The order as typed → numbers, and discounts left empty dropped (a bad number stays, so the checks name it) */
const typed = d => d && String(d.value == null ? "" : d.value).trim() !== "" ? { type: d.type === "fixed" ? "fixed" : "percent", value: +d.value } : null;
function cleanLines(o){
  return { ...o, items: o.items.map(l => { const x = { ...l, q: String(l.q).trim() === "" ? "" : +l.q, price: String(l.price).trim() === "" ? "" : +l.price }, d = typed(l.disc);
    if(d) x.disc = d; else delete x.disc; return x; }), billDisc: typed(o.billDisc) };
}
/* Buttons in the editor → true when handled */
export function orderFormClick(t){
  const F = store.orderForm; if(!F || !t.closest("#orderSheet")) return false;
  const add = t.closest("[data-ofadd]");
  if(add){ const same = F.o.items.find(l => l.v === add.dataset.ofadd && !(+l.fq > 0));
    if(same) same.q = (+same.q || 0) + 1; else { const l = orderLine(add.dataset.ofadd, 1); if(l) F.o.items.push({ ...l, ln: undefined }); }
    F.q = ""; renderOrderEditor(false); const q = $("#ofQ"); if(q) q.focus({ preventScroll: true }); return true; }
  const rm = t.closest("[data-oflrm]"); if(rm){ F.o.items.splice(+rm.dataset.oflrm, 1); renderOrderEditor(false); return true; }
  if(t.closest("[data-ofsave]")){
    const r = saveOrder(cleanLines(F.o));
    if(r.error){ F.err = r.error; F.field = r.field || ""; F.line = r.line == null ? null : r.line; renderOrderEditor(false); return true; }
    store.orderForm = { o: copy(r.order), q: "", err: "", field: "", line: null }; renderOrderEditor(false); renderAll();
    toast(`${KIND_LABELS[r.order.kind]} ${r.order.no} saved.`); return true; }
  if(t.closest("[data-ofconvert]")){ convertAction(F.o.id); return true; }
  if(t.closest("[data-ofdup]")){ const r=duplicateQuotation(F.o.id); if(r.error){toast(r.error);return true;} store.orderForm={o:copy(r.order),q:"",err:"",field:"",line:null}; renderOrderEditor(false); renderAll(); toast(`Quotation ${r.order.no} duplicated.`); return true; }
  if(t.closest("[data-ofbill]")){ billAction(F.o.id); return true; }
  return false;
}
/* A quotation becomes a sales order (from the list or the editor) */
export function convertAction(id){
  const r = convertToSalesOrder(id);
  if(r.error){ toast(r.error); return; }
  chooseSubview("orders", "sales"); store.orderForm = { o: copy(r.order), q: "", err: "", field: "", line: null };
  renderAll(); renderOrderEditor(false); toast(`Sales order ${r.order.no} made from quotation ${r.quote.no}.`);
}
/* What is left on an order goes on the bill; the Sell screen opens to take the payment */
export function billAction(id){
  const r = orderToCart(id);
  if(r.error){ toast(r.error); return; }
  store.orderForm = null; closeModal(); setTab("sell"); renderAll();
  const o = orderById(id);
  toast(`${o ? o.no : "The order"} is on the bill.${r.skipped.length ? " Not added: " + r.skipped.map(s => `${s.name} (${s.why})`).join(", ") + "." : ""}${r.lines.some(l => l.short) ? " Some lines are short of stock: only what's in stock went on the bill." : ""}`);
}
