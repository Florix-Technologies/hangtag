// Repack on the phone (grocery): "25 kg sack → loose kg · Quantity 1 sack → Result 25 kg · CONVERT". Opened from the
// stock page for shops that repack; the conversion is remembered, so next time only the quantity is asked.
import { qtyText } from '../../../domain/catalog/units.js';
import { vLabel, variantsOf } from '../../../domain/catalog/variants.js';
import { isKit } from '../../../domain/catalog/bundles.js';
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { can } from '../../shop/services/access.js';
import { bizError, bizSheet } from '../../commerce/components/biz-sheet.js';
import { liveProducts } from '../../products/services/catalog.js';
import { vRec } from '../services/ledger.js';
import { stockOf } from '../services/stock.js';
import { trackingOfP } from '../services/tracking.js';
import { previewRepack, repackStock, repacksOf, usesRepack } from '../use-cases/repack.js';

const V = () => store.bizView || {};
export const repackButtonHTML = () => usesRepack() && can("manage_inventory") ? `<button type="button" class="btn sm" data-rpknew>Repack</button>` : "";
/* every variant that can take part (no kits, no serial numbers), with stock for the source list */
const options = (withStock) => liveProducts().filter(p => !isKit(p) && trackingOfP(p) !== "serial").flatMap(p => variantsOf(p).map(v => ({ p, v }))).filter(x => !withStock || stockOf(x.v.id) > 0);
const label = x => x.p.name + (vLabel(x.v) ? " · " + vLabel(x.v) : "");
export function openRepack(fromV){
  const saved = fromV && vRec(fromV) ? repacksOf(vRec(fromV).p).find(r => r.f === fromV) : null;
  store.bizView = { kind: "rpk", fromV: fromV || "", toV: saved ? saved.t : "", per: saved ? String(saved.per) : "", q: "1", err: "" };
  renderRepack();
}
export function renderRepack(){
  const F = V(), f = vRec(F.fromV), t = vRec(F.toV), P = F.fromV && F.toV && F.per && F.q ? previewRepack({ fromV: F.fromV, toV: F.toV, q: +F.q, per: +F.per }) : null;
  const sel = (key, list, cur) => `<select data-rpkf="${key}"><option value="">Choose…</option>${list.map(x => `<option value="${esc(x.v.id)}"${cur === x.v.id ? " selected" : ""}>${esc(label(x))}${key === "fromV" ? ` (${esc(qtyText(stockOf(x.v.id), x.p.unit))})` : ""}</option>`).join("")}</select>`;
  bizSheet({ label: "Repack", sub: "Open a sack or carton into loose units. Stock and value stay right.",
    body: `<label class="f full">Open<span>${sel("fromV", options(true), F.fromV)}</span></label>
      <label class="f full">Into<span>${sel("toV", options(false).filter(x => x.v.id !== F.fromV), F.toV)}</span></label>
      <div class="pgrid"><label class="f">One ${esc(f ? f.p.name : "unit")} makes<input data-rpkf="per" type="number" inputmode="decimal" min="0" step="any" value="${esc(F.per)}" placeholder="e.g. 25"></label>
      <label class="f">How many to open<input data-rpkf="q" type="number" inputmode="decimal" min="0" step="any" value="${esc(F.q)}"></label></div>
      ${P && P.plan ? `<div class="rpkflow"><div><small>Out</small><b>${esc(qtyText(P.plan.out, f.p.unit))}</b><small>${esc(f.p.name)}</small></div><span>→</span><div><small>In</small><b>${esc(qtyText(P.plan.in, t.p.unit))}</b><small>${esc(t.p.name)}</small></div></div>${P.plan.unitCost != null ? `<p class="note">Cost carried over: ₹${esc(String(P.plan.unitCost))} per ${esc(t.p.unit || "unit")}.</p>` : ""}` : P && P.error ? `<p class="note bad">${esc(P.error)}</p>` : ""}`,
    foot: `<button type="button" class="btn sm" data-biz="close">Cancel</button><button type="button" class="btn sm primary" data-rpkgo>Convert</button>` });
}
export function repackClick(t){
  const n = t.closest("[data-rpknew]"); if(n){ openRepack(n.dataset.rpknew || ""); return true; }
  if(t.closest("[data-rpkgo]") && V().kind === "rpk"){
    const F = V(), r = repackStock({ fromV: F.fromV, toV: F.toV, q: +F.q, per: +F.per });
    if(r.error){ bizError(r.error); return true; }
    toast(`Repacked: ${qtyText(r.plan.out)} out, ${qtyText(r.plan.in)} in.`); store.bizView = null; document.getElementById("modalHost").innerHTML = ""; renderAll(); return true;
  }
  return false;
}
export function repackChange(t){
  const F = V(); if(F.kind !== "rpk" || !t.matches("[data-rpkf]")) return false;
  F[t.dataset.rpkf] = t.value;
  if(t.dataset.rpkf === "fromV"){ const r = vRec(t.value), saved = r ? repacksOf(r.p).find(x => x.f === t.value) : null; if(saved){ F.toV = saved.t; F.per = String(saved.per); } }
  renderRepack(); return true;
}
export function repackInput(t){
  const F = V(); if(F.kind !== "rpk" || !t.matches("[data-rpkf='per'],[data-rpkf='q']")) return false;
  F[t.dataset.rpkf] = t.value; return true;
}
