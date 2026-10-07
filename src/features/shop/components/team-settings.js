// Settings → Team & devices and Roles & permissions (the owner's screens). The team lives in the cloud: members are added,
// changed and removed through the team Edge Function, which also makes the single-use sign-in codes for the QR (10
// minutes; the QR carries only that code — never a password or a key). Role permissions are the shop's own lists
// (hangtag_roles). Everything needs a connection; the database refuses anyone but the owner.
//   store.team = { view: "members"|"roles", loading, err, members, devices, overrides, adding, how, addErr, busy,
//                  confirm (the action waiting for a second tap), qr: { userId, name, url, expiresAt }, draft: { role: [perms] } }
import { store } from '../../../shared/state/store.js';
import { EDITABLE_PERMISSIONS, MEMBER_ROLES, PERMISSION_LABELS, ROLE_DEFAULTS, permissionsFor, roleLabel } from '../../../domain/shop/permissions.js';
import { roleSuggestionsFor } from '../../../domain/shop/capabilities.js';
import { checkNewMember, cleanMemberName, cleanUsername, newPasswordError, shopCode } from '../../../domain/shop/staff.js';
import { isMember } from '../services/access.js';
import { teamService } from '../services/team.js';
import { rememberTeam } from '../services/team-roster.js';
import { OWNER_ONLY_TEXT, addMember, changeMember, phoneSignInCode, removeMember, removePhone, resetMemberAccess, revokePhone, saveRolePermissions } from '../use-cases/manage-team.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { use } from '../../../shared/di/services.js';
import { userMessage } from '../../../shared/errors/app-error.js';
import { agoText } from '../../../shared/formatting/dates.js';
import { HOME_URL } from '../../../shared/config/app-config.js';
import { initials } from '../../../shared/utils/text.js';

/* The owner's section in Settings → Business */
export function teamSectionHTML(){
  if(isMember() || !store.authUser) return "";
  return `<div class="setsec" id="teamSec"><h4>Team &amp; devices</h4><p class="note" style="margin:0">People who sell in your shop, each with their own sign-in and role. Their phones join with a QR code you show here. Shop code for staff: <b>${esc(shopCode(store.authUser.id))}</b></p>
    <div class="setactions"><button class="btn sm primary" type="button" data-team="open">Team &amp; devices</button><button class="btn sm" type="button" data-team="roles">Roles &amp; permissions</button></div></div>`;
}

/* ---------- open, load, draw ---------- */
export function openTeam(view){
  if(isMember()){ toast(OWNER_ONLY_TEXT); return; }
  store.team = { view: view === "roles" ? "roles" : "members", loading: true, err: "", members: [], devices: [], overrides: {}, adding: false, how: "qr", addErr: "", busy: "", confirm: "", qr: null, draft: null };
  renderTeam(true);
  loadTeam();
}
export async function loadTeam(){
  const T = store.team; if(!T) return;
  if(!store.authUser || !store.sbClient || !navigator.onLine){ T.loading = false; T.err = "Connect to the internet to manage the team."; renderTeam(); return; }
  T.loading = true; T.err = ""; renderTeam();
  try{
    const team = teamService();
    const [members, devices, roles] = await Promise.all([team.members(), team.devices(), team.roles()]);
    if(store.team !== T) return;
    T.members = members.filter(m => m.userId !== store.authUser.id); T.devices = devices;
    rememberTeam(T.members);   // Home's "who sold what" knows the names too
    T.overrides = {}; roles.forEach(r => { T.overrides[r.role] = r.permissions; });
    T.draft = null;
  }catch(e){ if(store.team === T) T.err = userMessage(e, "The team couldn't be loaded. Try again."); }
  if(store.team !== T) return;
  T.loading = false; renderTeam();
}
export function closeTeam(){ store.team = null; stopCountdown(); $("#modalHost").innerHTML = ""; }

