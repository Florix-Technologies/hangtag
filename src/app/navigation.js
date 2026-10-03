// App shell: tab bar, page switching, full re-render (provided as the "renderer" port behind shared/ui/render.js).
// The tabs are the modules shown in this shop to the person signed in (features/shop/services/modules.js: capabilities,
// permissions, and whether the module exists); each module's page is <section id="v-<id>"> and its render() draws it
// (app/modules.js). On a phone the bar keeps the modules needed most and puts the rest behind "More".
import { store } from '../shared/state/store.js';
import { invalidate } from '../features/inventory/services/ledger.js';
import { renderReturnSheet } from '../features/returns/components/return-sheet.js';
import { closeSheets, renderBillSheet } from '../features/sales/components/bill-panel.js';
import { renderPicker, updatePicker } from '../features/sales/components/variant-picker.js';
import { renderSync } from '../features/sync/components/sync-status.js';
import { provide } from '../shared/di/services.js';
import { savePrefs } from '../shared/state/persistence.js';
import { hideTip } from '../shared/components/tooltip.js';
import { $, $$, esc } from '../shared/dom.js';
import { ICON } from '../shared/constants/icons.js';
import { NAV_ICONS } from '../shared/constants/nav-icons.js';
import { TABS, applyAccessUI, tabOpen } from '../features/shop/components/access-ui.js';
import { moduleDef, moduleShown, navSlots, registeredModules, shownModules } from '../features/shop/services/modules.js';
import { currentPerms, currentRole } from '../features/shop/services/access.js';
import { mobileLandingModule, mobileModulesFor } from '../domain/shop/mobile-workflow.js';

/* ================= render + navigation ================= */

/* Buttons that fit: a phone (under 600 px) 6, a tablet 8, a desktop 11 — beyond that the rest go behind "More" */
const ROOM = { p: 6, t: 8, d: 11 };
let barSig = "";
function drawTabBar(){
  const nav = $(".nav"); if(!nav) return;
  const list = shownModules(), cur = store.prefs.tab, phoneList = mobileModulesFor(currentRole(), list, currentPerms()), phoneIds = new Set(phoneList.map(d => d.id)), slots = {};
  slots.p = navSlots(phoneList, phoneIds.has(cur) ? cur : '', ROOM.p);
  ['t', 'd'].forEach(k => { slots[k] = navSlots(list, cur, ROOM[k]); });
  const sig = JSON.stringify([list.map(d => d.id + ":" + d.label), [...phoneIds], slots]);
  if(sig === barSig && nav.querySelector("[data-navmore]")) return;
  barSig = sig;
  const off = id => Object.keys(ROOM).filter(k => !slots[k].bar.includes(id)).map(k => "n" + k);
  nav.innerHTML = list.map(d => { const c = off(d.id); if(!phoneIds.has(d.id)) c.push('phoneoff');
    return `<button type="button"${d.view === false ? "" : ' role="tab"'} data-tab="${esc(d.id)}" aria-selected="false"${c.length ? ` class="${c.join(" ")}"` : ""}>${d.icon}<span>${esc(d.label)}</span></button>`; }).join("")
    + `<button type="button" class="navmore ${Object.keys(ROOM).filter(k => slots[k].more.length).map(k => "m" + k).join(" ")}" data-navmore aria-haspopup="dialog">${NAV_ICONS.more}<span>More</span></button>`;
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
  drawTabBar();
  $$(".nav [data-tab]").forEach(b => b.setAttribute("aria-selected", String(!none && b.dataset.tab === store.prefs.tab)));
  registeredModules().forEach(id => { if(moduleDef(id).view === false) return; const s = sectionOf(id); if(s) s.hidden = none || id !== store.prefs.tab; });
  $("#v-none").hidden = !none;
  $("#billBar").hidden = none || store.prefs.tab !== "sell";
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
  // a module without a page (Settings) does its action instead
  if(d && d.view === false){ if(moduleShown(t) && typeof d.open === "function") d.open(); return; }
  if(store.prefs.tab === t || !tabOpen(t)) return;
  store.prefs.tab = t; savePrefs(); closeSheets(); hideTip();
  renderViews();
  window.scrollTo(0, 0);
}
/* "More" in the tab bar: the modules that don't fit on this screen */
export function openNavMore(){
  const phone = window.innerWidth < 600;
  const hidden = $$(".nav [data-tab]").filter(b => getComputedStyle(b).display === "none" && !(phone && b.classList.contains('phoneoff')));
  $("#modalHost").innerHTML = `<div class="scrim" data-modal-scrim><div class="sheet navsheet" role="dialog" aria-modal="true" aria-labelledby="navMoreT">
    <div class="sh-head"><h3 id="navMoreT" style="margin:0;flex:1">More</h3><button class="iconbtn" type="button" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="navlist">${hidden.map(b => `<button type="button" class="navitem" data-tab="${esc(b.dataset.tab)}">${b.innerHTML}</button>`).join("")}</div></div></div>`;
}

/* Called at start-up (app/main.js), before anything renders: renderAll()/setTab() from shared/ui/render.js land here */
export function installNavigation(){
  provide("renderer", { renderAll: renderViews, setTab: switchTab });
}
