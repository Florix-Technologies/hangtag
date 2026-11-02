// The product editor's "More details": the shop's own fields (domain/catalog/attributes.js) that apply to the product's
// category, and any other field it already has a value for, each as the kind of field asks (text, number with its unit,
// date, yes/no, one choice, several choices). Folded unless the product has values or a field is required, so a plain
// product stays a few boxes. A field from another category can be added to one product. The values are checked on save
// (use-cases/save-product.js); values for fields this device doesn't know are kept as they are.
import { store } from '../../../shared/state/store.js';
import { attrInput, attrText, fieldsFor } from '../../../domain/catalog/attributes.js';
import { esc } from '../../../shared/dom.js';
import { can } from '../../shop/services/access.js';
import { activeAttrs, shopAttrs } from '../services/shop-fields.js';

/* The editor's typed values from a product's saved ones: lists stay lists (ticks), the rest as a form field shows them */
export const attrsForEditor = p => Object.fromEntries(Object.entries((p && p.attrs) || {}).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : attrInput(null, v)]));
/* The fields the editor shows: those that apply to the category typed, those with a value, and those added by hand */
export function shownFields(e){
  const keys = Object.fromEntries([...Object.keys(e.attrs || {}), ...(e.extra || [])].map(k => [k, ""]));
  return fieldsFor(shopAttrs(), { attrs: keys }, e.cat);
}
const filled = v => Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== "";
function inputHTML(a, e){
  const v = (e.attrs || {})[a.id], id = "edAttr_" + a.id, lab = `<span class="lab">${esc(a.name)}${a.required ? `<span class="req">*</span>` : ""}${a.unit ? ` <small>(${esc(a.unit)})</small>` : ""}</span>`;
  if(a.archived) return `<div class="f"><span class="lab">${esc(a.name)} <small>(archived field)</small></span><span class="attrro">${esc(attrText(a, Array.isArray(v) ? v : v === "yes" ? true : v === "no" ? false : v) || "—")}</span></div>`;
  const val = Array.isArray(v) ? "" : esc(v == null ? "" : v);
  switch(a.type){
    case "number": case "decimal":
      return `<label class="f" for="${id}">${lab}<input id="${id}" data-edattr="${esc(a.id)}" value="${val}" inputmode="${a.type === "decimal" || (a.min != null && a.min < 0) ? "decimal" : "numeric"}" autocomplete="off"
        placeholder="${a.min != null && a.max != null ? `${a.min}–${a.max}` : a.type === "decimal" ? "e.g. 12.5" : "e.g. 12"}"></label>`;
    case "date":
      return `<label class="f" for="${id}">${lab}<input id="${id}" type="date" data-edattr="${esc(a.id)}" value="${val}"></label>`;
    case "yesno":
      return `<label class="f" for="${id}">${lab}<select id="${id}" data-edattr="${esc(a.id)}"><option value="">—</option><option value="yes"${v === "yes" ? " selected" : ""}>Yes</option><option value="no"${v === "no" ? " selected" : ""}>No</option></select></label>`;
    case "choice": {
      const known = a.options.some(o => String(o).toLowerCase() === String(v || "").toLowerCase());
      return `<label class="f" for="${id}">${lab}<select id="${id}" data-edattr="${esc(a.id)}"><option value="">—</option>${a.options.map(o => `<option value="${esc(o)}"${String(o).toLowerCase() === String(v || "").toLowerCase() ? " selected" : ""}>${esc(o)}</option>`).join("")}${v && !known ? `<option value="${val}" selected>${val} (no longer a choice)</option>` : ""}</select></label>`;
    }
    case "multi": {
      const on = new Set((Array.isArray(v) ? v : String(v || "").split(/[,;|]/)).map(x => String(x).trim().toLowerCase()).filter(Boolean));
      return `<fieldset class="f full attrmulti"><legend class="lab">${esc(a.name)}${a.required ? `<span class="req">*</span>` : ""}</legend><div class="chkrow">${a.options.map(o => `<label class="chk"><input type="checkbox" data-edattrm="${esc(a.id)}" value="${esc(o)}"${on.has(o.toLowerCase()) ? " checked" : ""}> ${esc(o)}</label>`).join("")}</div></fieldset>`;
    }
    default:
      return `<label class="f${a.maxLen > 60 ? " full" : ""}" for="${id}">${lab}<input id="${id}" data-edattr="${esc(a.id)}" value="${val}" maxlength="${a.maxLen || 120}" autocomplete="off" placeholder="Optional"></label>`;
  }
}
/* The section (or "" when the shop has no fields and the product no values) */
export function fieldsSectionHTML(e){
  const shown = shownFields(e), others = activeAttrs().filter(a => !shown.some(s => s.id === a.id));
  if(!shown.length && !others.length) return "";
  const n = shown.filter(a => filled((e.attrs || {})[a.id])).length;
  const open = e.fieldsOpen != null ? e.fieldsOpen : n > 0 || shown.some(a => a.required);
  return `<details class="edsec edfields" id="ed-fields"${open ? " open" : ""}><summary><h4>More details</h4><span class="note">${shown.length ? `${n} of ${shown.length} filled · ` : ""}your own fields, such as ${esc((shown[0] || others[0]).name)}</span></summary>
    ${shown.length ? `<div class="pgrid">${shown.map(a => inputHTML(a, e)).join("")}</div>` : `<p class="note">No field is set for ${e.cat ? esc(e.cat) : "products without a category"}.</p>`}
    ${others.length ? `<label class="f"><span class="lab">Add a field to this product</span><select data-edaddfield><option value="">Choose a field…</option>${others.map(a => `<option value="${esc(a.id)}">${esc(a.name)}${a.cats.length ? ` (${esc(a.cats.join(", "))})` : ""}</option>`).join("")}</select></label>` : ""}
    ${can("manage_products") ? `<p class="note">Make or change fields in Settings → Products &amp; Inventory → Product fields.</p>` : ""}
  </details>`;
}
/* The category changed: only this section is drawn again (the rest of the editor stays as it is, so a tap that moved the
   focus away from the category box still lands where it was aimed) */
