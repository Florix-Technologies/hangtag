// App shell: the navigation, page switching and the full re-render (provided as the "renderer" port behind
// shared/ui/render.js). Where every destination sits is features/shop/services/nav-model.js (built on the module
// registry, features/shop/services/modules.js: capabilities, permissions, whether the module exists); each module's page
// is <section id="v-<id>"> and its render() draws it (app/modules.js).
//   · a desktop (1000 px and wider): every destination in a sidebar, grouped by area (Sales, Stock, Purchases, Reports …);
//   · a phone or tablet: a tab bar with three places for this person's role and kind of shop (domain/shop/
//     mobile-workflow.js: Home · Sell · Stock, a restaurant Home · Tables · Kitchen) and "More" with the other areas.
// One list of buttons serves both: .pb marks the tab-bar places (styles/10-shell.css shows only those on a phone).
import { store } from '../shared/state/store.js';
import { invalidate } from '../features/inventory/services/ledger.js';
import { renderReturnSheet } from '../features/returns/components/return-sheet.js';
import { closeSheets, renderBillSheet } from '../features/sales/components/bill-panel.js';
import { renderPicker, updatePicker } from '../features/sales/components/variant-picker.js';
import { renderSync } from '../features/sync/components/sync-status.js';
import { provide } from '../shared/di/services.js';
import { savePrefs } from '../shared/state/persistence.js';
import { hideTip } from '../shared/components/tooltip.js';
import { closeModal } from '../shared/components/modal.js';
import { $, $$, esc } from '../shared/dom.js';
import { ICON } from '../shared/constants/icons.js';
import { NAV_ICONS } from '../shared/constants/nav-icons.js';
import { TABS, applyAccessUI, tabOpen } from '../features/shop/components/access-ui.js';
import { chooseSubview, moduleDef, moduleShown, registeredModules, shownModules } from '../features/shop/services/modules.js';
import { moreGroups, navAreas, navWhere } from '../features/shop/services/nav-model.js';
import { currentPerms, currentRole } from '../features/shop/services/access.js';
import { mobileLandingModule, mobileModulesFor, phoneBarFor } from '../domain/shop/mobile-workflow.js';

/* ================= render + navigation ================= */

