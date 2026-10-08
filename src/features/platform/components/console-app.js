// The Platform Console (platform/): sign-in for Hangtag's own staff, the guard and the shell. The guard: signed in → the
// database's answer about this account's console role (hangtag_platform_whoami: by account id, never by email) → the
// sections that role may open. The shell: the top bar (role, account, sign out), the sections menu (a side bar on a desktop,
// a drawer on a phone) and the page, routed by #/section. Every page asks the database through the "platform" port, and the
// database checks the role again on every call: this guard only decides what is drawn. A signed-in account without a role
// sees its own account id (a super admin adds it by that id).
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { logger } from '../../../shared/logging/logger.js';
import { NAV, ROLE_LABELS, guard, navFor, routeOf, staffOf } from '../../../domain/platform/console.js';
import { renderDashboard } from '../pages/dashboard-page.js';
import { renderPromotions } from '../pages/promotions-page.js';
import { renderAudit } from '../pages/audit-page.js';
import { renderSettings } from '../pages/settings-page.js';
import { errorPanelHTML } from '../services/console-ui.js';

const PAGES = { dashboard: renderDashboard, promotions: renderPromotions, audit: renderAudit, settings: renderSettings };
const MENU_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const state = { surface: "", me: null, email: "", route: "", navOpen: false, busy: false };
const host = () => document.getElementById("pc");
const paint = html => { const h = host(); if(h) h.innerHTML = html; };
/* An address inside the console (the page says where the console's folder is: data-console) */
const consoleUrl = path => new URL((document.documentElement.dataset.console || "./") + path, location.href).href;

function cardHTML(title, body){ return `<main class="pc-auth"><div class="pc-auth-card"><div class="pc-logo">Hangtag <span>Console</span></div><h1>${esc(title)}</h1>${body}</div></main>`; }
function loginHTML(){
  return cardHTML("Sign in", `<p class="note">For Hangtag's own team. Shops sign in to the Hangtag app.</p>
    <form id="pcLogin" class="pc-login" novalidate>
      <label class="pc-f"><span>Email</span><input type="email" name="email" autocomplete="username" required${state.busy ? " disabled" : ""}></label>
      <label class="pc-f"><span>Password</span><input type="password" name="password" autocomplete="current-password" required${state.busy ? " disabled" : ""}></label>
      <p class="pc-msg bad" id="pcLoginErr" role="alert" hidden></p>
      <button type="submit" class="btn primary"${state.busy ? ' disabled aria-busy="true"' : ""}>Sign in</button>
    </form>
    <div class="pc-or"><span>or</span></div>
    <button type="button" class="btn" data-pc="google"${state.busy ? " disabled" : ""}>Continue with Google</button>`);
}
/* Signed in, but not on the console's staff */
function deniedHTML(){
  const id = state.me && state.me.account;
  return cardHTML("No access to the console", `<p>This account isn't on Hangtag's console team. If it should be, give a super admin this account ID:</p>
    ${id ? `<code class="pc-id" id="pcId">${esc(id)}</code><button type="button" class="btn sm" data-pc="copy-id">Copy the ID</button>` : ""}
    <button type="button" class="btn" data-pc="signout">Sign out</button>`);
}
function shellHTML(){
  const me = state.me, items = navFor(me.perms);
  return `<div class="pc-app${state.navOpen ? " nav-open" : ""}">
  <header class="pc-top">
    <button type="button" class="btn sm pc-menu" data-pc="menu" aria-controls="pcNav" aria-expanded="${state.navOpen ? "true" : "false"}" aria-label="Sections">${MENU_ICON}</button>
    <a class="pc-logo" href="#/dashboard">Hangtag <span>Console</span></a>
    <div class="pc-me"><span class="chip-s ok nodot" title="Your console role">${esc(ROLE_LABELS[me.role] || me.role)}</span><span class="pc-email">${esc(me.name || state.email)}</span>
      <button type="button" class="btn sm" data-pc="signout">Sign out</button></div>
  </header>
  <nav class="pc-nav" id="pcNav" aria-label="Console sections"><ul><li class="pc-navme"><span class="chip-s ok nodot">${esc(ROLE_LABELS[me.role] || me.role)}</span><span>${esc(me.name || state.email)}</span></li>${items.map(n => `<li><a href="#/${n.id}"${n.id === state.route ? ' aria-current="page"' : ""}>${esc(n.label)}${n.built ? "" : "<small>Later</small>"}</a></li>`).join("")}</ul></nav>
  <div class="pc-scrim" data-pc="menu"></div>
  <main class="pc-main" id="pcMain" tabindex="-1"></main>
</div>`;
}
/* A section this role can't open */
function noRouteHTML(route){
  const n = NAV.find(x => x.id === route);
  return `<div class="pc-page"><div class="pc-empty" role="alert"><p><b>Your role (${esc(ROLE_LABELS[state.me.role] || state.me.role)}) can't open ${esc(n ? n.label : "this section")}.</b></p>
    <p><a class="btn sm" href="#/dashboard">Back to the dashboard</a></p></div></div>`;
}
/* A section of a later release: said plainly, nothing made up */
function laterHTML(route){
  const n = NAV.find(x => x.id === route);
  return `<div class="pc-page"><div class="pc-head"><h1>${esc(n.label)}</h1></div>
    <div class="pc-empty"><p><b>${esc(n.label)}</b> comes in a later release of the console.</p><p class="note">It stays empty until it is built on Hangtag's own records: no sample figures.</p></div></div>`;
}

