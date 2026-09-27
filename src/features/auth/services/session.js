// Session lifecycle: boot, signed in/out, working locally, sign out.
import { store } from '../../../shared/state/store.js';
import { profileComplete } from '../../../domain/shop/profile.js';
import { enterReset, gateUp, hideGate, inResetFlow, showGate } from '../components/auth-gate.js';
import { aEl } from '../../../shared/components/gate.js';
import { AUTH_STORE, OTP_TYPES, PICK_ACCOUNT, RECOVERY_KEY, RESET_KEY, clearStoredSession, recent } from '../config.js';
import { loadUserState, switchLocalDataTo } from './account-data.js';
import { isNetErr, linkErrorText } from './auth-errors.js';
import { closeAcctMenu, firstName, renderAccount } from '../../shop/components/account-menu.js';
import { closeSettings } from '../../shop/components/settings-modal.js';
import { hideSetup, showSetup } from '../../shop/components/setup-gate.js';
import { loadProfile } from '../../shop/services/profile-service.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { initSupabase, newSbClient } from '../../sync/services/connection.js';
import { toast } from '../../../shared/components/toast.js';
import { cloudConfigured, cloudWanted } from '../../../shared/config/app-config.js';
import { storage } from '../../../shared/state/persistence.js';
import { use } from '../../../shared/di/services.js';
import { logger } from '../../../shared/logging/logger.js';

/* ---------- signing in and out ---------- */

