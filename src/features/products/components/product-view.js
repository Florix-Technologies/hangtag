// A product's detail view (Products → a product): what it is, its prices and tax, stock by variant, how it is tracked,
// and its actions — Edit first, then the rest in "More" (sell, stock in, stickers, archive, delete). The same List →
// View → Edit → Actions pattern as customers, suppliers and purchase orders.
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { UI_ICON, actionsMenuHTML, kvHTML, sheetHTML, statusChip } from '../../../shared/ui/kit.js';
import { priceRange, vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { unitOf } from '../../../domain/catalog/units.js';
import { prod } from '../services/catalog.js';
import { thumb } from './thumb.js';
import { stockOf } from '../../inventory/services/stock.js';
import { levelOf } from '../../inventory/services/stock-levels.js';
import { serialsOf, trackingOfP } from '../../inventory/services/tracking.js';
import { productHasSales } from '../use-cases/product-lifecycle.js';
import { can } from '../../shop/services/access.js';

const TRACK = { none: "Not tracked by serial or batch", serial: "Serial / IMEI number of each piece", batch: "Batch or lot number" };
export function productViewHTML(pid){
  const p = prod(pid); if(!p) return "";
  const vs = variantsOf(p), tr = trackingOfP(p), u = unitOf(p.unit), many = vs.length > 1;
  const total = vs.reduce((a, v) => a + Math.max(0, stockOf(v.id)), 0);
  const lowN = vs.filter(v => levelOf(stockOf(v.id), p) !== "ok").length;
  const stockChip = total <= 0 ? statusChip("Sold out", "bad") : lowN ? statusChip(lowN + " running low", "warn") : statusChip("In stock", "ok");
  const rows = vs.map(v => { const n = stockOf(v.id), lv = levelOf(n, p), sn = tr === "serial" ? serialsOf(v.id, { available: true }).length : null;
    return `<tr><th>${esc(vLabel(v) || "One size")}</th><td class="${lv === "ok" ? "" : lv}">${esc(String(n))}${u.id === "pcs" ? "" : " " + esc(u.sym)}${sn != null ? ` <small>· ${sn} serial${sn === 1 ? "" : "s"}</small>` : ""}</td><td>${inr(vPrice(p, v))}</td><td>${esc(v.sku || "—")}</td></tr>`; }).join("");
  const sold = productHasSales(p.id);
  const items = [
    can("create_sale") && !p.archived ? { label: "Sell", icon: "receipt", attrs: `data-sellp="${esc(p.id)}"` } : null,
    can("manage_inventory") && !p.archived && !p.bundle ? { label: tr === "serial" ? "Add stock & serial numbers" : tr === "batch" ? "Add stock & batch" : "Stock in", icon: "moneyIn", attrs: `data-stockin="${esc(p.id)}"` } : null,
    !p.archived ? { label: "Print stickers", icon: "print", attrs: `data-stickers="${esc(p.id)}"` } : null,
    can("manage_products") ? { sep: true } : null,
    can("manage_products") ? (p.archived ? { label: "Unarchive", icon: "archive", attrs: `data-unarchive="${esc(p.id)}"` } : { label: "Archive", icon: "archive", hint: "Stops selling it; its bills stay", attrs: `data-archive="${esc(p.id)}"` }) : null,
    can("manage_products") && !sold ? { label: "Delete", icon: "trash", danger: true, hint: "Never sold, so it can be removed", attrs: `data-delp="${esc(p.id)}"` } : null,
  ];
  const facts = kvHTML([
    ["Price", esc(priceRange(p)) + (u.id === "pcs" ? "" : " per " + esc(u.sym))], ["Cost", p.cost != null && p.cost !== "" ? inr(p.cost) : "—"],
    ["GST", p.gst != null && p.gst !== "" ? esc(p.gst) + "%" : "Shop's rate"], ["HSN", esc(p.hsn || "—")],
    ["Category", esc([p.cat, p.brand].filter(Boolean).join(" · ") || "—")], ["Tracking", esc(TRACK[tr] || TRACK.none)],
    ...(p.bundle ? [["Kit of", esc(String((p.bundle || []).length) + " item" + ((p.bundle || []).length === 1 ? "" : "s"))]] : []),
  ]);
  return sheetHTML({ id: "prodView", cls: "prodview", title: p.name, label: "Close product",
    sub: `${p.archived ? statusChip("Archived", "muted") + " " : ""}${stockChip} <span class="note">${esc(String(Math.round(total * 1000) / 1000))} ${u.id === "pcs" ? "piece" + (total === 1 ? "" : "s") : esc(u.sym)} in stock${many ? ` · ${vs.length} variants` : ""}</span>`,
    body: `<div class="pv-top">${thumb(p, "lg", store.imgs[p.id] || null)}<div class="pv-facts">${facts}</div></div>
      ${p.desc ? `<p class="pv-desc">${esc(p.desc)}</p>` : ""}
      <div class="dsec"><h4>Stock${many ? " by variant" : ""}</h4><div class="tw"><table class="tbl pv-tbl"><thead><tr><th>${many ? "Variant" : ""}</th><th>Stock</th><th>Price</th><th>SKU</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${tr === "serial" ? `<p class="note" style="margin:8px 0 0"><button type="button" class="link xs" data-tab="stock" data-subview="stock:tracking" data-modal-close>See every serial number in Stock → Serials &amp; batches</button></p>` : ""}</div>`,
    foot: `${actionsMenuHTML("pv-" + p.id, items, { up: true })}${can("manage_products") ? `<button type="button" class="btn primary" data-editp="${esc(p.id)}">${UI_ICON.edit} Edit product</button>` : ""}` });
}
export function openProductView(pid){ const h = productViewHTML(pid); if(h) $("#modalHost").innerHTML = h; }
