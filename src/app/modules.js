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
import { onSubviewClick, renderAreaNav, renderSubviews } from '../features/shop/components/module-page.js';
import { openTeam } from '../features/shop/components/team-settings.js';
import { renderHome } from '../features/home/pages/home-page.js';
import { installBillsPageEvents, renderBillsPage } from '../features/bills/pages/bills-page.js';
import { renderBill } from '../features/sales/components/bill-panel.js';
import { renderGrid } from '../features/sales/pages/sell-page.js';
import { renderStock } from '../features/inventory/pages/stock-page.js';
import { renderReport } from '../features/reports/pages/report-page.js';
import { renderCustomers } from '../features/customers/pages/customers-page.js';
import { renderProducts } from '../features/products/pages/products-page.js';
import { renderSettingsPage } from '../features/shop/components/settings-page.js';
import { openDestination, openNavMore } from './navigation.js';
import { ORDERS_MODULE } from '../features/orders/module.js';
import { INVENTORY_SUBVIEWS, renderInventoryPart } from '../features/inventory/components/inventory-views.js';
import { renderOrdersPart } from '../features/orders/pages/orders-page.js';
import { storage } from '../shared/state/persistence.js';
import { products } from '../features/products/services/catalog.js';
import { unitOf } from '../domain/catalog/units.js';
import { expirySettingsHTML } from '../features/inventory/components/expiry-settings.js';
import { trackingOfP } from '../features/inventory/services/tracking.js';
import { renderTablesPage } from '../features/restaurant/pages/tables-page.js';
import { renderKitchenPage } from '../features/restaurant/pages/kitchen-page.js';
import { mayWorkTables } from '../features/restaurant/services/restaurant-state.js';
import { installRestaurantTimers } from './events/restaurant-events.js';
import { invoicePageHTML, quotationSettingsHTML } from '../features/orders/components/quotation-settings.js';
import { installAssistantEvents, renderAssistantPage } from '../features/assistant/pages/assistant-page.js';
import { installProductDraftEvents } from '../features/products/components/product-draft-assistant.js';
import { installVoiceSearch } from '../features/search/components/voice-search.js';
import { priceListsSettingsHTML } from '../features/commerce/components/settings-parts.js';
import { gstSettingsHTML } from '../features/commerce/components/gst-documents.js';
import { vouchersSettingsHTML } from '../features/commerce/components/vouchers.js';
import { integrationsSettingsHTML } from '../features/commerce/components/webhooks.js';
import { bankAccountsSettingsHTML, installBankEvents } from '../features/finance/components/bank-accounts-view.js';
import { installStoreEvents, renderStorePage, storeOpen } from '../features/commerce/pages/store-page.js';
import { docTemplatesHTML, installDocTemplateEvents } from '../features/receipts/components/doc-templates.js';

