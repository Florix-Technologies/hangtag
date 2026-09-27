// Sign-in actions from the gate: providers, email sign-in/up, confirmation, password reset.
import { store } from '../../../shared/state/store.js';
import { setAuthBusy, setAuthError, setAuthNote, setEmailMode, showGate } from './auth-gate.js';
import { aEl } from '../../../shared/components/gate.js';
import { MIN_PW, PICK_ACCOUNT, PROVIDERS, RECOVERY_KEY, RESET_KEY } from '../config.js';
import { authErrorText } from '../services/auth-errors.js';
import { loadAuthSettings, signInMethodsFor } from '../services/auth-settings.js';
import { onSignedIn, signOut } from '../services/session.js';
import { toast } from '../../../shared/components/toast.js';
import { HOME_URL } from '../../../shared/config/app-config.js';
import { storage } from '../../../shared/state/persistence.js';
import { validEmail } from '../../../shared/validation/email.js';
import { use } from '../../../shared/di/services.js';

export async function signInWith(provider, loginHint){
  setAuthError(""); if(!loginHint) setAuthNote("");
  if(!navigator.onLine){ setAuthError("You're offline. Connect to the internet to sign in."); return; }
  const p = PROVIDERS[provider];
  if(!p) return;
  store.signedOutByUser = false;
  setAuthBusy(true);
  try{
    let settings = null;
    try{ settings = await loadAuthSettings(); }catch(e){ /* couldn't check; let Supabase answer */ }
    if(settings && settings.external && settings.external[provider] === false){
      setAuthBusy(false);
      setAuthError(p.label + " sign-in isn't switched on for this app yet. Ask the owner to turn it on in Supabase.");
      return;
    }
    storage.set(RESET_KEY, "");
    const options = { redirectTo: HOME_URL };
    if(p.scopes) options.scopes = p.scopes;
    const qp = {};
    // Only ask to choose an account after Sign out (switching accounts). Asking every time makes people who
    // aren't already signed in to Google type their details and then pick the same account again.
    if((provider === "google" || provider === "azure") && storage.get(PICK_ACCOUNT, "")) qp.prompt = "select_account";
    if(loginHint && provider === "google") qp.login_hint = loginHint;   // pre-fill the email on Google's page
    if(Object.keys(qp).length) options.queryParams = qp;
    const { error } = await use("cloud").auth.signInWithOAuth({ provider, options });
    if(error) throw error;
    // The browser is now on its way to the sign-in service (buttons stay disabled; "pageshow" re-enables them on Back)
  }catch(e){
    setAuthBusy(false);
    setAuthError(p.label + " sign-in failed: " + authErrorText(e));
  }
}
/* Email: first ask for the address, then decide - Google account, password, or new account */