const lastSeen = t => t ? "last seen " + agoText(Date.parse(t)) : "not seen yet";
function memberHTML(m, T){
  const devs = T.devices.filter(d => d.userId === m.userId), off = m.status !== "active", busy = T.busy === m.userId, c = T.confirm;
  const roles = [...new Set([...roleSuggestionsFor(store.profile && store.profile.business_type), m.role])].filter(r => MEMBER_ROLES.includes(r));
  const two = (key, label, cls) => `<button class="btn xs${cls ? " " + cls : ""}" type="button" data-team="${esc(key)}"${busy ? " disabled" : ""}>${c === key ? "Tap again to " + label.toLowerCase() : label}</button>`;
  return `<div class="tm${off ? " off" : ""}" data-member="${esc(m.userId)}"><div class="tm-h"><span class="avatar">${esc(initials(m.name || m.username))}</span>
      <div class="tm-w"><b>${esc(m.name)}</b><span class="sub">@${esc(m.username)} · ${esc(roleLabel(m.role))} · ${off ? `<span class="btag warn">Disabled</span>` : `<span class="btag ok">Active</span>`} · ${esc(lastSeen(m.lastSeenAt))}</span></div>
      <label class="tm-role"><span class="sr">Role of ${esc(m.name)}</span><select class="sel" data-teamrole="${esc(m.userId)}"${busy ? " disabled" : ""}>${roles.map(r => `<option value="${esc(r)}"${r === m.role ? " selected" : ""}>${esc(roleLabel(r))}</option>`).join("")}</select></label></div>
    <div class="setactions tm-a">${off ? "" : `<button class="btn xs primary" type="button" data-team="qr:${esc(m.userId)}"${busy ? " disabled" : ""}>Sign in a phone (QR)</button>`}
      ${off ? `<button class="btn xs" type="button" data-team="enable:${esc(m.userId)}"${busy ? " disabled" : ""}>Enable</button>` : two("disable:" + m.userId, "Disable")}
      ${two("reset:" + m.userId, "Reset access")}${two("remove:" + m.userId, "Remove", "danger")}</div>
    <div class="tm-dev">${devs.length ? devs.map(d => `<div class="tm-d${d.status !== "active" ? " off" : ""}" data-device="${esc(d.id)}"><span><b>${esc(d.name)}</b><small>${d.status === "active" ? "Active" : "Revoked"} · ${esc(lastSeen(d.lastSeenAt))}</small></span>
        ${d.status === "active" ? two("revoke:" + d.id, "Revoke") : ""}${two("rmdev:" + d.id, "Remove")}</div>`).join("") : `<p class="note" style="margin:0">No phone signed in yet.</p>`}</div></div>`;
}
function qrHTML(T){
  const q = T.qr; if(!q) return "";
  let svg = ""; try{ svg = use("qrCodeService").render(q.url, { unit: "px", size: 220, margin: 2 }); }catch{ svg = ""; }
  return `<div class="card enrollqr" data-enroll-url="${esc(q.url)}"><h4>Sign in ${esc(q.name)}'s phone</h4><div class="qrbox">${svg}</div>
    <p class="note">On ${esc(q.name)}'s phone, open the camera and scan this code, then open the link. It works once, for <b data-countdown>10:00</b>.</p>
    <p class="note" style="margin:0">The code carries no password. ${esc(q.name)} is signed in on that phone until you revoke it here.</p>
    <div class="setactions"><button class="btn sm" type="button" data-team="qr:${esc(q.userId)}">New code</button><button class="btn sm primary" type="button" data-team="qrdone">Done</button></div></div>`;
}
function addFormHTML(T){
  if(!T.adding) return `<div class="setactions"><button class="btn sm primary" type="button" data-team="add">+ Add team member</button></div>`;
  const roles = roleSuggestionsFor(store.profile && store.profile.business_type);
  return `<form id="teamAddForm" class="authform tm-add" novalidate><h4 class="subh">Add team member</h4><div class="pgrid">
      <label class="f"><span class="lab">Name</span><input name="name" maxlength="80" autocomplete="off"></label>
      <label class="f"><span class="lab">Username</span><input name="username" maxlength="30" autocomplete="off" autocapitalize="off" spellcheck="false"><span class="fhint">3 to 30 lower-case letters, digits, . _ -</span></label>
      <label class="f"><span class="lab">Role</span><select name="role">${roles.map(r => `<option value="${esc(r)}"${r === "cashier" ? " selected" : ""}>${esc(roleLabel(r))}</option>`).join("")}</select></label>
      <div class="f"><span class="lab">How they sign in</span><label class="chk"><input type="radio" name="how" value="qr"${T.how !== "password" ? " checked" : ""}> Scan a QR code on their phone</label>
        <label class="chk"><input type="radio" name="how" value="password"${T.how === "password" ? " checked" : ""}> A password (Staff tab on the sign-in screen)</label></div>
      <label class="f full" data-pwwrap${T.how === "password" ? "" : " hidden"}><span class="lab">Password</span><input name="password" type="text" autocomplete="new-password" autocapitalize="off" spellcheck="false"><span class="fhint">8 characters or more. Give it to them in person.</span></label>
    </div><p id="teamAddErr" class="autherr" role="alert"${T.addErr ? "" : " hidden"}>${esc(T.addErr)}</p>
    <div class="setactions"><button class="btn sm primary" type="submit"${T.busy === "add" ? " disabled" : ""}>${T.busy === "add" ? "Adding…" : "Add"}</button><button class="btn sm" type="button" data-team="cancel">Cancel</button></div></form>`;
}
function rolesHTML(T){
  const roles = [...new Set([...roleSuggestionsFor(store.profile && store.profile.business_type), ...T.members.map(m => m.role)])].filter(r => MEMBER_ROLES.includes(r));
  const perms = r => (T.draft && T.draft[r]) || permissionsFor(r, T.overrides);
  return `<p class="note">What each role may do in your shop. You can always do everything. Changes reach team phones within a minute; the database checks every change they make.</p>
    <div class="tscroll"><table class="rolegrid"><thead><tr><th>Permission</th>${roles.map(r => `<th>${esc(roleLabel(r))}</th>`).join("")}</tr></thead><tbody>
    ${EDITABLE_PERMISSIONS.map(p => `<tr><td>${esc(PERMISSION_LABELS[p] || p)}</td>${roles.map(r => `<td><input type="checkbox" data-perm="${esc(r + ":" + p)}" aria-label="${esc(roleLabel(r) + ": " + (PERMISSION_LABELS[p] || p))}"${perms(r).includes(p) ? " checked" : ""}></td>`).join("")}</tr>`).join("")}
    </tbody><tfoot><tr><td></td>${roles.map(r => `<td><button class="link xs" type="button" data-team="defaults:${esc(r)}">Defaults</button></td>`).join("")}</tr></tfoot></table></div>
    <p class="note">Every team member can see the products, stock and customers. Only you manage the team and its phones.</p>
    <p id="rolesErr" class="autherr" role="alert"${T.err && !T.loading ? "" : " hidden"}>${esc(T.err)}</p>
    <div class="setactions"><button class="btn sm primary" type="button" data-team="saveroles"${T.draft && T.busy !== "roles" ? "" : " disabled"}>${T.busy === "roles" ? "Saving…" : "Save roles"}</button></div>`;
}
/* first: draw the sheet (openTeam); later calls only redraw it while it is still open (closed meanwhile: forget it) */
export function renderTeam(first){
  const T = store.team, host = $("#modalHost"); if(!T || !host) return;
  if(!first && !host.querySelector(".teamsheet")){ store.team = null; stopCountdown(); return; }
  const code = store.authUser ? shopCode(store.authUser.id) : "";
  const body = T.loading ? `<p class="muted">Loading the team…</p>`
    : T.view === "roles" ? rolesHTML(T)
    : (T.err ? `<p class="autherr" role="alert">${esc(T.err)}</p><div class="setactions"><button class="btn sm" type="button" data-team="reload">Try again</button></div>` : "")
      + qrHTML(T) + addFormHTML(T)
      + (T.members.length ? `<div class="tmlist">${T.members.map(m => memberHTML(m, T)).join("")}</div>` : T.err ? "" : `<p class="note">No team members yet. Add the people who sell in your shop: each gets their own sign-in, and you choose what they may do.</p>`);
  const a = document.activeElement, keepAdd = a && a.closest && a.closest("#teamAddForm") ? a.name : null;
  host.innerHTML = `<div class="scrim" data-team-scrim><div class="sheet settings teamsheet" role="dialog" aria-modal="true" aria-labelledby="teamTitle">
    <div class="sh-head"><button class="iconbtn" type="button" data-team="back" aria-label="Back">←</button><div style="flex:1;min-width:0"><h3 id="teamTitle" style="margin:0">${T.view === "roles" ? "Roles &amp; permissions" : "Team"}</h3>
      <p class="note" style="margin:2px 0 0">Shop code for staff: <b data-shopcode>${esc(code)}</b></p></div><button class="iconbtn" type="button" data-team="close" aria-label="Close">${ICON.x}</button></div>
    <div class="seg teamseg" role="group" aria-label="Show"><button type="button" data-team="view:members" aria-pressed="${T.view === "members"}">People &amp; phones</button><button type="button" data-team="view:roles" aria-pressed="${T.view === "roles"}">Roles &amp; permissions</button></div>
    ${body}</div></div>`;
  if(keepAdd){ const i = host.querySelector(`#teamAddForm [name="${keepAdd}"]`); if(i) i.focus(); }
  if(T.qr) startCountdown(); else stopCountdown();
}