/* The phone's tab bar for the person signed in: { bar: [module ids], allowed: [module ids a phone shows this role] } */
export function phoneNav(){
  const list = shownModules(), ids = mobileModulesFor(currentRole(), list, currentPerms()).map(d => d.id);
  return { bar: phoneBarFor(currentRole(), list.some(d => d.id === "tables"), ids), allowed: ids };
}
const iconOf = it => NAV_ICONS[it.sub && it.sub !== "levels" ? it.sub : it.tab] || NAV_ICONS[it.tab] || NAV_ICONS.dot;
/* A destination's button: a module ([data-tab]) or a part of one ([data-navsub]; Stock's own part carries both) */
const destAttrs = it => it.sub ? `data-navsub="${esc(it.id)}"${it.sub === "levels" ? ` data-tab="${esc(it.tab)}"` : ""}` : `data-tab="${esc(it.tab)}"`;
let navSig = "";
function drawNav(){
  const nav = $(".nav"); if(!nav) return;
  const areas = navAreas(), { bar } = phoneNav();
  const sig = JSON.stringify([areas, bar]);
  if(sig === navSig && nav.querySelector("[data-navmore]")) return;
  navSig = sig;
  let h = "";
  areas.forEach(a => {
    const side = a.items.filter(it => it.side !== false);
    if(a.key === "team" || (a.key === "settings" && !areas.some(x => x.key === "team"))) h += '<span class="navsep" aria-hidden="true"></span>';
    if(a.label && side.length > 1) h += `<span class="navh">${esc(a.label)}</span>`;
    a.items.forEach(it => {
      const pb = !it.sub || it.sub === "levels" ? bar.indexOf(it.tab) : -1;
      if(it.side === false && pb < 0) return;   // in its area's bar on the page, and in More
      // the tab bar names a place by its area (Stock, not Stock levels)
      const label = pb >= 0 && a.key === "stock" ? "Stock" : it.label;
      h += `<button type="button" class="navi${pb >= 0 ? " pb" : ""}${it.side === false ? " pbonly" : ""}" ${destAttrs(it)} data-dest="${esc(it.id)}" data-area="${esc(a.key)}"${pb >= 0 ? ` style="--pbo:${pb}"` : ""}>${iconOf(it)}<span>${esc(label)}</span></button>`;
    });
  });
  nav.innerHTML = h + `<button type="button" class="navmore" data-navmore aria-haspopup="dialog">${NAV_ICONS.more}<span>More</span></button>`;
}
/* The page of a module (made when a later batch registers a module without one in index.html) */
function sectionOf(id){
  let s = document.getElementById("v-" + id);
  if(!s && moduleDef(id) && moduleDef(id).view !== false){ const none = $("#v-none"); if(!none) return null; s = document.createElement("section"); s.id = "v-" + id; s.hidden = true; none.before(s); }
  return s;
}
export function renderNav(){
  // a team member sees only what its role allows (the owner: everything), and a shop only the modules it uses; a tab it
  // can't use opens the first one it can, and a role with no tab at all (e.g. kitchen, before its screen exists) sees a
  // plain note instead of any screen
  applyAccessUI();
  if(!tabOpen(store.prefs.tab)){ const t = TABS.find(tabOpen) || shownModules().map(d => d.id).find(tabOpen); if(t) store.prefs.tab = t; }
  if(window.innerWidth < 600){
    const landing = mobileLandingModule(currentRole(), shownModules(), currentPerms(), store.prefs.tab);
    if(landing && landing !== store.prefs.tab){ store.prefs.tab = landing; savePrefs(); }
  }
  const none = !tabOpen(store.prefs.tab);
  drawNav();
  const where = none ? { area: "", id: "" } : navWhere(), { bar } = phoneNav();
  const barAreas = new Set($$(".nav .navi.pb").map(b => b.dataset.area));
  $$(".nav .navi").forEach(b => {
    const on = b.dataset.dest === where.id;
    if(on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    // a tab-bar place stands for its whole area (Stock is lit on Products too)
    b.classList.toggle("areaon", b.classList.contains("pb") && b.dataset.area === where.area);
  });
  const more = $(".nav [data-navmore]");
  if(more){ if(where.area && !barAreas.has(where.area) && !bar.includes(store.prefs.tab)) more.setAttribute("aria-current", "page"); else more.removeAttribute("aria-current"); }
  registeredModules().forEach(id => { if(moduleDef(id).view === false) return; const s = sectionOf(id); if(s) s.hidden = none || id !== store.prefs.tab; });
  $("#v-none").hidden = !none;
  $("#billBar").hidden = none || store.prefs.tab !== "sell";
  document.documentElement.dataset.page = none ? "" : store.prefs.tab;   // (not data-tab: that is a link to a page)
  $$("[data-density]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.density === store.prefs.density)));
}
function renderViews(){
  invalidate(); renderNav(); renderSync();
  const t = tabOpen(store.prefs.tab) ? store.prefs.tab : "", d = t && moduleDef(t);   // "": no screen for this role (renderNav shows the note)
  if(d && typeof d.render === "function") d.render();
  // Don't redraw a window under someone typing in it (a live update can arrive any time)
  const a = document.activeElement, typing = a && a.matches && a.matches("#sheetHost input");
  if(store.pick){ if(typing) updatePicker(); else renderPicker(); }
  else if(store.retState && $("#sheetHost .retsheet")){ if(!typing) renderReturnSheet(); }
  else if(store.billOpen) renderBillSheet();
}
function switchTab(t){
  const d = moduleDef(t);
  // a module without a page (an action, e.g. Team) does its action instead
  if(d && d.view === false){ if(moduleShown(t) && typeof d.open === "function") d.open(); return; }
  if(store.prefs.tab === t || !tabOpen(t)) return;
  store.prefs.tab = t; savePrefs(); closeSheets(); hideTip();
  renderViews();
  window.scrollTo(0, 0);
}
/* Open a destination: a module, or one of its parts ("stock:purchases") */
export function openDestination(id){
  const i = String(id || "").indexOf(":"), tab = i < 0 ? id : id.slice(0, i), sub = i < 0 ? "" : id.slice(i + 1);
  closeModal();
  if(sub){ chooseSubview(tab, sub); if(tab === "stock" && store.supplierView) store.supplierView.id = null; }
  if(store.prefs.tab === tab){ renderViews(); window.scrollTo(0, 0); } else switchTab(tab);
}
/* "More" on a phone or tablet: every area the tab bar doesn't hold, in groups */
export function openNavMore(){
  const { bar, allowed } = phoneNav(), where = navWhere();
  const groups = moreGroups(bar, window.innerWidth < 1000 ? allowed : null);
  $("#modalHost").innerHTML = `<div class="scrim" data-modal-scrim><div class="sheet navsheet" role="dialog" aria-modal="true" aria-labelledby="navMoreT">
    <div class="sh-head"><h3 id="navMoreT" style="margin:0;flex:1">More</h3><button class="iconbtn" type="button" data-modal-close aria-label="Close">${ICON.x}</button></div>
    ${groups.map(g => `<div class="navgrp">${g.label ? `<h4>${esc(g.label)}</h4>` : ""}<div class="navlist">${g.items.map(it =>
      `<button type="button" class="navitem" ${destAttrs(it)}${it.id === where.id ? ' aria-current="page"' : ""}>${iconOf(it)}<span>${esc(it.label)}</span></button>`).join("")}</div></div>`).join("")}</div></div>`;
}

/* Called at start-up (app/main.js), before anything renders: renderAll()/setTab() from shared/ui/render.js land here */
export function installNavigation(){
  provide("renderer", { renderAll: renderViews, setTab: switchTab });
  // redraw the bar's places when the window crosses the phone / desktop width
  let wide = window.innerWidth >= 1000;
  window.addEventListener("resize", () => { const w = window.innerWidth >= 1000; if(w !== wide){ wide = w; navSig = ""; if(store.prefs) renderNav(); } });
}