let installed = false;
export function installModules(){
  if(installed) return;
  installed = true;
  registerModule({ id: "home", render: renderHome });
  registerModule({ id: "sell", render(){ renderAreaNav("sell"); renderGrid(); renderBill(); } });
  registerModule({ id: "bills", render: renderBillsPage });
  registerModule({ id: "orders", render: () => renderSubviews("orders") });
  // Orders (T3): held bills for every shop; quotations and sales orders where the shop uses them
  ORDERS_MODULE.submodules.forEach((m, i) => registerSubview("orders", { id: m.id, label: m.label, order: 10 * (i + 1), caps: m.capability ? [m.capability] : [], perms: m.permissions, render: host => renderOrdersPart(host, m.id) }));
  registerModule({ id: "stock", render: () => renderSubviews("stock") });
  registerSubview("stock", { id: "levels", label: "Stock", order: 10, main: true, render: () => renderStock() });
  // Inventory (T2): purchases, suppliers and stock count, for the roles that use them
  INVENTORY_SUBVIEWS.forEach((d, i) => registerSubview("stock", { id: d.id, label: d.label, order: 20 + 10 * i, perms: d.perms, ...(d.available ? { available: d.available } : {}), render: host => renderInventoryPart(d, host) }));
  registerModule({ id: "report", render: renderReport });
  registerModule({ id: "assistant", label: "Hangtag Agent", order: 85, phone: 55, perms: ["view_reports"], render: renderAssistantPage });
  registerModule({ id: "customers", render: renderCustomers });
  // don't redraw the product list under someone typing in it (except its search box)
  registerModule({ id: "products", render(){ renderAreaNav("products"); const a = document.activeElement; if(!(a && a.closest && a.closest("#v-products") && a.id !== "prodSearch")) renderProducts(); } });
  // a page you choose (account menu, More), never where the app lands: a role with no work screen sees "Nothing to open here yet"
  registerModule({ id: "settings", view: true, landing: false, render: () => renderSettingsPage() });
  // Team (the owner's): the people who sell in the shop, their roles and phones
  registerModule({ id: "team", label: "Team", order: 88, phone: 75, view: false, perms: ["manage_users"], open: () => openTeam() });
  // Settings → Team & Devices: the weighing scale (T1), for shops that sell by weight (the capability, or a product sold by the kg or
  // litre) or that already set one up on this device
  const weighs = () => hasCap("uses_weight") || !!storage.get("hangtag_scale", null) || products().some(p => /^(weight|volume)$/.test(unitOf(p.unit).kind));
  registerSettingsPart("devices", { id: "scale", order: 20, html: () => weighs() ? scaleSetupHTML() : "" });
  // Settings → Products & Inventory (Wave 2): for shops that keep expiry dates or batches
  const expires = () => hasCap("uses_expiry") || hasCap("uses_batches") || products().some(p => trackingOfP(p) === "batch");
  registerSettingsPart("inventory", { id: "expiry", order: 20, perms: ["manage_settings"], html: () => expires() ? expirySettingsHTML() : "" });
  // Settings → Billing & Documents: the page invoice links open (the owner's), and the quotation template for shops that make quotations
  registerSettingsPart("integrations", { id: "invoice-page", order: 20, perms: ["manage_settings"], html: invoicePageHTML });
  registerSettingsPart("billing", { id: "quotations", order: 60, perms: ["manage_settings"], html: () => hasCap("uses_quotations") ? quotationSettingsHTML() : "" });
  // Settings → Sales & Customers (section 3r): price lists for shops that use them
  registerSettingsPart("sales", { id: "price-lists", order: 10, perms: ["manage_products"], html: () => hasCap("uses_price_lists") ? priceListsSettingsHTML() : "" });
  registerSettingsPart("sales", { id: "vouchers", order: 20, perms: ["create_sale", "manage_settings"], html: vouchersSettingsHTML });
  registerSettingsPart("billing", { id: "gst-docs", order: 50, perms: ["manage_settings"], html: gstSettingsHTML });
  // Settings → Billing & Documents → Templates: one look for every A4 document
  registerSettingsPart("billing", { id: "templates", order: 5, perms: ["manage_settings"], html: docTemplatesHTML });
  // Settings → Advanced: integrations (outbound webhooks), the owner's only
  registerSettingsPart("integrations", { id: "webhooks", order: 10, html: integrationsSettingsHTML });
  // Settings → Payments & Banks: the shop's bank accounts (section 3s)
  registerSettingsPart("payments", { id: "banks", order: 10, perms: ["manage_settings", "view_reports"], html: bankAccountsSettingsHTML });
  // Restaurant (W2-B): the tables (a till, or servers ordering on their phones) and the kitchen screen — only with the shop's
  // table / kitchen capabilities (the registry adds them to these modules by itself)
  registerModule({ id: "tables", label: "Tables", order: 32, phone: 25, caps: ["uses_tables"], perms: ["create_sale", "create_order", "manage_tables", "manage_settings"], available: mayWorkTables, render: renderTablesPage });
  registerModule({ id: "kitchen", label: "Kitchen", order: 34, phone: 26, caps: ["uses_kitchen"], perms: ["manage_kitchen"], render: renderKitchenPage });
  // Store (UX pass): the public mobile store as its own area for the owner and managers, where the shop takes sales orders
  registerModule({ id: "store", label: "Store", order: 36, phone: 65, caps: ["uses_sales_orders", "uses_mobile_store"], perms: ["manage_settings"], render: renderStorePage });
  registerSettingsPart("storefront", { id: "store", order: 10, perms: ["manage_settings"], html: () => `<div class="setblk"><h5>Mobile store</h5><p class="note" style="margin:0 0 12px">${storeOpen() ? "Your store is open: customers can browse and order from their phones." : "Your store is closed. Open it, share the link or QR, and see the orders in the Store area."}</p><button type="button" class="btn primary" data-tab="store">Open the Store area</button></div>` });
  installRestaurantTimers();
  installAssistantEvents();
  installProductDraftEvents();
  installVoiceSearch();
  installBillsPageEvents();
  installBankEvents();
  installStoreEvents();
  installDocTemplateEvents();
  document.addEventListener("click", e => {
    // a destination that is a part of a module (Purchases is Stock → Purchases): open the module on that part
    const ns = e.target && e.target.closest && e.target.closest("[data-navsub]");
    if(ns){ e.stopImmediatePropagation(); openDestination(ns.dataset.navsub); return; }
    if(onSubviewClick(e)) return;
    if(e.target && e.target.closest && e.target.closest("[data-navmore]")) openNavMore();
  });
}