export function refreshFieldsSection(){
  const e = store.editor, sheet = document.querySelector("#modalHost [data-editor] .sheet.editor"); if(!e || !sheet) return;
  const cur = sheet.querySelector("#ed-fields"); if(cur) e.fieldsOpen = cur.open;
  const html = fieldsSectionHTML(e), box = document.createElement("div"); box.innerHTML = html;
  const next = box.firstElementChild, price = sheet.querySelector("#ed-price"), nav = sheet.querySelector(".ednav");
  if(cur && next) cur.replaceWith(next);
  else if(cur) cur.remove();
  else if(next && price) price.after(next);
  // the section's place in the editor's top bar comes and goes with it
  const go = nav && nav.querySelector('[data-edgo="fields"]');
  if(next && nav && !go){ const b = document.createElement("button"); b.type = "button"; b.dataset.edgo = "fields"; b.textContent = "Details"; const at = nav.querySelector('[data-edgo="inventory"]'); nav.insertBefore(b, at); }
  else if(!next && go) go.remove();
}
/* Typing in a field (input event) → true when it was one */
export function edAttrInput(t){
  const e = store.editor; if(!e || !t.dataset || t.dataset.edattr == null) return false;
  e.attrs = { ...(e.attrs || {}), [t.dataset.edattr]: t.value };
  return true;
}
/* A tick, a choice, or a field added (change event) → "render" when the editor should be drawn again, true when handled */
export function edAttrChange(t){
  const e = store.editor; if(!e || !t.dataset) return false;
  if(t.dataset.edattrm != null){
    const id = t.dataset.edattrm, cur = Array.isArray((e.attrs || {})[id]) ? e.attrs[id] : String((e.attrs || {})[id] || "").split(/[,;|]/).map(x => x.trim()).filter(Boolean);
    const next = t.checked ? [...cur.filter(x => x.toLowerCase() !== t.value.toLowerCase()), t.value] : cur.filter(x => x.toLowerCase() !== t.value.toLowerCase());
    e.attrs = { ...(e.attrs || {}), [id]: next };
    return true;
  }
  if(t.dataset.edattr != null){ e.attrs = { ...(e.attrs || {}), [t.dataset.edattr]: t.value }; return true; }
  if(t.matches && t.matches("[data-edaddfield]") && t.value){ e.extra = [...new Set([...(e.extra || []), t.value])]; e.fieldsOpen = true; return "render"; }
  return false;
}
