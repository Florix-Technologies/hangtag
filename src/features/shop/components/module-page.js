// A module's page with parts (sub-views, services/modules.js registerSubview): the bar to switch between the parts shown
// to this person in this shop, and the part on screen. A part marked `main` is the module's own content (e.g. Stock →
// Stock); any other part draws into the page's second area. With one part shown there is no bar.
//   <div class="subnav" data-subnav="stock"></div>  <div data-submain="stock">…</div>  <div data-subalt="stock"></div>
// A workspace with tasks of its own (AREA_BARS below; its tasks: services/nav-model.js — Sell is New sale · Held bills · Quotations · Sales
// orders · Store · Tables · Kitchen; Stock is Stock · Products · Purchases · Suppliers · Stock count · Purchase orders · Serials &
// batches · Smart reorder) shows those tasks in the bar instead, whichever module of the workspace is on screen.
import { chooseSubview, currentSubview, subviewsOf } from '../services/modules.js';
import { areaBar, navWhere } from '../services/nav-model.js';
import { $, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';

const AREA_BARS = ["sell", "stock"];
/* A bar wider than the screen (a phone) scrolls: the task on screen is brought into view, so you always see where you are */
function showCurrent(bar){
  const on = bar.querySelector('[aria-pressed="true"]'); if(!on || bar.scrollWidth <= bar.clientWidth) return;
  const b = bar.getBoundingClientRect(), r = on.getBoundingClientRect();
  if(r.left < b.left || r.right > b.right) bar.scrollLeft += (r.left - b.left) - (b.width - r.width) / 2;
}
function areaBarHTML(parent){
  const where = navWhere(parent);
  if(!AREA_BARS.includes(where.area)) return null;
  const list = areaBar(where.area, where);
  return list.length ? list.map(it => `<button type="button" class="chipbtn" ${it.sub ? `data-navsub="${esc(it.id)}"` : `data-tab="${esc(it.tab)}"`} aria-pressed="${it.on}">${esc(it.label)}</button>`).join("") : "";
}
export function subnavHTML(parent){
  const area = areaBarHTML(parent);
  if(area !== null) return area;
  const list = subviewsOf(parent), cur = currentSubview(parent);
  if(list.length < 2) return "";
  return list.map(d => `<button type="button" class="chipbtn" data-subview="${esc(parent + ":" + d.id)}" aria-pressed="${d === cur}">${esc(d.label)}</button>`).join("");
}
export function renderSubviews(parent){
  const cur = currentSubview(parent), bar = $(`[data-subnav="${parent}"]`), main = $(`[data-submain="${parent}"]`), alt = $(`[data-subalt="${parent}"]`);
  if(bar){ const h = subnavHTML(parent); bar.hidden = !h; if(bar.innerHTML !== h){ bar.innerHTML = h; showCurrent(bar); } }
  const inMain = !!(cur && cur.main && main);
  if(main) main.hidden = !inMain;
  if(alt){ alt.hidden = inMain; if(inMain && alt.innerHTML) alt.innerHTML = ""; }
  if(!cur){ if(alt) alt.innerHTML = `<p class="muted">Nothing to show here.</p>`; return; }
  if(typeof cur.render === "function") cur.render(inMain ? main : alt);
}
/* The area bar on the page of a module without parts of its own (Products, in Stock) */
export function renderAreaNav(id){
  const bar = $(`[data-subnav="${id}"]`); if(!bar) return;
  const h = areaBarHTML(id) || "";
  bar.hidden = !h; if(bar.innerHTML !== h){ bar.innerHTML = h; showCurrent(bar); }
}
/* A click on a part's button (wired once by app/modules.js): true when it was one */
export function onSubviewClick(e){
  const b = e.target && e.target.closest ? e.target.closest("[data-subview]") : null;
  if(!b) return false;
  const i = b.dataset.subview.indexOf(":");
  chooseSubview(b.dataset.subview.slice(0, i), b.dataset.subview.slice(i + 1));
  renderAll();
  return true;
}
