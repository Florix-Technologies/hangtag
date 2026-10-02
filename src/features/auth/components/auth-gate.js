// Sign-in screen UI state: gate visibility, busy/error/note, email modes, provider buttons.
import { store } from '../../../shared/state/store.js';
import { aEl, focusCard, setAppInert } from '../../../shared/components/gate.js';
import { storage } from '../../../shared/state/persistence.js';
import { PROVIDERS, RECOVERY_KEY } from '../config.js';
import { loadAuthSettings } from '../services/auth-settings.js';
import { closeAcctMenu } from '../../shop/components/account-menu.js';

export function setAuthBusy(on){ document.querySelectorAll("#authGate button, #authGate input").forEach(b => { b.disabled = on; }); }
export function setAuthError(text){ const e = aEl("authErr"); e.textContent = text || ""; e.hidden = !text; }
export function setAuthNote(text){ const e = aEl("authNote"); e.textContent = text || ""; e.hidden = !text; }
/* While a sign-in or setup screen is up, the till behind it can't be clicked, tabbed to or read out */

export const gateUp = () => !aEl("authGate").hidden || !aEl("setupGate").hidden;
/* ---------- the email part of the sign-in screen ---------- */

export function setEmailMode(mode){
  store.emailMode = mode;
  const up = mode === "signup", forgot = mode === "forgot", staff = mode === "staff";
  // Staff: shop code, username and password (a team member's account, made by the owner); no Google, no email
  aEl("staffForm").hidden = !staff;
  aEl("emailForm").hidden = staff;
  aEl("provBtns").hidden = forgot || staff;
  aEl("orEmail").hidden = forgot || staff;
  aEl("pwWrap").hidden = forgot;
  aEl("pw2Wrap").hidden = !up;
  aEl("pwHint").hidden = !up;
  aEl("pwLabel").textContent = up ? "Choose a password" : "Password";
  aEl("authPass").setAttribute("autocomplete", up ? "new-password" : "current-password");
  aEl("emailSubmit").textContent = up ? "Create account" : forgot ? "Send reset link" : "Sign in";
  aEl("forgotBtn").hidden = mode !== "signin";
  aEl("staffPass").value = "";
  aEl("backBtn").hidden = !forgot;
  aEl("resendBtn").hidden = true;
  aEl("authMsg").textContent = up ? "Create your Hangtag account. Every account gets its own private shop."
    : forgot ? "Enter your email and we'll send you a link to choose a new password."
    : staff ? "Staff sign-in"
    : "Sign in to your shop";
  const sw = aEl("authSwitch");
  sw.hidden = forgot || staff;
  sw.innerHTML = up ? 'Already have an account? <button type="button" class="link" data-switchto="signin">Sign in</button>'
    : 'New to Hangtag? <button type="button" class="link" data-switchto="signup">Create an account</button>';
  const staffSw = aEl("staffSwitch");
  staffSw.hidden = forgot;
  staffSw.innerHTML = staff ? 'Shop owner? <button type="button" class="link" data-switchto="signin">Back to sign in</button>'
    : '<span>Staff or team member?</span> <button type="button" class="btn sm" data-switchto="staff">Staff sign-in</button>';
  labelProviders();
  aEl("authPass").value = ""; aEl("authPass2").value = "";
  setAuthError(""); setAuthNote("");
}
/* "Continue with Google" to sign in, "Sign up with Google" on the Create account tab (Google does both) */

export function labelProviders(){
  document.querySelectorAll("#provBtns [data-provider]").forEach(b => {
    const p = PROVIDERS[b.dataset.provider], sp = b.querySelector("span");
    if(p && sp) sp.textContent = (store.emailMode === "signup" ? "Sign up with " : "Continue with ") + p.label;
  });
}
export function showGate(state, opts){
  opts = opts || {};
  aEl("setupGate").hidden = true;
  const gate = aEl("authGate");
  gate.hidden = false;
  document.documentElement.classList.add("gated");
  setAppInert(true);
  closeAcctMenu();
  aEl("authForms").hidden = state !== "signin";
  aEl("resetForm").hidden = state !== "reset";
  aEl("enrollAsk").hidden = state !== "ask";
  setAuthBusy(false);
  if(state === "signin"){ setEmailMode(opts.mode || (location.hash === "#signup" ? "signup" : "signin")); renderProviders(); }
  else if(state === "reset") aEl("authMsg").textContent = "Choose a new password for " + (opts.email || "your account") + ".";
  else aEl("authMsg").textContent = opts.message || "Checking sign-in…";
  setAuthError(opts.error || "");
  setAuthNote(opts.note || "");
  if(state === "signin" && opts.showResend) aEl("resendBtn").hidden = false;
  focusCard(gate);
}
/* A team sign-in link (<app>#enroll=…) was opened where someone is signed in (who: how to name them): joining the team
   signs that account out on this browser, so ask first — a link from anyone could otherwise move this till into another
   shop without a word. → true: go on and join; false: stay signed in */
export function askToEnroll(who){
  return new Promise(resolve => {
    showGate("ask", { message: `This browser is signed in as ${who}. The link you opened signs it in to a shop as a team member instead. Continue only if that shop's owner gave you the code.` });
    const yes = aEl("enrollYes"), no = aEl("enrollNo");
    const done = ok => { yes.onclick = null; no.onclick = null; aEl("enrollAsk").hidden = true; resolve(ok); };
    yes.onclick = () => done(true); no.onclick = () => done(false);
    yes.focus();
  });
}
export function hideGate(){ aEl("authGate").hidden = true; if(aEl("setupGate").hidden){ document.documentElement.classList.remove("gated"); setAppInert(false); } }
export const inResetFlow = () => !aEl("authGate").hidden && !aEl("resetForm").hidden;
/* Add a button for every other sign-in service switched on in Supabase */

export async function renderProviders(){
  let s = null;
  try{ s = await loadAuthSettings(); }catch(e){ return; }
  const box = aEl("provBtns"), on = (s && s.external) || {};
  Object.keys(PROVIDERS).forEach(key => {
    if(key === "google" || !on[key] || box.querySelector('[data-provider="' + key + '"]')) return;
    const p = PROVIDERS[key], b = document.createElement("button");
    b.className = "btn gbtn"; b.type = "button"; b.dataset.provider = key;
    b.innerHTML = (p.icon || "") + "<span></span>";
    b.querySelector("span").textContent = "Continue with " + p.label;
    box.appendChild(b);
  });
  labelProviders();
}
/* Show the choose-a-new-password form (after a reset link) */
export function enterReset(email){ storage.set(RECOVERY_KEY, Date.now()); showGate("reset", { email }); }
