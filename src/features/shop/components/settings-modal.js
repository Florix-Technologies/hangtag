// Settings, in sections (services/settings-sections.js): Business (the shop profile with its type of business, stock alert,
// expense categories), Capabilities, Receipt, Taxes, Team & devices and Roles & permissions (the owner's), Hardware (this
// device's printer, and parts other features add, e.g. the weighing scale), Account. A bar at the top jumps to a section.
// A team member sees who it is and the sections its role may use; the shop profile and the team stay the owner's.
import { store } from '../../../shared/state/store.js';
import { avatarHTML, closeAcctMenu, methodNames, renderAccount } from './account-menu.js';
import { paymentsFormHTML, printerSetupHTML, receiptFormHTML, receiptSetupHTML, refreshPaymentsForm, stockCashHTML, taxFormsHTML } from './billing-settings.js';
import { capabilitiesHTML, onCapsSubmit, syncCapDeps, useRecommendedCaps } from './capability-settings.js';
import { can, isMember, signedInAs } from '../services/access.js';
import { settingsPartsHTML, settingsSections } from '../services/settings-sections.js';
import { roleLabel } from '../../../domain/shop/permissions.js';
import { shopCode } from '../../../domain/shop/staff.js';
import { shopTypeLabel } from '../services/shop-caps.js';
import { profileFieldsHTML, readProfileForm } from './profile-form.js';
import { saveShopProfile } from '../use-cases/save-shop-profile.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { storage } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';

/* ---------- the sections ---------- */
const SUB = {
  business: "Your shop's details on every bill, and the kind of shop it is.",
  capabilities: "",
  receipt: "What prints on bills, and how customers pay and get their receipts.",
  taxes: "",
  team: "People who sell in your shop, each with their own sign-in and role, and the phones they use.",
  roles: "What each role may do. The same for every type of business.",
  hardware: "Devices connected to this phone or computer.",
  account: "",
};
function sectionBody(key){
  const member = isMember();
  switch(key){
    case "business":
      // the shop's details and its type are the owner's; a member with manage_settings sees the type, and the stock alert
      return (member ? `<dl class="kv"><dt>Type of business</dt><dd>${esc(shopTypeLabel())}</dd></dl>` : '<form id="profileForm" class="authform" novalidate>' + profileFieldsHTML(store.profile || {}, "ps") +
        '<p id="profileErr" class="autherr" role="alert" hidden></p><div class="setactions"><button class="btn primary" type="submit" id="profileSave">Save changes</button></div></form>') + stockCashHTML();
    case "capabilities": return capabilitiesHTML() + settingsPartsHTML("capabilities");
    case "receipt": return receiptFormHTML() + receiptSetupHTML() + paymentsFormHTML();
    case "taxes": return taxFormsHTML();
    case "team": return teamEntryHTML();
    case "roles": return '<div class="setactions" style="margin-top:0"><button class="btn sm" type="button" data-team="roles">Open roles &amp; permissions</button></div>';
    case "hardware": return printerSetupHTML() + '<div class="hwspot" data-hwspot>' + settingsPartsHTML("hardware") + "</div>";
    case "account": return member ? memberAccountHTML() : ownerAccountHTML();
  }
  return "";
}
/* Team & devices (F1's screens open from here: features/shop/components/team-settings.js) */
const teamEntryHTML = () => store.authUser ? `<div id="teamSec"><p class="note" style="margin:0">Their phones join with a QR code you show here. Shop code for staff: <b>${esc(shopCode(store.authUser.id))}</b></p>
  <div class="setactions"><button class="btn sm primary" type="button" data-team="open">Team &amp; devices</button></div></div>` : '<p class="note" style="margin:0">Sign in to manage your team.</p>';
const ownerAccountHTML = () => '<dl class="kv"><dt>Email</dt><dd id="kvEmail"></dd><dt>Signs in with</dt><dd id="kvMethod"></dd><dt>Member since</dt><dd id="kvSince"></dd><dt>Account ID</dt><dd id="kvId"></dd></dl>' +
  '<h5 class="subh">Your data</h5><p class="note" style="margin:0">Your products, stock and bills are private to this account. Download a copy any time.</p>' +
  '<div class="setactions"><button class="btn sm" type="button" data-settings-act="backup">Download backup</button><button class="btn sm" type="button" data-settings-act="export">Export sales (CSV)</button></div>' +
  '<div class="setactions"><button class="btn sm danger" type="button" data-settings-act="signout">Sign out</button></div>';
const memberAccountHTML = () => '<dl class="kv"><dt>Name</dt><dd id="kvName"></dd><dt>Username</dt><dd id="kvUser"></dd><dt>Role</dt><dd id="kvRole"></dd>' +
  '<dt>Shop</dt><dd id="kvShop"></dd><dt>Shop code</dt><dd id="kvCode"></dd><dt>This phone</dt><dd id="kvDevice"></dd></dl>' +
  '<p class="note" style="margin:10px 0 0">The owner manages your role and your phones. Signing out keeps this phone ready for your next sign-in.</p>' +
  '<div class="setactions"><button class="btn sm" type="button" data-settings-act="backup">Download backup</button><button class="btn sm danger" type="button" data-settings-act="signout">Sign out</button></div>';