export async function onEmailSubmit(ev){
  ev.preventDefault();
  const email = aEl("authEmail").value.trim().toLowerCase(), pass = aEl("authPass").value, pass2 = aEl("authPass2").value;
  setAuthError(""); setAuthNote(""); aEl("resendBtn").hidden = true;
  if(!validEmail(email)){ setAuthError("Enter a valid email address."); aEl("authEmail").focus(); return; }
  if(store.emailMode === "signin" && !pass){ setAuthError("Enter your password."); aEl("authPass").focus(); return; }
  if(store.emailMode === "signup"){
    if(pass.length < MIN_PW){ setAuthError("Choose a password of at least " + MIN_PW + " characters."); aEl("authPass").focus(); return; }
    if(pass !== pass2){ setAuthError("The two passwords don't match."); aEl("authPass2").focus(); return; }
  }
  if(!navigator.onLine){ setAuthError("You're offline. Connect to the internet to sign in."); return; }
  aEl("authEmail").value = email;
  store.signedOutByUser = false;
  setAuthBusy(true);
  try{
    if(store.emailMode !== "forgot"){
      // How does this email sign in today? (null = couldn't find out; then just try)
      const methods = await signInMethodsFor(email);
      const oauth = methods && !methods.includes("email") ? methods.find(m => PROVIDERS[m]) : null;
      if(oauth){
        // This email already has an account through Google (or another service): continue with that
        setAuthNote("This email already has an account through " + PROVIDERS[oauth].label + ". Taking you there…");
        await signInWith(oauth, email);
        return;
      }
      let settings = null;
      try{ settings = await loadAuthSettings(); }catch(e){}
      if(settings && settings.external && settings.external.email === false){
        setAuthError("Email sign-in isn't switched on for this app yet. Use Continue with Google, or ask the owner to turn on Email in Supabase.");
        return;
      }
      if(store.emailMode === "signin" && methods && !methods.length){
        // No account with this email yet: move to Create account, keeping the email
        setEmailMode("signup"); aEl("authEmail").value = email;
        setAuthNote("There's no Hangtag account for " + email + " yet. Choose a password to create one.");
        aEl("authPass").focus();
        return;
      }
      if(store.emailMode === "signup" && methods && methods.includes("email")){
        // Already has an email account: move to Sign in, keeping the email
        setEmailMode("signin"); aEl("authEmail").value = email;
        setAuthNote("You already have an account with " + email + ". Enter your password to sign in.");
        aEl("authPass").focus();
        return;
      }
    }
    if(store.emailMode === "signin"){
      const { data, error } = await use("cloud").auth.signInWithPassword({ email, password: pass });
      if(error){
        if(error.code === "email_not_confirmed" || /email not confirmed/i.test(error.message || "")) aEl("resendBtn").hidden = false;
        throw error;
      }
      aEl("authPass").value = "";
      storage.set(RESET_KEY, "");
      showGate("loading", { message: "Opening your shop…" });
      await onSignedIn(data.session);
    } else if(store.emailMode === "signup"){
      storage.set(RESET_KEY, "");
      const { data, error } = await use("cloud").auth.signUp({ email, password: pass, options: { emailRedirectTo: HOME_URL } });
      if(error) throw error;
      aEl("authPass").value = ""; aEl("authPass2").value = "";
      if(data.session){ showGate("loading", { message: "Opening your shop…" }); await onSignedIn(data.session); return; }
      // Supabase doesn't reveal existing emails: an existing account comes back with no identities
      if(data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0){
        showGate("signin", { mode: "signin", error: "An account with this email already exists. Enter its password, or use Forgot password." });
        aEl("authEmail").value = email;
        return;
      }
      showGate("signin", { mode: "signin", note: "Almost done. We sent a confirmation link to " + email + ". Open it, then sign in here.", showResend: true });
      aEl("authEmail").value = email;
    } else {
      const { error } = await use("cloud").auth.resetPasswordForEmail(email, { redirectTo: HOME_URL });
      if(error) throw error;
      storage.set(RESET_KEY, Date.now());
      showGate("signin", { mode: "signin", note: "If there's an account for " + email + ", a reset link is on its way. Open it in this same browser to choose a new password." });
      aEl("authEmail").value = email;
    }
  }catch(e){
    setAuthError(authErrorText(e));
  }finally{
    if(!aEl("authGate").hidden) setAuthBusy(false);
  }
}
export async function resendConfirmation(){
  const email = aEl("authEmail").value.trim();
  if(!validEmail(email)){ setAuthError("Enter your email first."); aEl("authEmail").focus(); return; }
  setAuthBusy(true);
  try{
    const { error } = await use("cloud").auth.resend({ type: "signup", email, options: { emailRedirectTo: HOME_URL } });
    if(error) throw error;
    setAuthError(""); setAuthNote("Sent a new confirmation link to " + email + ".");
  }catch(e){ setAuthError(authErrorText(e)); }
  finally{ setAuthBusy(false); aEl("resendBtn").hidden = false; }
}
export async function onResetSubmit(ev){
  ev.preventDefault();
  const p1 = aEl("newPass").value, p2 = aEl("newPass2").value;
  setAuthError("");
  if(p1.length < MIN_PW){ setAuthError("Choose a password of at least " + MIN_PW + " characters."); aEl("newPass").focus(); return; }
  if(p1 !== p2){ setAuthError("The two passwords don't match."); aEl("newPass2").focus(); return; }
  setAuthBusy(true);
  try{
    const { error } = await use("cloud").auth.updateUser({ password: p1 });
    if(error) throw error;
    storage.set(RESET_KEY, ""); storage.set(RECOVERY_KEY, "");
    aEl("newPass").value = ""; aEl("newPass2").value = "";
    const { data: { session } } = await use("cloud").auth.getSession();
    if(session){ showGate("loading", { message: "Password updated. Opening your shop…" }); await onSignedIn(session); if(store.authUser) toast("Password updated."); }
    else showGate("signin", { mode: "signin", note: "Password updated. Sign in with your new password." });
  }catch(e){ setAuthError(authErrorText(e)); }
  finally{ if(!aEl("authGate").hidden) setAuthBusy(false); }
}

/* Registered once at start-up (app/main.js). */
export function installSignInEvents(){
  aEl("provBtns").addEventListener("click", e => { const b = e.target.closest("[data-provider]"); if(b) signInWith(b.dataset.provider); });
  aEl("emailForm").addEventListener("submit", onEmailSubmit);
  aEl("authForms").addEventListener("click", e => {
    const t = e.target.closest("[data-authtab],[data-switchto]"); if(!t) return;
    const email = aEl("authEmail").value;
    setEmailMode(t.dataset.authtab || t.dataset.switchto);
    aEl("authEmail").value = email;   // keep what they typed
    (email ? aEl("authPass") : aEl("authEmail")).focus();
  });
  aEl("forgotBtn").addEventListener("click", () => { const em = aEl("authEmail").value; setEmailMode("forgot"); aEl("authEmail").value = em; aEl("authEmail").focus(); });
  aEl("backBtn").addEventListener("click", () => { const em = aEl("authEmail").value; setEmailMode("signin"); aEl("authEmail").value = em; aEl("authPass").focus(); });
  aEl("resendBtn").addEventListener("click", resendConfirmation);
  aEl("resetForm").addEventListener("submit", onResetSubmit);
  aEl("resetCancel").addEventListener("click", signOut);
  // Back from a sign-in service restores this page as it was, buttons disabled: turn them back on

  window.addEventListener("pageshow", e => { if(e.persisted && !aEl("authGate").hidden) setAuthBusy(false); });
}
