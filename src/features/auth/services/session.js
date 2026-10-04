// Session lifecycle: boot, signed in/out, working locally, sign out.
import { store } from '../../../shared/state/store.js';
import { profileComplete } from '../../../domain/shop/profile.js';
import { askToEnroll, enterReset, gateUp, hideGate, inResetFlow, showGate } from '../components/auth-gate.js';
import { aEl } from '../../../shared/components/gate.js';
import { AUTH_STORE, OTP_TYPES, PICK_ACCOUNT, RECOVERY_KEY, RESET_KEY, clearStoredSession, recent } from '../config.js';
import { loadUserState, switchLocalDataTo } from './account-data.js';
import { isNetErr, linkErrorText } from './auth-errors.js';
import { closeAcctMenu, firstName, renderAccount } from '../../shop/components/account-menu.js';
import { closeSettings } from '../../shop/components/settings-page.js';
import { hideSetup, showSetup } from '../../shop/components/setup-gate.js';
import { loadProfile } from '../../shop/services/profile-service.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { initSupabase, newSbClient } from '../../sync/services/connection.js';
import { toast } from '../../../shared/components/toast.js';
import { cloudConfigured, cloudWanted } from '../../../shared/config/app-config.js';
import { storage } from '../../../shared/state/persistence.js';
import { use } from '../../../shared/di/services.js';
import { logger } from '../../../shared/logging/logger.js';
import { enrollThisPhone, isStaffAccount, openAsMember } from './member-session.js';
import { forgetDevice, putDeviceAway, useDeviceOf } from './device.js';
import { clearAccess, signedInAs } from '../../shop/services/access.js';

/* ---------- signing in and out ---------- */

/* Who is signed in on this browser, from the session supabase-js keeps (no network): a name to show, or "" */
export function storedAccount(){
  let raw = null;
  try{ raw = storage.getRaw(AUTH_STORE); }catch(e){ raw = null; }
  if(!raw) return "";
  let u = null;
  try{ const s = JSON.parse(raw); u = (s && (s.user || (s.currentSession && s.currentSession.user))) || null; }catch(e){ u = null; }
  if(!u){ try{ const x = JSON.parse(storage.getRaw(AUTH_STORE + "-user") || "null"); u = (x && (x.user || x)) || null; }catch(e){ u = null; } }
  const meta = (u && u.user_metadata) || {};
  if(meta.staff) return (meta.full_name ? meta.full_name + " " : "") + "(a team member)";
  return (u && u.email) || storage.get("hangtag_auth_email", "") || "another account";
}

export function workLocallyAs(email){
  hideGate(); hideSetup();
  store.sbStatus = "disconnected"; store.mode = "standalone"; renderSync();
  renderAccount();
}
/* opts.staff / opts.password: signed in with a password just now (Staff tab / email form): a team member's phone without a
   device key may then be added to the member's devices */
export function onSignedIn(session, opts){
  if(store.signingIn) return store.signingIn;   // one at a time; several events can ask at once
  store.signingIn = doSignedIn(session, opts).finally(() => { store.signingIn = null; });
  return store.signingIn;
}
export async function doSignedIn(session, opts){
  opts = opts || {};
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
  useDeviceOf(user.id);   // this account's own device key, if it has one on this phone (another member's is put away)
  // A team member opens its shop with its role: the shop's profile, never the owner's setup screen
  if(opts.staff || isStaffAccount(user)){
    const m = await openAsMember(user, { mayRegister: !!(opts.staff || opts.password) });
    if(!m.ok){ await signOut({ message: m.message, forgetDevice: !!m.lost }); return; }
    if(m.member){ await enterApp(false); toast("Signed in as " + signedInAs() + "."); return; }
  }
  clearAccess();   // an owner: every permission, exactly as before
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
/* opts: { message (shown on the sign-in screen), forgetDevice (this phone's team device key is useless: forget it) } */
export function onSignedOut(opts){
  // already signed out with the sign-in form up (the auth listener's second call after Sign out): keep its message
  if(!opts && !store.authUser && !aEl("authGate").hidden && !aEl("authForms").hidden) return;
  opts = opts || {};
  store.authUser = null;
  // a member's device key goes with the member: kept aside for its next sign-in here, or forgotten when revoked
  if(opts.forgetDevice) forgetDevice(); else putDeviceAway();
  storage.set("hangtag_auth_email", ""); storage.set(RESET_KEY, ""); storage.set(RECOVERY_KEY, "");
  if(store.sbRealtimeChannel && store.sbClient){ use("cloud").removeChannel(store.sbRealtimeChannel); store.sbRealtimeChannel = null; }
  store.sbStatus = "disconnected"; store.mode = "standalone"; renderSync();
  closeSettings(); closeAcctMenu();
  renderAccount();
  aEl("welcome").hidden = true;
  document.title = "Hangtag";
  showGate("signin", opts.message ? { error: opts.message } : undefined);
}
export async function signOut(opts){
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
  onSignedOut(opts || {});
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
  // A phone opened the owner's QR code (<app>#enroll=<token>): the code is single-use, so it leaves the address bar at once.
  // Someone signed in here already: ask before switching this browser to the team member (nothing is redeemed until then)
  const enroll = new URLSearchParams(location.hash.slice(1)).get("enroll");
  if(enroll){
    history.replaceState(null, "", location.pathname + location.search);
    const here = storedAccount();
    if(!here || await askToEnroll(here)){
      showGate("loading", { message: "Signing this phone in to the shop…" });
      const r = await enrollThisPhone(enroll);
      if(!r.ok){ store.bootDone = true; showGate("signin", { mode: "staff", error: r.message }); return; }
    } else showGate("loading", { message: "Opening your shop…" });
  }
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
