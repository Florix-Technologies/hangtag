// App shell: tab bar, page switching, full re-render (provided as the "renderer" port behind shared/ui/render.js).
import { renderCustomers } from '../features/customers/pages/customers-page.js';
import { store } from '../shared/state/store.js';
import { renderStock } from '../features/inventory/pages/stock-page.js';
import { invalidate } from '../features/inventory/services/ledger.js';
import { renderProducts } from '../features/products/pages/products-page.js';
import { renderReport } from '../features/reports/pages/report-page.js';
import { renderReturnSheet } from '../features/returns/components/return-sheet.js';
import { closeSheets, renderBill, renderBillSheet } from '../features/sales/components/bill-panel.js';
import { renderPicker, updatePicker } from '../features/sales/components/variant-picker.js';
import { renderGrid } from '../features/sales/pages/sell-page.js';
import { renderSync } from '../features/sync/components/sync-status.js';
import { provide } from '../shared/di/services.js';
import { savePrefs } from '../shared/state/persistence.js';
import { hideTip } from '../shared/components/tooltip.js';
import { $, $$ } from '../shared/dom.js';

/* ================= render + navigation ================= */

export function renderNav(){
  $$(".nav [data-tab]").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.tab===store.prefs.tab)));
  ["sell","stock","report","products","customers"].forEach(t=>{$("#v-"+t).hidden=t!==store.prefs.tab});
  $("#billBar").hidden=store.prefs.tab!=="sell";
  $$("[data-density]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.density===store.prefs.density)));
}
function renderViews(){
  invalidate();renderNav();renderSync();
  const t=store.prefs.tab;
  if(t==="sell"){renderGrid();renderBill()}
  else if(t==="stock")renderStock();
  else if(t==="report")renderReport();
  else if(t==="customers")renderCustomers();
  else if(t==="products"){const a=document.activeElement;if(!(a&&a.closest&&a.closest("#v-products")&&a.id!=="prodSearch"))renderProducts()}
  // Don't redraw a window under someone typing in it (a live update can arrive any time)
  const a=document.activeElement, typing=a&&a.matches&&a.matches("#sheetHost input");
  if(store.pick){if(typing)updatePicker();else renderPicker()}
  else if(store.retState&&$("#sheetHost .retsheet")){if(!typing)renderReturnSheet()}
  else if(store.billOpen)renderBillSheet();
}
function switchTab(t){
  if(store.prefs.tab===t)return;
  store.prefs.tab=t;savePrefs();closeSheets();hideTip();
  renderViews();
  window.scrollTo(0,0);
}

/* Called at start-up (app/main.js), before anything renders: renderAll()/setTab() from shared/ui/render.js land here */
export function installNavigation(){
  provide("renderer", { renderAll: renderViews, setTab: switchTab });
}