function route(){
  if(!state.me || !state.me.staff) return;
  const r = routeOf(location.hash);
  if(location.hash !== "#/" + r){ history.replaceState(null, "", location.pathname + "#/" + r); }
  state.route = r; state.navOpen = false;
  paint(shellHTML());
  const main = document.getElementById("pcMain");
  if(guard(r, state.me.perms) !== "ok"){ main.innerHTML = noRouteHTML(r); return; }
  const page = PAGES[r];
  if(!page){ main.innerHTML = laterHTML(r); main.focus({ preventScroll: true }); return; }
  Promise.resolve(page(main, { me: state.me })).catch(e => { main.innerHTML = errorPanelHTML(NAV.find(x => x.id === r).label, e); });
  main.focus({ preventScroll: true });
}

/* Who is signed in, by the database's answer: staff → the console; anyone else → no access */
async function enter({ noteSignIn }){
  const P = use("platform");
  let who;
  try{ who = noteSignIn ? await P.signedIn() : await P.whoami(); }
  catch(e){ paint(cardHTML("The console can't open", errorPanelHTML("", e, { retry: true }))); return; }
  state.me = staffOf(who);
  if(!state.me.staff){ paint(deniedHTML()); return; }
  try{ const s = await P.session(); state.email = (s && s.user && s.user.email) || ""; }catch{ state.email = ""; }
  route();
  window.addEventListener("hashchange", route);
}

async function signIn(form){
  const P = use("platform"), email = String(form.email.value || "").trim(), password = String(form.password.value || "");
  const err = msg => { const e = document.getElementById("pcLoginErr"); if(e){ e.textContent = msg; e.hidden = false; } };
  if(!email || !password){ err("Enter the email and the password."); return; }
  state.busy = true;
  form.querySelectorAll("input,button").forEach(x => { x.disabled = true; });
  try{
    await P.signInWithPassword(email, password);
    const me = staffOf(await P.signedIn());
    if(me.staff){ location.replace(consoleUrl("")); return; }
    state.me = me; state.busy = false; paint(deniedHTML());
  }catch(e){
    state.busy = false; paint(loginHTML());
    const box = document.getElementById("pcLoginErr"); if(box){ box.textContent = (e && e.message) || "Couldn't sign in. Try again."; box.hidden = false; }
    const f = document.querySelector('#pcLogin input[name="email"]'); if(f) f.value = email;
  }
}

function bindEvents(){
  document.addEventListener("submit", e => { if(e.target && e.target.id === "pcLogin"){ e.preventDefault(); signIn(e.target); } });
  document.addEventListener("click", async e => {
    const b = e.target && e.target.closest && e.target.closest("[data-pc]");
    if(!b) return;
    const act = b.dataset.pc;
    if(act === "menu"){
      state.navOpen = !state.navOpen;
      const app = document.querySelector(".pc-app"); if(app) app.classList.toggle("nav-open", state.navOpen);
      const m = document.querySelector(".pc-menu"); if(m) m.setAttribute("aria-expanded", state.navOpen ? "true" : "false");
    }else if(act === "signout"){
      await use("platform").signOut(); location.replace(consoleUrl(state.surface === "platform-login" ? "" : "login/"));
    }else if(act === "google"){
      try{ await use("platform").signInWithGoogle(consoleUrl("")); }
      catch(err){ const box = document.getElementById("pcLoginErr"); if(box){ box.textContent = err.message; box.hidden = false; } }
    }else if(act === "copy-id"){
      const id = state.me && state.me.account;
      try{ await navigator.clipboard.writeText(id); b.textContent = "Copied"; }catch{ const c = document.getElementById("pcId"); if(c) window.getSelection().selectAllChildren(c); }
    }else if(act === "retry"){ location.reload(); }
  });
  // the drawer closes on a choice and with Escape (phones)
  document.addEventListener("keydown", e => { if(e.key === "Escape" && state.navOpen){ state.navOpen = false; const app = document.querySelector(".pc-app"); if(app) app.classList.remove("nav-open"); } });
}

/* surface: "platform" (the console) | "platform-login" (its sign-in page) */
export async function startConsole(surface, { configured = true } = {}){
  state.surface = surface;
  bindEvents();
  if(!configured){ paint(cardHTML("The console isn't connected", `<p>config.js names no Hangtag database. Add it, then reload.</p>`)); return; }
  const P = use("platform");
  // back from Google sign-in: the client has the session from the address; the address is tidied, the sign-in noted
  const oauthReturn = /[?&]code=/.test(location.search);
  let session = null;
  try{ session = await P.session(); }catch(e){ logger.warn("Console session check failed:", e && e.code); }
  if(surface === "platform-login"){
    if(!session){ paint(loginHTML()); return; }
    const me = staffOf(await P.whoami().catch(() => null));
    if(me.staff){ location.replace(consoleUrl("")); return; }
    state.me = me; paint(me.account ? deniedHTML() : loginHTML()); return;
  }
  if(!session){ location.replace(consoleUrl("login/")); return; }
  if(oauthReturn) history.replaceState(null, "", location.pathname + location.hash);
  P.onAuthChange(ev => { if(ev === "SIGNED_OUT") location.replace(consoleUrl("login/")); });
  await enter({ noteSignIn: oauthReturn });
}
