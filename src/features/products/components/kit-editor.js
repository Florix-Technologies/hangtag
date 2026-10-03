// Kits on the phone: Name → Price → scan or add the items → Save. How many kits can be sold now is shown as it is built
// (from the items' stock). Products → "New kit"; a kit opens here instead of the product editor.
import { isKit, kitsAvailable } from '../../../domain/catalog/bundles.js';
import { qtyText } from '../../../domain/catalog/units.js';
import { vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { bizError, bizSheet } from '../../commerce/components/biz-sheet.js';
import { sellableOf, trackingOfP } from '../../inventory/services/tracking.js';
import { vRec } from '../../inventory/services/ledger.js';
import { liveProducts, prod } from '../services/catalog.js';
import { saveKit } from '../use-cases/save-kit.js';

const V = () => store.bizView || {};
export function openKitEditor(pid){
  const p = pid ? prod(pid) : null, v = p ? variantsOf(p, true)[0] : null;
  store.bizView = { kind: "kit", id: p ? p.id : null, name: p ? p.name : "", price: p ? String(p.price) : "", bc: v && v.bc || "", sku: v && v.sku || "", gst: p && p.gst != null ? String(p.gst) : "",
    bundle: p && isKit(p) ? p.bundle.map(c => ({ ...c })) : [], q: "", err: "" };
  renderKitEditor();
}
function hits(q){
  const s = String(q || "").trim().toLowerCase(); if(!s) return "";
  const out = [];
  liveProducts().forEach(p => { if(isKit(p) || trackingOfP(p) === "serial") return; variantsOf(p).forEach(v => { if(out.length < 8 && (p.name.toLowerCase().includes(s) || String(v.bc || "") === s || String(v.sku || "").toLowerCase() === s)) out.push({ p, v }); }); });
  return out.map(({ p, v }) => `<button type="button" class="ohit" data-kitadd="${esc(v.id)}"><b>${esc(p.name)}</b><span>${esc(vLabel(v) || "")}</span><span class="tnum">${inr(vPrice(p, v))}</span></button>`).join("") || `<p class="muted">No product matches (serial-numbered products are sold on their own).</p>`;
}
export function renderKitEditor(){
  const F = V(), sep = F.bundle.reduce((a, c) => { const r = vRec(c.v); return a + (r ? vPrice(r.p, r.v) * c.q : 0); }, 0);
  const can = F.bundle.length ? kitsAvailable(F.bundle, sellableOf) : 0;
  bizSheet({ label: F.id ? "Edit kit" : "New kit", sub: "Sold as one item; its stock comes from the items inside.",
    body: `<div class="pgrid"><label class="f full">Name<input data-kitf="name" value="${esc(F.name)}" maxlength="120" placeholder="e.g. Phone starter kit"></label>
      <label class="f">Price<input data-kitf="price" type="number" inputmode="decimal" min="0" step="any" value="${esc(F.price)}"></label>
      <label class="f">Barcode (optional)<input data-kitf="bc" value="${esc(F.bc)}" maxlength="40" inputmode="numeric"></label></div>
      <input type="search" class="bizsearch" data-kitq value="${esc(F.q)}" placeholder="Scan or search an item to add" aria-label="Scan or search an item"><div class="ohits" data-kithits>${hits(F.q)}</div>
      <div class="bizlist">${F.bundle.map((c, i) => { const r = vRec(c.v); return `<div class="kitline"><span><b>${esc(r ? r.p.name : "Item no longer in the catalog")}</b><small>${esc(r ? vLabel(r.v) : "")}${r ? ` · ${qtyText(sellableOf(c.v), r.p.unit)} in stock` : ""}</small></span><input type="number" inputmode="decimal" min="0" step="any" value="${esc(String(c.q))}" data-kitqty="${i}" aria-label="How many in one kit"><button type="button" class="iconbtn sm" data-kitrm="${i}" aria-label="Remove">×</button></div>`; }).join("") || `<p class="muted">Add the items in the kit.</p>`}</div>
      ${F.bundle.length ? `<div class="bizkv"><div><span>Items separately</span><b>${inr(sep)}</b></div><div><span>Kits possible now</span><b>${can}</b></div></div>` : ""}
      <details><summary>SKU, GST</summary><div class="pgrid"><label class="f">SKU<input data-kitf="sku" value="${esc(F.sku)}" maxlength="64"></label><label class="f">GST %<input data-kitf="gst" type="number" min="0" max="100" step="any" value="${esc(F.gst)}"></label></div></details>`,
    foot: `<button type="button" class="btn sm" data-biz="close">Cancel</button><button type="button" class="btn sm primary" data-biz="kitsave">Save kit</button>` });
}
export function kitClick(t){
  if(t.closest("[data-kitnew]")){ openKitEditor(null); return true; }
  const F = V(); if(F.kind !== "kit") return false;
  const add = t.closest("[data-kitadd]");
  if(add){ const ex = F.bundle.find(c => c.v === add.dataset.kitadd); if(ex) ex.q = (+ex.q || 0) + 1; else F.bundle.push({ v: add.dataset.kitadd, q: 1 }); F.q = ""; renderKitEditor(); return true; }
  const rm = t.closest("[data-kitrm]"); if(rm){ F.bundle.splice(+rm.dataset.kitrm, 1); renderKitEditor(); return true; }
  if(t.closest("[data-biz='kitsave']")){
    const r = saveKit({ id: F.id, name: F.name, price: F.price, bc: F.bc, sku: F.sku, gst: F.gst, bundle: F.bundle.map(c => ({ v: c.v, q: +c.q })) });
    if(r.error){ bizError(r.error); return true; }
    store.bizView = null; toast(`${r.product.name} saved as a kit.`); renderAll(); document.getElementById("modalHost").innerHTML = ""; return true;
  }
  return false;
}
export function kitInput(t){
  const F = V(); if(F.kind !== "kit") return false;
  if(t.matches("[data-kitq]")){ F.q = t.value; const h = document.querySelector("[data-kithits]"); if(h) h.innerHTML = hits(t.value); return true; }
  if(t.matches("[data-kitf]")){ F[t.dataset.kitf] = t.value; return true; }
  if(t.matches("[data-kitqty]")){ const c = F.bundle[+t.dataset.kitqty]; if(c) c.q = t.value === "" ? 0 : +t.value; return true; }
  return false;
}
