// Composition root: restores state, wires the UI and services, then signs in and connects to the cloud.
// Start-up order matches the original single-file app, after providing the ports and the render bus.
import { installContainer } from './container.js';
import { installNavigation } from './navigation.js';
import { installModules } from './modules.js';
import { initState } from './state-init.js';
import { installTestHook } from './test-hook.js';
import { installAccountSwitchWatch } from '../features/auth/services/account-data.js';
import { installSignInEvents } from '../features/auth/components/sign-in-form.js';
import { installSetupEvents } from '../features/shop/components/setup-gate.js';
import { installAccountMenuEvents } from '../features/shop/components/account-events.js';
import { installSyncStatusTimer } from '../features/sync/components/sync-status.js';
import { installSyncRetryTimer } from '../features/sync/services/connection.js';
import { installTooltips } from '../shared/components/tooltip.js';
import { installDomEvents } from './events/dom-events.js';
import { installKeyboard } from './events/keyboard.js';
import { installWindowEvents } from './events/window-events.js';
import { installBillingSettingsEvents } from '../features/shop/components/billing-settings.js';
import { installScaleSettingsEvents } from '../features/hardware/components/scale-settings.js';
import { reconnectScale } from '../features/hardware/services/scale.js';
import { installWeighDialog } from '../features/sales/components/weigh-dialog.js';
import { installPwa } from './pwa.js';
import { store } from '../shared/state/store.js';
import { renderAll } from '../shared/ui/render.js';
import { bootAuth } from '../features/auth/services/session.js';
import { onConnected } from '../features/sync/services/connection.js';
import { loadPayConfig } from '../features/sales/use-cases/provider-payment.js';
import { resumePayment } from '../features/sales/components/payment-sheet.js';
import { checkUnverified } from '../features/finance/components/reconcile-view.js';
import { installAutoDelivery, processDeliveryQueue } from '../features/delivery/use-cases/auto-delivery.js';
import { applyCatalogMigration } from '../features/products/services/catalog.js';
import { initSupabase, memberPoll } from '../features/sync/services/connection.js';
import { isMember } from '../features/shop/services/access.js';
import { flushSbQueue } from '../features/sync/services/outbox.js';
import { sendPendingDocs } from '../features/inventory/use-cases/import-supplier-bill.js';
import { processQuoteSends } from '../features/orders/use-cases/send-quotation.js';
import { rememberReceiptPage } from '../features/shop/use-cases/receipt-page.js';
import { installMenus } from '../shared/ui/kit.js';

installContainer();    // ports first: everything below may use them
installNavigation();   // the render bus (shared/ui/render.js) now reaches this app shell
installModules();       // the pages of the navigation modules (and the parts later batches register)
initState();
installTestHook();
applyCatalogMigration();
installAccountSwitchWatch();
installSignInEvents();
installSetupEvents();
installAccountMenuEvents();
installSyncStatusTimer();
installSyncRetryTimer();
installTooltips();
installMenus();       // every record's and document's "More actions" menu
installDomEvents();
installKeyboard();
installWindowEvents();
installBillingSettingsEvents();
installScaleSettingsEvents();
installWeighDialog();
installPwa();
installAutoDelivery();
// Each time the cloud connects: a provider payment left open is shown again, hand-checked UPI is matched with the
// provider, and receipts waiting to go out are sent
onConnected(async()=>{ await loadPayConfig(true); resumePayment(); await checkUnverified(true); });
onConnected(()=>processDeliveryQueue());
// …and supplier bills' originals that couldn't reach the cloud yet go up (kept on this device until then)
onConnected(()=>{ if(Object.keys(store.pendingDocs||{}).length) sendPendingDocs(); });
// …quotations queued to send go out, and the owner's app keeps the shop's invoice-link page (unless the server sets one)
onConnected(()=>processQuoteSends());
onConnected(()=>rememberReceiptPage(false));
renderAll();
// Sign in, then connect to the cloud database

// A scale this browser remembers is opened again (no prompt), when this device is set to
reconnectScale(store.scale && store.scale.auto);
(async()=>{
  await bootAuth();
  let tick = 0;
  setInterval(()=>{
    tick++;
    if(store.sbOfflineQueue.length && store.sbStatus === "connected") flushSbQueue();
    // Signed in but the cloud dropped out: try again every 30 s while online
    else if(store.authUser && store.sbStatus !== "connected" && navigator.onLine && tick % 3 === 0) initSupabase();
    // A team member's phone gets no live updates: every 30 s it checks it is still in the shop and downloads the latest
    if(store.authUser && isMember() && store.sbStatus === "connected" && tick % 3 === 0) memberPoll();
  }, 10000);
})();
