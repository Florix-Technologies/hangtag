// The app's pages in the navigation module registry (features/shop/services/modules.js): what each core module draws,
// the parts of Inventory and Orders, and the clicks of their part bars and the tab bar's "More".
// Later batches plug in the same way, before the first render (app/main.js calls installModules() at start-up):
//   registerSubview("stock", { id: "purchases", label: "Purchases", order: 20, perms: ["create_purchase"], render(host){…} })
//   registerSubview("orders", { id: "quotes", label: "Quotations", order: 20, caps: ["uses_quotations"], perms: ["create_order"], render(host){…} })
//   registerModule({ id: "tables", label: "Tables", order: 32, phone: 25, caps: ["uses_tables"], render(){…} })
// A part or module that isn't registered doesn't exist in the app: nothing shows for it (Orders appears only once one
// of its parts is registered and in use).
import { registerModule, registerSubview } from '../features/shop/services/modules.js';
import { registerSettingsPart } from '../features/shop/services/settings-sections.js';
import { hasCap } from '../features/shop/services/shop-caps.js';
import { scaleSetupHTML } from '../features/hardware/components/scale-settings.js';
import { onSubviewClick, renderSubviews } from '../features/shop/components/module-page.js';
import { renderHome } from '../features/home/pages/home-page.js';
import { renderBill } from '../features/sales/components/bill-panel.js';
import { renderGrid } from '../features/sales/pages/sell-page.js';
import { renderStock } from '../features/inventory/pages/stock-page.js';
import { renderReport } from '../features/reports/pages/report-page.js';
import { renderCustomers } from '../features/customers/pages/customers-page.js';
import { renderProducts } from '../features/products/pages/products-page.js';
import { openSettings } from '../features/shop/components/settings-modal.js';
import { openNavMore } from './navigation.js';
import { storage } from '../shared/state/persistence.js';

let installed = false;
export function installModules(){
  if(installed) return;
  installed = true;
  registerModule({ id: "home", render: renderHome });
  registerModule({ id: "sell", render(){ renderGrid(); renderBill(); } });
  registerModule({ id: "orders", render: () => renderSubviews("orders") });
  registerModule({ id: "stock", render: () => renderSubviews("stock") });
  registerSubview("stock", { id: "levels", label: "Stock", order: 10, main: true, render: () => renderStock() });
  registerModule({ id: "report", render: renderReport });
  registerModule({ id: "customers", render: renderCustomers });
  // don't redraw the product list under someone typing in it (except its search box)
  registerModule({ id: "products", render(){ const a = document.activeElement; if(!(a && a.closest && a.closest("#v-products") && a.id !== "prodSearch")) renderProducts(); } });
  registerModule({ id: "settings", open: openSettings });
  // Settings → Hardware: the weighing scale (T1), for shops that sell by weight or already set one up on this device
  registerSettingsPart("hardware", { id: "scale", order: 20, html: () => hasCap("uses_weight") || storage.get("hangtag_scale", null) ? scaleSetupHTML() : "" });
  document.addEventListener("click", e => {
    if(onSubviewClick(e)) return;
    if(e.target && e.target.closest && e.target.closest("[data-navmore]")) openNavMore();
  });
}
