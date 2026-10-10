// Settings → Products & Inventory → Product fields and Units: the shop's own fields (Wattage, Material, Pressing year…)
// and units (Roll, Pair, Sq ft…). A list of each, and a sheet to make or change one (use-cases/shop-fields.js checks it,
// the database too). A field's choices keep their place when renamed, so the products using them change with them; a
// field or unit in use is archived rather than removed. app/modules.js adds the part and its handlers.
import { store } from '../../../shared/state/store.js';
import { ATTR_LIMITS, ATTR_TYPES, attrTypeLabel, attrUsage } from '../../../domain/catalog/attributes.js';
import { GST_UQC } from '../../../domain/catalog/units.js';
import { esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { bizError, bizSheet } from '../../commerce/components/biz-sheet.js';
import { categories, products } from '../services/catalog.js';
import { attrById, shopAttrs, shopUnitList } from '../services/shop-fields.js';
import { removeAttr, removeUnit, saveAttr, saveUnit, setAttrArchived, setUnitArchived } from '../use-cases/shop-fields.js';

const V = () => store.bizView || {};
const usedBy = a => attrUsage(products(), a).products;
const unitUsers = id => products().filter(p => p.unit === id).length;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* ---------- the part in Settings ---------- */
export function shopFieldsSettingsHTML(){
  const fields = shopAttrs().filter(a => !a.archived), units = shopUnitList().filter(u => !u.archived);
  return `<div class="setpart" id="shopFieldsSetup"><h5 class="subh">Product fields</h5>
      <p class="note" style="margin:0">${fields.length ? `${esc(fields.slice(0, 4).map(a => a.name).join(", "))}${fields.length > 4 ? ` and ${fields.length - 4} more` : ""}` : "Your own fields for products, such as Wattage, Material or Warranty: any kind of product, described your way."}</p>
      <div class="setactions"><button type="button" class="btn sm" data-biz="atlist">${fields.length ? "Open product fields" : "Add a product field"}</button></div></div>
    <div class="setpart" id="shopUnitsSetup"><h5 class="subh">Units</h5>
      <p class="note" style="margin:0">${units.length ? esc(units.map(u => u.label).join(", ")) : "Units besides Piece, Kg, Litre and Meter, such as Roll, Pair or Sq ft."}</p>
      <div class="setactions"><button type="button" class="btn sm" data-biz="unlist">${units.length ? "Open units" : "Add a unit"}</button></div></div>`;
}

/* ---------- product fields ---------- */
export function openAttrList(){
  store.bizView = { kind: "atlist", err: "", archived: V().kind === "atlist" ? V().archived : false };
  const all = shopAttrs(), live = all.filter(a => !a.archived), old = all.filter(a => a.archived);
  const row = a => { const n = usedBy(a); return `<button type="button" class="bizrow" data-atedit="${esc(a.id)}"><span><b>${esc(a.name)}</b><small>${esc(attrTypeLabel(a.type))}${a.options.length ? ` · ${plural(a.options.length, "choice")}` : ""}${a.unit ? ` · ${esc(a.unit)}` : ""}${a.required ? " · required" : ""}
    · ${a.cats.length ? esc(a.cats.join(", ")) : "every product"}${n ? ` · used by ${plural(n, "product")}` : ""}</small></span></button>`; };
  bizSheet({ label: "Product fields", sub: `Your own fields, shown on the products they are for. Up to ${ATTR_LIMITS.maxFields} in use. Price, cost, stock, SKU, barcode, GST and tracking are built in.`,
    body: (live.length ? `<div class="bizlist">${live.map(row).join("")}</div>` : `<p class="muted">No fields yet. Add one, for example Wattage (one choice from a list) or Warranty months (a whole number).</p>`)
      + (old.length ? `<details${V().archived ? " open" : ""}><summary>Archived (${old.length})</summary><div class="bizlist">${old.map(row).join("")}</div></details>` : ""),
    foot: `<button type="button" class="btn sm primary" data-biz="atnew">Add a field</button>` });
}
export function openAttrEditor(id){
  const a = id ? attrById(id) : null;
  if(id && !a){ openAttrList(); return; }
  const f = a ? { name: a.name, type: a.type, required: a.required, min: a.min ?? "", max: a.max ?? "", dp: a.dp ?? "", unit: a.unit, maxLen: a.maxLen ?? "", cats: a.cats.join(", ") }
    : { name: "", type: "choice", required: false, min: "", max: "", dp: "", unit: "", maxLen: "", cats: "" };
  store.bizView = { kind: "atedit", id: a ? a.id : null, form: f, opts: a ? a.options.map(o => ({ was: o, now: o })) : [], err: "" };
  renderAttrEditor();
}
/* What the form says now, into the sheet's state (so drawing it again keeps it) */
function readAttrForm(){
  const el = document.getElementById("atForm"); if(!el || V().kind !== "atedit") return;
  const fd = new FormData(el), f = store.bizView.form;
  ["name", "type", "min", "max", "dp", "unit", "maxLen", "cats"].forEach(k => { if(fd.has(k)) f[k] = fd.get(k); });
  f.required = !!fd.get("required");
  el.querySelectorAll("[data-atopt]").forEach(i => { const o = store.bizView.opts[+i.dataset.atopt]; if(o) o.now = i.value; });
}
export function renderAttrEditor(){
  const v = V(), a = v.id ? attrById(v.id) : null, f = v.form, used = a ? usedBy(a) : 0, usage = a ? attrUsage(products(), a) : { byOption: {} };
  const list = f.type === "choice" || f.type === "multi", num = f.type === "number" || f.type === "decimal";
  const cats = categories().filter(c => !String(f.cats || "").toLowerCase().split(",").map(x => x.trim()).includes(c.toLowerCase()));
  const optRows = v.opts.map((o, k) => o.was != null && !o.now && !String(o.now).trim() && o.removed ? "" : `<div class="atoptrow"><input data-atopt="${k}" value="${esc(o.now)}" maxlength="${ATTR_LIMITS.optionLen}" aria-label="Choice ${k + 1}" autocomplete="off">
      ${o.was != null && usage.byOption[o.was.toLowerCase()] ? `<small class="muted">used by ${plural(usage.byOption[o.was.toLowerCase()], "product")}</small>` : ""}<button type="button" class="link xs danger" data-biz="atoptdel" data-k="${k}" aria-label="Remove ${esc(o.now)}">Remove</button></div>`).join("");
  bizSheet({ label: a ? a.name : "New product field", sub: a ? `${attrTypeLabel(a.type)}${used ? ` · used by ${plural(used, "product")}` : ""}${a.archived ? " · archived" : ""}` : "A field of your own: its values are kept with each product, and can be imported and exported.",
    body: `<form id="atForm" class="pgrid" autocomplete="off" novalidate>
      <label class="f full">Name<input name="name" value="${esc(f.name)}" maxlength="${ATTR_LIMITS.nameLen}" placeholder="e.g. Wattage, Material, Warranty months" required></label>
      <label class="f full">What kind of value<select name="type" data-atf="type"${used ? " disabled" : ""}>${ATTR_TYPES.map(t => `<option value="${t.key}"${t.key === f.type ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
        <span class="fhint">${used ? `It stays ${esc(attrTypeLabel(f.type).toLowerCase())}: ${plural(used, "product")} use it.` : esc((ATTR_TYPES.find(t => t.key === f.type) || {}).hint || "")}</span></label>
      ${used ? `<input type="hidden" name="type" value="${esc(f.type)}">` : ""}
      ${list ? `<div class="f full"><span class="lab">Choices</span><div class="atopts">${optRows || `<p class="note" style="margin:0">Add the choices people pick from.</p>`}</div>
        <div class="optadd"><input data-atoptadd placeholder="Add choices: Warm white, Cool white" maxlength="400" aria-label="Choices to add" autocomplete="off"><button type="button" class="btn xs" data-biz="atoptadd">+ Add</button></div></div>` : ""}
      ${num ? `<label class="f">Lowest<input name="min" value="${esc(f.min)}" inputmode="decimal" placeholder="Optional"></label>
        <label class="f">Highest<input name="max" value="${esc(f.max)}" inputmode="decimal" placeholder="Optional"></label>
        ${f.type === "decimal" ? `<label class="f">Decimal places<input name="dp" value="${esc(f.dp || 2)}" inputmode="numeric" maxlength="1"></label>` : ""}
        <label class="f">Unit shown after it<input name="unit" value="${esc(f.unit)}" maxlength="${ATTR_LIMITS.unitLen}" placeholder="e.g. W, mAh, cm"></label>` : ""}
      ${f.type === "text" ? `<label class="f">Longest text (characters)<input name="maxLen" value="${esc(f.maxLen || ATTR_LIMITS.defaultTextLen)}" inputmode="numeric" maxlength="3"></label>` : ""}
      <label class="f full">Only for these categories<input name="cats" value="${esc(f.cats)}" placeholder="Empty: every product">
        <span class="fhint">Separate categories with commas.${cats.length ? " Tap to add:" : ""}</span>
        ${cats.length ? `<span class="chips">${cats.slice(0, 12).map(c => `<button type="button" class="btn xs ghost" data-biz="atcat" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</span>` : ""}</label>
      <label class="chk full"><input type="checkbox" name="required"${f.required ? " checked" : ""}> Required for the products it is for</label>
      <button type="submit" hidden></button></form>`,
    foot: `${a ? `${!used ? `<button type="button" class="btn sm danger" data-biz="atremove">Remove</button>` : ""}<button type="button" class="btn sm" data-biz="atarchive">${a.archived ? "Restore" : "Archive"}</button>` : ""}
      <button type="button" class="btn sm" data-biz="atlist">Back</button><button type="button" class="btn sm primary" data-biz="atsave">Save field</button>` });
}
function saveAttrForm(){
  readAttrForm();
  const v = V(), f = v.form;
  const r = saveAttr({ id: v.id || undefined, name: f.name, type: f.type, required: f.required, min: f.min, max: f.max, dp: f.dp, unit: f.unit, maxLen: f.maxLen, cats: f.cats,
    options: v.opts.map(o => ({ was: o.was, now: o.now })) });
  if(r.error){ bizError(r.error); return; }
  toast(`${r.attr.name} saved${r.renamed ? ` · ${plural(r.renamed, "product")} changed with it` : ""}.`);
  openAttrList(); renderAll();
}

/* ---------- units ---------- */
export function openUnitList(){
  store.bizView = { kind: "unlist", err: "" };
  const all = shopUnitList().slice().sort((a, b) => (a.archived - b.archived) || a.label.localeCompare(b.label));
  bizSheet({ label: "Units", sub: "Units of your own, besides Piece, Box, Pack, Dozen, Kg, Gram, Litre, ml and Meter.",
    body: all.length ? `<div class="bizlist">${all.map(u => { const n = unitUsers(u.id); return `<button type="button" class="bizrow" data-unedit="${esc(u.id)}"><span><b>${esc(u.label)}</b><small>${esc(u.id)} · ${u.dp ? `up to ${u.dp} decimals` : "whole numbers"} · GST ${esc(u.uqc)}${n ? ` · ${plural(n, "product")}` : ""}${u.archived ? " · archived" : ""}</small></span></button>`; }).join("")}</div>`
      : `<p class="muted">No units of your own yet. For example Roll, Pair, Set, Bundle or Sq ft (with 2 decimals).</p>`,
    foot: `<button type="button" class="btn sm primary" data-biz="unnew">Add a unit</button>` });
}
export function openUnitEditor(id){
  const u = id ? shopUnitList().find(x => x.id === id) : null;
  if(id && !u){ openUnitList(); return; }
  store.bizView = { kind: "unedit", id: u ? u.id : null, err: "" };
  const used = u ? unitUsers(u.id) : 0, dp = u ? u.dp : 0;
  bizSheet({ label: u ? u.label : "New unit", sub: u ? `Code ${u.id}${used ? ` · ${plural(used, "product")} sold in it` : ""}${u.archived ? " · archived" : ""}` : "What a quantity is counted or measured in, e.g. 3 rolls or 12.5 sq ft.",
    body: `<form id="unForm" class="pgrid" autocomplete="off" novalidate>
      <label class="f">Name<input name="label" value="${esc(u ? u.label : "")}" maxlength="20" placeholder="e.g. Roll, Sq ft" required></label>
      <label class="f">Short code<input name="id" value="${esc(u ? u.id : "")}" maxlength="12" placeholder="Made from the name"${u ? " readonly" : ""}><span class="fhint">Shown after a quantity (3 roll). Letters and digits.</span></label>
      <label class="f">Decimals<select name="dp"${used ? " disabled" : ""}>${[0, 1, 2, 3].map(n => `<option value="${n}"${n === dp ? " selected" : ""}>${n ? `Up to ${n} (e.g. ${(12.5).toFixed(n)})` : "None: whole numbers"}</option>`).join("")}</select>${used ? `<input type="hidden" name="dp" value="${dp}">` : ""}</label>
      <label class="f">Counted or measured<select name="kind"><option value="count"${!u || u.kind === "count" ? " selected" : ""}>Counted (rolls, pairs)</option><option value="measure"${u && u.kind === "measure" ? " selected" : ""}>Measured (feet, sq ft)</option></select></label>
      <label class="f full">GST unit code<select name="uqc">${GST_UQC.map(([c, l]) => `<option value="${c}"${(u ? u.uqc : "OTH") === c ? " selected" : ""}>${c} · ${esc(l)}</option>`).join("")}</select><span class="fhint">For e-invoices and GST returns. Others (OTH) if none fits.</span></label>
      <button type="submit" hidden></button></form>`,
    foot: `${u ? `${!used ? `<button type="button" class="btn sm danger" data-biz="unremove">Remove</button>` : ""}<button type="button" class="btn sm" data-biz="unarchive">${u.archived ? "Restore" : "Archive"}</button>` : ""}
      <button type="button" class="btn sm" data-biz="unlist">Back</button><button type="button" class="btn sm primary" data-biz="unsave">Save unit</button>` });
}
function saveUnitForm(){
  const el = document.getElementById("unForm"); if(!el) return;
  const fd = new FormData(el), v = V();
  const r = saveUnit({ id: v.id || fd.get("id") || "", label: fd.get("label"), dp: fd.get("dp"), kind: fd.get("kind"), uqc: fd.get("uqc") });
  if(r.error){ bizError(r.error); return; }
  toast(`${r.unit.label} saved.`); openUnitList(); renderAll();
}

/* ---------- events (app/events/commerce-events.js, added by app/modules.js) ---------- */
const twice = (b, label) => { if(b.dataset.confirm) return true; b.dataset.confirm = "1"; b.textContent = label; return false; };
export function shopFieldsClick(t){
  const ed = t.closest("[data-atedit]"); if(ed){ openAttrEditor(ed.dataset.atedit); return true; }
  const ue = t.closest("[data-unedit]"); if(ue){ openUnitEditor(ue.dataset.unedit); return true; }
  const b = t.closest("[data-biz]"); if(!b) return false;
  const act = b.dataset.biz, v = V();
  if(act === "atlist"){ openAttrList(); return true; }
  if(act === "atnew"){ openAttrEditor(null); return true; }
  if(act === "atsave"){ saveAttrForm(); return true; }
  if(act === "atoptadd" && v.kind === "atedit"){
    readAttrForm();
    const box = document.querySelector("[data-atoptadd]"), add = String(box && box.value || "").split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    add.forEach(x => { if(!v.opts.some(o => String(o.now).toLowerCase() === x.toLowerCase())) v.opts.push({ was: null, now: x }); });
    renderAttrEditor(); const i = document.querySelector("[data-atoptadd]"); if(i) i.focus(); return true;
  }
  if(act === "atoptdel" && v.kind === "atedit"){
    readAttrForm();
    const k = +b.dataset.k, o = v.opts[k];
    if(o){ if(o.was == null) v.opts.splice(k, 1); else { o.now = ""; o.removed = true; } }
    renderAttrEditor(); return true;
  }
  if(act === "atcat" && v.kind === "atedit"){
    readAttrForm();
    const cur = String(v.form.cats || "").split(",").map(x => x.trim()).filter(Boolean);
    v.form.cats = [...cur, b.dataset.cat].join(", "); renderAttrEditor(); return true;
  }
  if(act === "atarchive" && v.kind === "atedit"){
    const a = attrById(v.id); if(!a) return true;
    const r = setAttrArchived(a.id, !a.archived); if(r.error){ bizError(r.error); return true; }
    toast(`${a.name} ${a.archived ? "restored" : "archived: products keep their values"}.`); openAttrList(); renderAll(); return true;
  }
  if(act === "atremove" && v.kind === "atedit"){
    if(!twice(b, "Tap again to remove")) return true;
    const r = removeAttr(v.id); if(r.error){ bizError(r.error); return true; }
    toast("Field removed."); openAttrList(); renderAll(); return true;
  }
  if(act === "unlist"){ openUnitList(); return true; }
  if(act === "unnew"){ openUnitEditor(null); return true; }
  if(act === "unsave"){ saveUnitForm(); return true; }
  if(act === "unarchive" && v.kind === "unedit"){
    const u = shopUnitList().find(x => x.id === v.id); if(!u) return true;
    const r = setUnitArchived(u.id, !u.archived); if(r.error){ bizError(r.error); return true; }
    toast(`${u.label} ${u.archived ? "restored" : "archived: products sold in it keep it"}.`); openUnitList(); renderAll(); return true;
  }
  if(act === "unremove" && v.kind === "unedit"){
    if(!twice(b, "Tap again to remove")) return true;
    const r = removeUnit(v.id); if(r.error){ bizError(r.error); return true; }
    toast("Unit removed."); openUnitList(); renderAll(); return true;
  }
  return false;
}
export function shopFieldsChange(t){
  if(t.matches && t.matches("[data-atf='type']") && V().kind === "atedit"){ readAttrForm(); store.bizView.form.type = t.value; renderAttrEditor(); return true; }
  return false;
}
export function shopFieldsInput(t){
  if(t.dataset && t.dataset.atopt != null && V().kind === "atedit"){ const o = store.bizView.opts[+t.dataset.atopt]; if(o) o.now = t.value; return true; }
  return false;
}
export function shopFieldsSubmit(e){
  if(e.target.id === "atForm"){ e.preventDefault(); saveAttrForm(); return true; }
  if(e.target.id === "unForm"){ e.preventDefault(); saveUnitForm(); return true; }
  return false;
}