/* ---------- the QR's countdown (10 minutes, single use) ---------- */
let tick = null;
function stopCountdown(){ if(tick){ clearInterval(tick); tick = null; } }
function startCountdown(){
  const show = () => {
    const el = document.querySelector("[data-countdown]"), q = store.team && store.team.qr;
    if(!el || !q){ stopCountdown(); return; }
    const left = Math.max(0, Math.round((q.expiresAt - Date.now()) / 1000));
    el.textContent = left ? Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") : "no longer (expired: make a new code)";
    if(!left){ const box = document.querySelector(".enrollqr .qrbox"); if(box) box.classList.add("expired"); stopCountdown(); }
  };
  show();
  if(!tick) tick = setInterval(show, 1000);
}

/* ---------- actions ---------- */
async function run(key, work, done){
  const T = store.team; if(!T) return;
  T.busy = key; T.confirm = ""; renderTeam();
  try{ const r = await work(); if(done) done(r); }
  catch(e){ toast(userMessage(e, "That couldn't be done. Try again.")); }
  finally{ if(store.team === T){ T.busy = ""; renderTeam(); } }
}
const memberName = uid => { const m = store.team && store.team.members.find(x => x.userId === uid); return m ? m.name : "this person"; };
/* A sign-in QR for a member's phone */
export function showEnrollQr(userId){
  return run(userId, () => phoneSignInCode(userId), r => {
    const T = store.team; if(!T) return;
    T.qr = { userId, name: memberName(userId), url: HOME_URL + "#enroll=" + r.token, expiresAt: r.expiresAt };
  });
}
export async function submitAddMember(form){
  const T = store.team; if(!T || T.busy) return;
  const f = new FormData(form), how = f.get("how") === "password" ? "password" : "qr";
  const input = { name: cleanMemberName(f.get("name")), username: cleanUsername(f.get("username")), role: String(f.get("role") || ""), password: how === "password" ? String(f.get("password") || "") : "" };
  T.how = how;
  const bad = checkNewMember(input) || (how === "password" && !input.password ? { error: "Choose a password, or let them sign in with a QR code." } : null);
  if(bad){ T.addErr = bad.error; const e = $("#teamAddErr"); if(e){ e.textContent = bad.error; e.hidden = false; } return; }
  T.busy = "add"; T.addErr = ""; renderTeam();
  let made = null;
  try{ made = await addMember(input); }
  catch(e){ T.busy = ""; T.addErr = userMessage(e, "The team member couldn't be added. Try again."); if(store.team === T) renderTeam(); return; }
  if(store.team !== T) return;
  T.busy = ""; T.adding = false;
  if(made.member) T.members = [...T.members.filter(m => m.userId !== made.userId), made.member];
  renderTeam();
  if(how === "qr") await showEnrollQr(made.userId);
  else toast(`${input.name} added. They sign in on the Staff tab: shop code ${made.shopCode}, username ${made.username} and the password you chose.`);
}
async function teamAction(key){
  const T = store.team; if(!T) return;
  const i = key.indexOf(":"), act = i > -1 ? key.slice(0, i) : key, arg = i > -1 ? key.slice(i + 1) : "";
  if(act === "view"){ T.view = arg === "roles" ? "roles" : "members"; T.confirm = ""; renderTeam(); return; }
  if(act === "add"){ T.adding = true; T.addErr = ""; renderTeam(); const n = $("#teamAddForm [name=name]"); if(n) n.focus(); return; }
  if(act === "cancel"){ T.adding = false; T.addErr = ""; renderTeam(); return; }
  if(act === "reload"){ loadTeam(); return; }
  if(act === "qr"){ showEnrollQr(arg); return; }
  if(act === "qrdone"){ T.qr = null; renderTeam(); loadTeam(); return; }
  if(act === "defaults"){ T.draft = Object.assign({}, T.draft || {}, { [arg]: [...(ROLE_DEFAULTS[arg] || [])] }); renderTeam(); return; }
  if(act === "saveroles"){ saveRoles(); return; }
  // changes that can't be undone with one tap: a second tap confirms
  if(["disable", "reset", "remove", "revoke", "rmdev"].includes(act) && T.confirm !== key){ T.confirm = key; renderTeam(); return; }
  const name = memberName(arg);
  if(act === "disable" || act === "enable") return run(arg, () => changeMember({ userId: arg, status: act === "disable" ? "disabled" : "active" }), () => {
    toast(act === "disable" ? `${name} is switched off. Every phone of theirs is signed out.` : `${name} can sign in again. Show a new QR code for their phone.`); loadTeam(); });
  if(act === "reset"){
    const pw = typeof prompt === "function" ? prompt(`Reset ${name}'s access: every phone of theirs is signed out and their old password stops working.\nType a new password for them (8 characters or more), or leave it empty: they then sign in only with a new QR code from you.`, "") : "";
    if(pw === null){ T.confirm = ""; renderTeam(); return; }
    const bad = newPasswordError(pw); if(bad){ toast(bad); return; }
    return run(arg, () => resetMemberAccess(arg, pw), r => { toast(`${name}'s phones are signed out (${r.revoked}).${r.passwordSet ? " The new password works now." : " Show them a new QR code to sign in again."}`); loadTeam(); });
  }
  if(act === "remove") return run(arg, () => removeMember(arg), () => { toast(`${name} was removed from the team.`); loadTeam(); });
  if(act === "revoke") return run(arg, () => revokePhone(arg), () => { toast("That phone is signed out of the shop."); loadTeam(); });
  if(act === "rmdev") return run(arg, () => removePhone(arg), () => { toast("Device removed."); loadTeam(); });
}
async function saveRoles(){
  const T = store.team; if(!T || !T.draft) return;
  const changed = Object.keys(T.draft);
  T.busy = "roles"; T.err = ""; renderTeam();
  try{
    for(const r of changed) T.overrides[r] = await saveRolePermissions(r, T.draft[r], permissionsFor(r, T.overrides));
    T.draft = null; toast("Roles saved. Team phones pick them up within a minute.");
  }catch(e){ T.err = userMessage(e, "The roles couldn't be saved. Try again."); }
  if(store.team === T){ T.busy = ""; renderTeam(); }
}
function permToggle(el){
  const T = store.team; if(!T) return;
  const [role, p] = el.dataset.perm.split(":");
  const cur = (T.draft && T.draft[role]) || permissionsFor(role, T.overrides);
  const next = el.checked ? [...new Set([...cur, p])] : cur.filter(x => x !== p);
  T.draft = Object.assign({}, T.draft || {}, { [role]: next });
  const b = document.querySelector('[data-team="saveroles"]'); if(b) b.disabled = false;
}

