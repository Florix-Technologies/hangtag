// Profile & shop settings dialog.
import { store } from '../../../shared/state/store.js';
import { avatarHTML, closeAcctMenu, methodNames, renderAccount } from './account-menu.js';
import { billingFormHTML, receiptSetupHTML, refreshPaymentsForm } from './billing-settings.js';
import { teamSectionHTML } from './team-settings.js';
import { scaleSetupHTML } from '../../hardware/components/scale-settings.js';
import { can, isMember, signedInAs } from '../services/access.js';
import { roleLabel } from '../../../domain/shop/permissions.js';
import { shopCode } from '../../../domain/shop/staff.js';
import { profileFieldsHTML, readProfileForm } from './profile-form.js';
import { saveShopProfile } from '../use-cases/save-shop-profile.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $ } from '../../../shared/dom.js';
import { storage } from '../../../shared/state/persistence.js';

export function openSettings(){
  closeAcctMenu();
  if(isMember()){ openMemberSettings(); return; }
  const p = store.profile || {}, email = (store.authUser && store.authUser.email) || storage.get("hangtag_auth_email", "");
  const since = (store.authUser && store.authUser.created_at) || p.created_at;
  const host = $("#modalHost");
  host.innerHTML = '<div class="scrim" data-settings-scrim><div class="sheet settings" role="dialog" aria-modal="true" aria-labelledby="setTitle">' +
    '<div class="sh-head"><span class="avatar lg">' + avatarHTML() + '</span><div style="flex:1;min-width:0"><h3 id="setTitle" style="margin:0">Profile &amp; shop settings</h3><p class="note" style="margin:2px 0 0" id="setSub"></p></div>' +
    '<button class="iconbtn" type="button" data-settings-close aria-label="Close">' + ICON.x + "</button></div>" +
    '<form id="profileForm" class="authform" novalidate>' + profileFieldsHTML(p, "ps") +
    '<p id="profileErr" class="autherr" role="alert" hidden></p><div class="setactions"><button class="btn primary" type="submit" id="profileSave">Save changes</button></div></form>' +
    billingFormHTML() + scaleSetupHTML() + teamSectionHTML() +
    '<div class="setsec"><h4>Account</h4><dl class="kv"><dt>Email</dt><dd id="kvEmail"></dd><dt>Signs in with</dt><dd id="kvMethod"></dd><dt>Member since</dt><dd id="kvSince"></dd><dt>Account ID</dt><dd id="kvId"></dd></dl></div>' +
    '<div class="setsec"><h4>Your data</h4><p class="note" style="margin:0">Your products, stock and bills are private to this account. Download a copy any time.</p>' +
    '<div class="setactions"><button class="btn sm" type="button" data-settings-act="backup">Download backup</button><button class="btn sm" type="button" data-settings-act="export">Export sales (CSV)</button></div></div>' +
    '<div class="setsec"><div class="setactions" style="margin-top:0"><button class="btn sm danger" type="button" data-settings-act="signout">Sign out</button></div></div>' +
    "</div></div>";
  $("#setSub").textContent = email;
  $("#kvEmail").textContent = email || "—";
  $("#kvMethod").textContent = methodNames();
  $("#kvSince").textContent = since ? new Date(since).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "—";
  $("#kvId").textContent = store.authUser ? store.authUser.id.slice(0, 8) : "—";
  if(!store.authUser || !navigator.onLine){ const e = $("#profileErr"); e.textContent = "You're offline. Changes can be saved once you're back online."; e.hidden = false; }
  host.querySelector("#ps_full_name").focus({ preventScroll: true });
  refreshPaymentsForm();   // which channels and payments the server can take, once known
}
/* A team member's settings: who is signed in, in which shop, from which phone; the shop's settings only with manage_settings
   (the shop profile belongs to the owner); this device's printer; backup; sign out */
export function openMemberSettings(){
  const a = store.access || {}, host = $("#modalHost");
  host.innerHTML = '<div class="scrim" data-settings-scrim><div class="sheet settings" role="dialog" aria-modal="true" aria-labelledby="setTitle">' +
    '<div class="sh-head"><span class="avatar lg">' + avatarHTML() + '</span><div style="flex:1;min-width:0"><h3 id="setTitle" style="margin:0">Settings</h3><p class="note" style="margin:2px 0 0" id="setSub"></p></div>' +
    '<button class="iconbtn" type="button" data-settings-close aria-label="Close">' + ICON.x + "</button></div>" +
    '<div class="setsec" style="border-top:0;margin-top:0;padding-top:0"><h4>You</h4><dl class="kv"><dt>Name</dt><dd id="kvName"></dd><dt>Username</dt><dd id="kvUser"></dd><dt>Role</dt><dd id="kvRole"></dd>' +
    '<dt>Shop</dt><dd id="kvShop"></dd><dt>Shop code</dt><dd id="kvCode"></dd><dt>This phone</dt><dd id="kvDevice"></dd></dl>' +
    '<p class="note" style="margin:10px 0 0">The owner manages your role and your phones. Signing out keeps this phone ready for your next sign-in.</p></div>' +
    (can("manage_settings") ? billingFormHTML() : receiptSetupHTML()) + scaleSetupHTML() +
    '<div class="setsec"><h4>Data on this phone</h4><div class="setactions" style="margin-top:0"><button class="btn sm" type="button" data-settings-act="backup">Download backup</button></div></div>' +
    '<div class="setsec"><div class="setactions" style="margin-top:0"><button class="btn sm danger" type="button" data-settings-act="signout">Sign out</button></div></div>' +
    "</div></div>";
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
    toast("Profile saved.");
  }catch(e){ err.textContent = e.message || "Couldn't save. Try again."; err.hidden = false; }
  finally{ btn.disabled = false; }
}
