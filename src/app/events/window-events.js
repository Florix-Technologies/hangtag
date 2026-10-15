// Window resize and online/offline handling.
import { store } from '../../shared/state/store.js';
import { inResetFlow } from '../../features/auth/components/auth-gate.js';
import { onSignedIn } from '../../features/auth/services/session.js';
import { renderReport } from '../../features/reports/pages/report-page.js';
import { renderPicker } from '../../features/sales/components/variant-picker.js';
import { renderSync } from '../../features/sync/components/sync-status.js';
import { initSupabase } from '../../features/sync/services/connection.js';
import { flushSbQueue } from '../../features/sync/services/outbox.js';
import { catchUp } from '../../features/sync/services/catch-up.js';
import { cloudConfigured } from '../../shared/config/app-config.js';
import { $ } from '../../shared/dom.js';
import { use } from '../../shared/di/services.js';

/* Registered once at start-up (app/main.js). */
export function installWindowEvents(){
  window.addEventListener("resize",()=>{clearTimeout(store.rT);store.rT=setTimeout(()=>{if(store.prefs.tab==="report")renderReport();if(store.pick&&!(document.activeElement&&document.activeElement.matches("#sheetHost input")))renderPicker()},160)});
  window.addEventListener("online",async ()=>{
    if(!store.sbClient || inResetFlow() || !$("#setupGate").hidden) return;
    if(cloudConfigured && !store.authUser){
      try{ const { data: { session } } = await use("cloud").auth.getSession(); if(session) await onSignedIn(session); }catch(e){}
      return;
    }
    if(store.sbStatus !== "connected") await initSupabase();
    // back online while still connected: an owner's device uploads its work and catches up on what the other devices did
    // meanwhile (catch-up.js); a member's phone uploads (its 30-second look brings the rest)
    else if(!(await catchUp("online"))) await flushSbQueue();
  });
  window.addEventListener("offline",()=>renderSync());
  // A team sign-in QR's link (<app>#enroll=<code>) opened in a tab where the app is already running: start again, so the
  // phone is signed in to the shop the same way as when the link opens the app (features/auth/services/session.js)
  window.addEventListener("hashchange",()=>{if(/(^#|&)enroll=/.test(location.hash))location.reload()});
}
