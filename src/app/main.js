// Composition root: restores state, wires the UI and services, then signs in and connects to the cloud.
// Start-up order matches the original single-file app, after providing the ports and the render bus.
import { installContainer } from './container.js';
import { installNavigation } from './navigation.js';
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
import { installPwa } from './pwa.js';
import { store } from '../shared/state/store.js';
import { renderAll } from '../shared/ui/render.js';
import { bootAuth } from '../features/auth/services/session.js';
import { applyCatalogMigration } from '../features/products/services/catalog.js';
import { initSupabase } from '../features/sync/services/connection.js';
import { flushSbQueue } from '../features/sync/services/outbox.js';

installContainer();    // ports first: everything below may use them
installNavigation();   // the render bus (shared/ui/render.js) now reaches this app shell
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
installDomEvents();
installKeyboard();
installWindowEvents();
installBillingSettingsEvents();
installPwa();
renderAll();
// Sign in, then connect to the cloud database

(async()=>{
  await bootAuth();
  let tick = 0;
  setInterval(()=>{
    tick++;
    if(store.sbOfflineQueue.length && store.sbStatus === "connected") flushSbQueue();
    // Signed in but the cloud dropped out: try again every 30 s while online
    else if(store.authUser && store.sbStatus !== "connected" && navigator.onLine && tick % 3 === 0) initSupabase();
  }, 10000);
})();
