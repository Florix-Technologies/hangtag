// App shell: the navigation, page switching and the full re-render (provided as the "renderer" port behind
// shared/ui/render.js). Where every destination sits is features/shop/services/nav-model.js (built on the module
// registry, features/shop/services/modules.js: capabilities, permissions, whether the module exists); each module's page
// is <section id="v-<id>"> and its render() draws it (app/modules.js).
//   · a desktop (1000 px and wider): a workspace bar under the app bar — Home · Sell · Bills · Stock · Customers · Reports
//     (nav-model.js PRIMARY_TABS, those this person may open) and "More" with the rest (Store, Hangtag Agent, Team, Settings);
//   · a phone or tablet: a tab bar with four places for this person's role (domain/shop/mobile-workflow.js: Home · Sell ·
//     Bills · Stock; a server Home · Tables · Orders) and "More" with every other area.
// Inside a workspace, a bar on its page chooses the task (Sell: New sale · Held bills · Quotations …; Stock: Stock ·
// Products · Purchases …; features/shop/components/module-page.js). One list of buttons serves both widths: .pb marks the
// tab-bar places (styles/10-shell.css shows only those on a phone).
import { applyRegion } from '../features/shop/services/region.js';
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
import { moreGroups, navWhere, primaryNav } from '../features/shop/services/nav-model.js';
import { currentPerms, currentRole } from '../features/shop/services/access.js';
import { mobileLandingModule, mobileModulesFor, phoneBarFor } from '../domain/shop/mobile-workflow.js';
import { renderGlobalActions } from '../features/search/components/open-anything.js';
import { renderLockScreen } from '../features/billing/components/plans-billing.js';
import { subscriptionLocked } from '../features/billing/services/subscription.js';

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
  const top = primaryNav(), { bar } = phoneNav();
  const sig = JSON.stringify([top, bar]);
  if(sig === navSig && nav.querySelector("[data-navmore]")) return;
  navSig = sig;
  const byTab=new Map(top.map(it=>[it.tab,it]));
  bar.forEach(tab=>{ if(!byTab.has(tab)){ const d=moduleDef(tab); if(d) byTab.set(tab,{tab,id:tab,label:d.label,area:tab}); } });
  const h=[...byTab.values()].map(it=>{
    const pb=bar.indexOf(it.tab), label=it.tab==="report"?"Reports":it.label;
    return `<button type="button" class="navi${pb>=0?" pb":""}" ${destAttrs(it)} data-dest="${esc(it.id)}" data-area="${esc(it.area)}"${pb>=0?` style="--pbo:${pb}"`:""}>${iconOf(it)}<span>${esc(label)}</span></button>`;
  }).join("");
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
  if(!tabOpen(store.prefs.tab)){ const t = TABS.find(tabOpen) || shownModules().filter(d => d.landing !== false).map(d => d.id).find(tabOpen); if(t) store.prefs.tab = t; }
  if(window.innerWidth < 600){
    const landing = mobileLandingModule(currentRole(), shownModules(), currentPerms(), store.prefs.tab);
    if(landing && landing !== store.prefs.tab){ store.prefs.tab = landing; savePrefs(); }
  }
  const none = !tabOpen(store.prefs.tab);
  drawNav();
  renderGlobalActions();
  const where = none ? { area: "", id: "" } : navWhere(), { bar } = phoneNav(), wide = window.innerWidth >= 1000;
  // the places the bar shows at this width: every workspace on a desktop, the tab-bar places on a phone
  const barAreas = new Set($$(wide ? ".nav .navi" : ".nav .navi.pb").map(b => b.dataset.area));
  $$(".nav .navi").forEach(b => {
    const on = b.dataset.dest === where.id || b.dataset.area === where.area;
    if(on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    // a tab-bar place stands for its whole area (Stock is lit on Products too)
    b.classList.toggle("areaon", b.classList.contains("pb") && b.dataset.area === where.area);
  });
  const more = $(".nav [data-navmore]");
  if(more){ if(where.area && !barAreas.has(where.area) && (wide || !bar.includes(store.prefs.tab))) more.setAttribute("aria-current", "page"); else more.removeAttribute("aria-current"); }
  registeredModules().forEach(id => { if(moduleDef(id).view === false) return; const s = sectionOf(id); if(s) s.hidden = none || id !== store.prefs.tab; });
  $("#v-none").hidden = !none;
  $("#billBar").hidden = none || store.prefs.tab !== "sell";
  document.documentElement.dataset.page = none ? "" : store.prefs.tab;   // (not data-tab: that is a link to a page)
  $$("[data-density]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.density === store.prefs.density)));
}
function renderViews(){
  applyRegion();   // money, dates and phone numbers the shop's way (features/shop/services/region.js)
  // the shop's Hangtag plan has ended: the lock screen replaces every screen (features/billing; the server refuses writes too)
  if(renderLockScreen()){ closeSheets(); closeModal(); return; }
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
  if(subscriptionLocked()){ renderViews(); return; }   // no route, shortcut or button opens a screen while locked
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
/* "More": every area the bar doesn't hold, in groups (a phone or tablet: its tab bar; a desktop: its workspace bar) */
export function openNavMore(){
  const phone = phoneNav(), where = navWhere(), bar=window.innerWidth<1000?phone.bar:primaryNav().map(x=>x.tab);
  // a destination already one tap away in the app bar (the Hangtag Agent button on a desktop) isn't listed again
  const agentBtn = $("#globalActions [data-tab=\"assistant\"]"), inHeader = new Set(agentBtn && agentBtn.offsetParent !== null ? ["assistant"] : []);
  const groups = moreGroups(bar, window.innerWidth < 1000 ? phone.allowed : null).map(g => ({ ...g, items: g.items.filter(it => !inHeader.has(it.tab)) })).filter(g => g.items.length);
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