/* Registered once at start-up (app/main.js). */
export function installTeamEvents(){
  document.addEventListener("click", e => {
    const t = e.target; if(!t.closest) return;
    if(t.matches("[data-team-scrim]")){ closeTeam(); return; }
    const b = t.closest("[data-team]"); if(!b || b.disabled) return;
    const k = b.dataset.team;
    if(k === "open" || k === "roles"){ openTeam(k === "roles" ? "roles" : "members"); return; }
    if(k === "close"){ closeTeam(); return; }
    if(k === "back"){ if(store.team && store.team.view === "roles") openTeam("members"); else closeTeam(); return; }   // back where you came from (More → Team)
    teamAction(k);
  });
  document.addEventListener("change", e => {
    const t = e.target; if(!store.team || !t.matches) return;
    if(t.matches("[data-perm]")){ permToggle(t); return; }
    if(t.matches("#teamAddForm [name=how]")){ store.team.how = t.value; const w = document.querySelector("#teamAddForm [data-pwwrap]"); if(w) w.hidden = t.value !== "password"; return; }
    if(t.matches("[data-teamrole]")){ const uid = t.dataset.teamrole, role = t.value; run(uid, () => changeMember({ userId: uid, role }), () => { toast(`${memberName(uid)} is now ${roleLabel(role).toLowerCase()}.`); loadTeam(); }); }
  });
  document.addEventListener("submit", e => { if(e.target.id === "teamAddForm"){ e.preventDefault(); submitAddMember(e.target); } });
}
