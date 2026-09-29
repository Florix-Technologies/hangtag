// A module's page with parts (sub-views, services/modules.js registerSubview): the bar to switch between the parts shown
// to this person in this shop, and the part on screen. A part marked `main` is the module's own content (e.g. Inventory →
// Stock); any other part draws into the page's second area. With one part shown there is no bar.
//   <div class="subnav" data-subnav="stock"></div>  <div data-submain="stock">…</div>  <div data-subalt="stock"></div>
import { chooseSubview, currentSubview, subviewsOf } from '../services/modules.js';
import { $, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';

export function subnavHTML(parent){
  const list = subviewsOf(parent), cur = currentSubview(parent);
  if(list.length < 2) return "";
  return list.map(d => `<button type="button" class="chipbtn" data-subview="${esc(parent + ":" + d.id)}" aria-pressed="${d === cur}">${esc(d.label)}</button>`).join("");
}
export function renderSubviews(parent){
  const cur = currentSubview(parent), bar = $(`[data-subnav="${parent}"]`), main = $(`[data-submain="${parent}"]`), alt = $(`[data-subalt="${parent}"]`);
  if(bar){ const h = subnavHTML(parent); bar.hidden = !h; if(bar.innerHTML !== h) bar.innerHTML = h; }
  const inMain = !!(cur && cur.main && main);
  if(main) main.hidden = !inMain;
  if(alt){ alt.hidden = inMain; if(inMain && alt.innerHTML) alt.innerHTML = ""; }
  if(!cur){ if(alt) alt.innerHTML = `<p class="muted">Nothing to show here.</p>`; return; }
  if(typeof cur.render === "function") cur.render(inMain ? main : alt);
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
