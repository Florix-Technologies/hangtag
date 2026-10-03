// Price lists on the phone: on the bill a single chip ("Prices: Wholesale ▾", two taps to change), and for the owner a
// short list of lists with one editor (name, default, in use, item prices found by search). Dates are folded away
// until needed. The rules are in domain/sales/pricing.js, the work in use-cases/price-lists.js.
import { productKey, variantKey } from '../../../domain/sales/pricing.js';
import { vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { can } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { liveProducts } from '../../products/services/catalog.js';
import { billList, billLists, priceLists } from '../../sales/services/pricing.js';
import { allLists, chooseBillList, listById, removePriceList, savePriceList, setItemPrice } from '../use-cases/price-lists.js';
import { bizError, bizSheet, chip, closeBiz } from './biz-sheet.js';

const V = () => store.bizView || {};
/* ---------- on the bill ---------- */
/* "Prices: Retail ▾" under the customer (only for shops with price lists) */
export function priceListChipHTML(){
  if(!hasCap("uses_price_lists") || !priceLists().length) return "";
  const { list, locked } = billList();
  return `<div class="plline"><span>Prices</span><button type="button" class="chipbtn plchip" data-biz="plpick" aria-label="Price list: ${esc(list ? list.name : "Normal prices")}${locked ? ", the customer's own list" : ""}">${esc(list ? list.name : "Normal prices")}${locked ? " · customer's" : ""} ▾</button></div>`;
}
export function openPricePicker(){
  store.bizView = { kind: "plpick" };
  const { list, locked } = billList(), cur = list ? list.id : "";
  if(locked){
    bizSheet({ label: "Prices on this bill", body: `<p class="note">${esc(store.cartCust ? store.cartCust.name : "This customer")} buys at <b>${esc(list.name)}</b> prices (their own list, set in Customers). Remove the customer from the bill to use another list.</p>`,
      foot: `<button type="button" class="btn sm primary" data-biz="close">OK</button>` });
    return;
  }
  const opts = [{ id: "", name: "Normal prices", hint: "Each product's own price" }, ...billLists().map(l => ({ id: l.id, name: l.name, hint: l.isDefault ? "Default" : "" }))];
  bizSheet({ label: "Prices on this bill", body: `<div class="plopts">${opts.map(o => `<button type="button" class="plopt" data-plchoose="${esc(o.id)}" aria-pressed="${o.id === cur}"><b>${esc(o.name)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ""}</button>`).join("")}</div>`
    + (can("manage_products") ? `<button type="button" class="link xs" data-biz="plmanage">Manage price lists</button>` : "") });
}
/* ---------- the owner's lists ---------- */
export function openPriceLists(){
  store.bizView = { kind: "pllist", err: "" };
  const lists = allLists();
  const rows = lists.map(l => `<button type="button" class="bizrow" data-pledit="${esc(l.id)}"><span><b>${esc(l.name)}</b><small>${Object.keys(l.prices).length} price${Object.keys(l.prices).length === 1 ? "" : "s"}${l.from || l.to ? ` · ${esc(l.from || "…")} to ${esc(l.to || "…")}` : ""}</small></span>${l.isDefault ? chip("Default", "ok") : ""}${l.active ? "" : chip("Not in use")}</button>`).join("");
  bizSheet({ label: "Price lists", sub: "Wholesale, distributor or special prices. Products not on a list keep their own price.",
    body: (rows ? `<div class="bizlist">${rows}</div>` : `<p class="muted">No price lists yet.</p>`)
      + `<form id="plNew" class="bizinline" autocomplete="off"><input name="name" maxlength="40" placeholder="New list, e.g. Wholesale" aria-label="Name of the new price list"><button type="submit" class="btn sm primary">Add</button></form>` });
}
export function openPriceListEditor(id){
  const l = listById(id); if(!l){ openPriceLists(); return; }
  store.bizView = { kind: "pledit", id, q: V().kind === "pledit" && V().id === id ? V().q || "" : "", more: !!(l.from || l.to), err: "" };
  renderPriceListEditor();
}
function itemRows(l, q){
  const s = String(q || "").trim().toLowerCase();
  const ps = liveProducts().filter(p => !s || p.name.toLowerCase().includes(s) || variantsOf(p).some(v => String(v.sku || "").toLowerCase() === s || String(v.bc || "") === s));
  // with nothing typed: the products already on the list first
  const on = p => variantsOf(p).some(v => l.prices[variantKey(v.id)]) || l.prices[productKey(p.id)];
  const list = (s ? ps : ps.filter(on).concat(ps.filter(p => !on(p)))).slice(0, 30);
  return list.map(p => {
    const vs = variantsOf(p), multi = vs.length > 1 && new Set(vs.map(v => vPrice(p, v))).size > 1;
    const input = (key, base, label) => `<label class="plrow"><span><b>${esc(label)}</b><small>Normal ${inr(base)}</small></span><input type="number" inputmode="decimal" min="0" step="any" data-plprice="${esc(key)}" value="${l.prices[key] != null ? esc(String(l.prices[key])) : ""}" placeholder="${esc(String(base))}" aria-label="${esc(label)} price on ${esc(l.name)}"></label>`;
    return multi ? `<div class="plgroup"><div class="plgh">${esc(p.name)}</div>${vs.map(v => input(variantKey(v.id), vPrice(p, v), vLabel(v) || p.name)).join("")}</div>` : input(productKey(p.id), vPrice(p, vs[0]), p.name);
  }).join("") || `<p class="muted">No product matches.</p>`;
}
export function renderPriceListEditor(){
  const l = listById(V().id); if(!l){ openPriceLists(); return; }
  bizSheet({ label: l.name, sub: "Type a price to put a product on this list. Leave it empty to keep the normal price.",
    body: `<form id="plForm" class="pgrid" autocomplete="off">
      <label class="f full">Name<input name="name" value="${esc(l.name)}" maxlength="40" required></label>
      <label class="chk"><input type="checkbox" name="isDefault"${l.isDefault ? " checked" : ""}> Default list (used when nothing else is chosen)</label>
      <label class="chk"><input type="checkbox" name="active"${l.active ? " checked" : ""}> In use</label>
      <details${V().more ? " open" : ""}><summary>Only between certain days</summary><div class="pgrid"><label class="f">From<input type="date" name="from" value="${esc(l.from)}"></label><label class="f">To<input type="date" name="to" value="${esc(l.to)}"></label></div></details>
      <button type="submit" hidden></button></form>
      <input type="search" class="bizsearch" data-plq value="${esc(V().q || "")}" placeholder="Search or scan a product" aria-label="Search products">
      <div class="plitems" data-plitems>${itemRows(l, V().q)}</div>`,
    foot: `${l.isDefault ? "" : `<button type="button" class="btn sm danger" data-biz="pldel">Remove list</button>`}<button type="button" class="btn sm primary" data-biz="plsave">Save</button>` });
}
/* ---------- events (app/events/commerce-events.js) ---------- */
export function priceListsClick(t){
  const ch = t.closest("[data-plchoose]");
  if(ch){ const r = chooseBillList(ch.dataset.plchoose || null); closeBiz(); renderAll(); if(r.error) toast(r.error); else { const { list } = billList(); toast(`Prices: ${list ? list.name : "normal prices"}${r.changed ? ` · ${r.changed} line${r.changed === 1 ? "" : "s"} updated` : ""}.`); } return true; }
  const ed = t.closest("[data-pledit]"); if(ed){ openPriceListEditor(ed.dataset.pledit); return true; }
  const b = t.closest("[data-biz]"); if(!b) return false;
  const a = b.dataset.biz;
  if(a === "plpick"){ openPricePicker(); return true; }
  if(a === "plmanage"){ openPriceLists(); return true; }
  if(a === "plsave"){ const f = document.getElementById("plForm"); if(f) submitListForm(f); return true; }
  if(a === "pldel"){
    if(!b.dataset.confirm){ b.dataset.confirm = "1"; b.textContent = "Tap again to remove"; return true; }
    const r = removePriceList(V().id); if(r.error){ bizError(r.error); return true; }
    toast("Price list removed."); openPriceLists(); renderAll(); return true;
  }
  return false;
}
function submitListForm(f){
  const fd = new FormData(f), r = savePriceList({ id: V().id, name: fd.get("name"), isDefault: !!fd.get("isDefault"), active: !!fd.get("active"), from: fd.get("from") || "", to: fd.get("to") || "" });
  if(r.error){ bizError(r.error); return; }
  toast(`${r.list.name} saved.`); openPriceLists(); renderAll();
}
export function priceListsSubmit(e){
  if(e.target.id === "plNew"){
    e.preventDefault();
    const r = savePriceList({ name: new FormData(e.target).get("name"), isDefault: !allLists().length, active: true });
    if(r.error){ bizError(r.error); return true; }
    openPriceListEditor(r.list.id); renderAll(); return true;
  }
  if(e.target.id === "plForm"){ e.preventDefault(); submitListForm(e.target); return true; }
  return false;
}
export function priceListsInput(t){
  if(t.matches("[data-plq]") && V().kind === "pledit"){ store.bizView.q = t.value; const l = listById(V().id), box = document.querySelector("[data-plitems]"); if(l && box) box.innerHTML = itemRows(l, t.value); return true; }
  return false;
}
export function priceListsChange(t){
  if(t.matches("[data-plprice]") && V().kind === "pledit"){
    const r = setItemPrice(V().id, t.dataset.plprice, t.value);
    if(r.error){ bizError(r.error); return true; }
    bizError(""); return true;
  }
  return false;
}