export function workLocallyAs(email){
  hideGate(); hideSetup();
  store.sbStatus = "disconnected"; store.mode = "standalone"; renderSync();
  renderAccount();
}
export function onSignedIn(session){
  if(store.signingIn) return store.signingIn;   // one at a time; several events can ask at once
  store.signingIn = doSignedIn(session).finally(() => { store.signingIn = null; });
  return store.signingIn;
}
export async function doSignedIn(session){
  if(inResetFlow()) return;
  const user = session && session.user;
  if(!user) return;
  const email = user.email || "";
  let switched = false;
  try{ switched = switchLocalDataTo(user.id); }
  catch(e){ showGate("signin", { error: e.message }); return; }
  storage.set("hangtag_auth_email", email);
  if(switched) loadUserState();   // this account's own products and bills, no page reload
  storage.set(PICK_ACCOUNT, "");
  store.authUser = user;
  const { profile: p, fresh } = await loadProfile(user);
  // First time (or details missing): ask for the shop details before opening the till
  if(fresh && !profileComplete(p)){ showSetup(Object.assign({ full_name: (user.user_metadata || {}).full_name || (user.user_metadata || {}).name || "" }, p || {})); return; }
  await enterApp(false);
}
export async function enterApp(firstTime){
  hideGate(); hideSetup();
  renderAccount();
  if(firstTime) toast("Welcome to Hangtag, " + firstName() + ". Your shop is ready.");
  await initSupabase();
}
export function onSignedOut(){
  store.authUser = null;
  storage.set("hangtag_auth_email", ""); storage.set(RESET_KEY, ""); storage.set(RECOVERY_KEY, "");
  if(store.sbRealtimeChannel && store.sbClient){ use("cloud").removeChannel(store.sbRealtimeChannel); store.sbRealtimeChannel = null; }
  store.sbStatus = "disconnected"; store.mode = "standalone"; renderSync();
  closeSettings(); closeAcctMenu();
  renderAccount();
  aEl("welcome").hidden = true;
  document.title = "Hangtag";
  showGate("signin");
}
export async function signOut(){
  // Local sign-out: only this device. Offline with an expired token supabase-js returns an error and keeps
  // the session (or waits on the network), which would sign the old account back in later, so remove it here.
  store.signedOutByUser = true;
  storage.set(PICK_ACCOUNT, "1");
  let res = null;
  try{
    res = await Promise.race([
      use("cloud").auth.signOut({ scope: "local" }),
      new Promise(r => setTimeout(() => r({ error: new Error("Sign-out timed out") }), 3000))
    ]);
  }catch(e){ res = { error: e }; }
  if(res && res.error){ logger.warn("Sign-out notice:", res.error); clearStoredSession(); }
  onSignedOut();
}
export async function bootAuth(){
  const lastEmail = storage.get("hangtag_auth_email", "");
  if(!cloudWanted){ hideGate(); await initSupabase(); return; }   // no cloud set up: local-only till
  if(!cloudConfigured){
    // The sign-in library didn't load (first open with no internet, or the CDN is blocked)
    if(lastEmail){ workLocallyAs(lastEmail); return; }
    showGate("loading", { message: "Couldn't load the sign-in service. Check the internet connection, then reload the page." });
    return;
  }
  store.sbClient = newSbClient();
  let recovering = false;
  // Listen before the client finishes reading the address bar, so a password-reset link is recognised
  use("cloud").auth.onAuthStateChange((event, s) => {
    if(event === "PASSWORD_RECOVERY"){ recovering = true; return; }
    if(event === "SIGNED_OUT"){
      storage.set("hangtag_auth_email", "");
      if(store.bootDone && (store.authUser || !gateUp())) setTimeout(onSignedOut, 0);
      return;
    }
    if(!s || !s.user) return;
    // A refresh that was already under way when the user signed out: throw it away
    if(store.signedOutByUser && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")){ clearStoredSession(); return; }
    // Another tab signed in as someone else: start over as that account
    if(store.authUser && s.user.id !== store.authUser.id){ location.reload(); return; }
    if(store.authUser && event === "USER_UPDATED") store.authUser = s.user;
    if(!store.bootDone || inResetFlow()) return;
    // A token refresh that failed offline has now worked: finish signing in / reconnect
    if(!store.authUser && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) setTimeout(() => onSignedIn(s), 0);
    else if(store.authUser && event === "TOKEN_REFRESHED" && store.sbStatus !== "connected") setTimeout(() => initSupabase(), 0);
  });
  const qs = new URLSearchParams(location.search), hs = new URLSearchParams(location.hash.slice(1));
  const tokenHash = qs.get("token_hash"), otpType = qs.get("type");
  const linkErr = qs.get("error_code") || hs.get("error_code") || qs.get("error") || hs.get("error");
  const cameBack = qs.has("code") || hs.has("access_token") || !!tokenHash;
  // Email links that carry a token_hash work in any browser, not just the one that asked (see schema.sql notes)
  let otpError = "";
  if(tokenHash && OTP_TYPES.includes(otpType)){
    try{
      const { error } = await use("cloud").auth.verifyOtp({ token_hash: tokenHash, type: otpType });
      if(error) otpError = linkErrorText(error.code || error.message);
      else if(otpType === "recovery") recovering = true;
    }catch(e){ otpError = linkErrorText(""); }
  }
  let hasStored = false;
  try{ hasStored = !!storage.getRaw(AUTH_STORE); }catch(e){}
  const sessP = use("cloud").auth.getSession().then(r => r, e => ({ data: { session: null }, error: e }));
  // A signed-in till shouldn't sit on "Checking sign-in…" on a slow or captive network: open locally after 4 s
  const r = (lastEmail && hasStored && !cameBack) ? await Promise.race([sessP, new Promise(res => setTimeout(() => res(null), 4000))]) : await sessP;
  const session = r && r.data ? r.data.session : null, sessErr = r ? r.error : null;
  if(cameBack || linkErr) history.replaceState(null, "", location.pathname);   // tidy the address bar
  store.bootDone = true;
  if(r === null){
    workLocallyAs(lastEmail);
    sessP.then(rr => { const s = rr && rr.data && rr.data.session; if(s && !store.authUser) onSignedIn(s); });
    return;
  }
  if(session && (recovering || (qs.has("code") && recent(RESET_KEY)) || recent(RECOVERY_KEY))){
    enterReset(session.user && session.user.email);
    return;
  }
  if(session){ showGate("loading", { message: "Opening your shop…" }); await onSignedIn(session); return; }
  // Signed in here before, and the internet is down or flaky: keep selling on this device
  if(lastEmail && (!navigator.onLine || isNetErr(sessErr))){ workLocallyAs(lastEmail); return; }
  showGate("signin", {
    error: otpError || (linkErr ? linkErrorText(linkErr) : ""),
    note: !otpError && !linkErr && cameBack
      ? "If you just confirmed your email, sign in below. If you were resetting your password, open the reset link in the same browser you asked from, or ask for a new one."
      : ""
  });
}