/* The whole sheet: head, the section bar, the sections this person sees */
function settingsSheetHTML(title){
  const list = settingsSections(), member = isMember();
  const secs = list.map((s, i) => `<div class="setsec" id="set-${s.key}" data-setsec="${s.key}"${i === 0 ? ' style="border-top:0;margin-top:8px"' : ""}><h4 class="secT">${esc(member && s.key === "account" ? "You" : s.label)}</h4>` +
    (SUB[s.key] ? `<p class="note secsub">${esc(SUB[s.key])}</p>` : "") + sectionBody(s.key) + "</div>").join("");
  return '<div class="scrim" data-settings-scrim><div class="sheet settings" role="dialog" aria-modal="true" aria-labelledby="setTitle">' +
    '<div class="sh-head"><span class="avatar lg">' + avatarHTML() + '</span><div style="flex:1;min-width:0"><h3 id="setTitle" style="margin:0">' + esc(title) + '</h3><p class="note" style="margin:2px 0 0" id="setSub"></p></div>' +
    '<button class="iconbtn" type="button" data-settings-close aria-label="Close">' + ICON.x + "</button></div>" +
    (list.length > 2 ? `<nav class="setnav" aria-label="Settings sections">${list.map(s => `<button type="button" class="chipbtn" data-setgo="${s.key}">${esc(member && s.key === "account" ? "You" : s.label)}</button>`).join("")}</nav>` : "") +
    secs + "</div></div>";
}
export function openSettings(){
  closeAcctMenu();
  if(isMember()){ openMemberSettings(); return; }
  const p = store.profile || {}, email = (store.authUser && store.authUser.email) || storage.get("hangtag_auth_email", "");
  const since = (store.authUser && store.authUser.created_at) || p.created_at;
  $("#modalHost").innerHTML = settingsSheetHTML("Profile & shop settings");
  $("#setSub").textContent = email;
  $("#kvEmail").textContent = email || "—";
  $("#kvMethod").textContent = methodNames();
  $("#kvSince").textContent = since ? new Date(since).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "—";
  $("#kvId").textContent = store.authUser ? store.authUser.id.slice(0, 8) : "—";
  if(!store.authUser || !navigator.onLine){ const e = $("#profileErr"); e.textContent = "You're offline. Changes can be saved once you're back online."; e.hidden = false; }
  $("#ps_shop_name").focus({ preventScroll: true });
  refreshPaymentsForm();   // which channels and payments the server can take, once known
}
/* A team member's settings: who is signed in, in which shop, from which phone; the shop's settings only with manage_settings
   (the shop profile belongs to the owner); this device's printer; backup; sign out */
export function openMemberSettings(){
  const a = store.access || {};
  $("#modalHost").innerHTML = settingsSheetHTML("Settings");
  $("#setSub").textContent = "Signed in as " + signedInAs();
  $("#kvName").textContent = a.name || "—";
  $("#kvUser").textContent = a.username ? "@" + a.username : "—";
  $("#kvRole").textContent = roleLabel(a.role) || "—";
  $("#kvShop").textContent = a.shopName || (store.profile && store.profile.shop_name) || "—";
  $("#kvCode").textContent = a.shopId ? shopCode(a.shopId) : "—";
  $("#kvDevice").textContent = a.deviceId || "—";
  if(can("manage_settings")) refreshPaymentsForm();
}
export function closeSettings(){ $("#modalHost").innerHTML = ""; }
/* Jump to a section of the open settings */
export function goSettingsSection(key){ const s = $("#set-" + key); if(s) s.scrollIntoView({ block: "start", behavior: "smooth" }); }
export async function onProfileSubmit(form){
  const err = $("#profileErr"), btn = $("#profileSave");
  const r = readProfileForm(form);
  if(r.error){ err.textContent = r.error; err.hidden = false; return; }
  if(!store.authUser || !store.sbClient){ err.textContent = "You're offline. Changes can be saved once you're back online."; err.hidden = false; return; }
  btn.disabled = true; err.hidden = true;
  try{
    await saveShopProfile(r.values);
    renderAccount();
    closeSettings();
    renderAll();   // a new type of business can change what the shop uses (tabs, fields)
    toast("Profile saved.");
  }catch(e){ err.textContent = e.message || "Couldn't save. Try again."; err.hidden = false; }
  finally{ btn.disabled = false; }
}

/* Registered once at start-up (app/main.js): the section bar and the capability switches */
export function installSettingsEvents(){
  document.addEventListener("click", e => {
    const t = e.target; if(!t || !t.closest) return;
    const go = t.closest("[data-setgo]"); if(go){ goSettingsSection(go.dataset.setgo); return; }
    if(t.closest("[data-capsrec]")){ useRecommendedCaps(); return; }
  });
  document.addEventListener("change", e => { const f = e.target && e.target.closest && e.target.closest("#capsForm"); if(f && e.target.matches("[data-cap]")) syncCapDeps(f); });
  document.addEventListener("submit", e => { if(e.target && e.target.id === "capsForm"){ e.preventDefault(); onCapsSubmit(e.target); } });
}
