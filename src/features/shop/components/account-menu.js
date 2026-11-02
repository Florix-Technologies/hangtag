// Account button, menu, welcome line.
import { store } from '../../../shared/state/store.js';
import { aEl } from '../../../shared/components/gate.js';
import { PROVIDER_NAMES } from '../../auth/config.js';
import { ICON } from '../../../shared/constants/icons.js';
import { esc } from '../../../shared/dom.js';
import { storage } from '../../../shared/state/persistence.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { initials } from '../../../shared/utils/text.js';
import { can, isMember, signedInAs } from '../services/access.js';
import { tabOpen } from './access-ui.js';
import { roleLabel } from '../../../domain/shop/permissions.js';

/* ---------- Account button, menu, welcome line, settings ---------- */

/* A team member's own name (store.profile is its shop's profile, whose full_name is the owner's) */
export function displayName(){ if(isMember() && (store.access.name || store.access.username)) return store.access.name || store.access.username;
  return (store.profile && store.profile.full_name) || (store.authUser && store.authUser.user_metadata && (store.authUser.user_metadata.full_name || store.authUser.user_metadata.name)) || (store.authUser && store.authUser.email) || storage.get("hangtag_auth_email", "") || ""; }
export const firstName = () => String(displayName()).split(/[\s@]/)[0];
export function avatarHTML(){
  const url = !isMember() && (store.profile && store.profile.avatar_url) || (store.authUser && store.authUser.user_metadata && (store.authUser.user_metadata.avatar_url || store.authUser.user_metadata.picture));
  if(url && /^https:\/\//.test(url)) return '<img src="' + esc(url) + '" alt="" referrerpolicy="no-referrer">';
  return esc(initials(displayName()));
}
export function renderAccount(){
  const email = (store.authUser && store.authUser.email) || storage.get("hangtag_auth_email", "");
  const b = aEl("acctBtn");
  b.hidden = !email;
  if(!email){ closeAcctMenu(); return; }
  aEl("acctAvatar").innerHTML = avatarHTML();
  aEl("acctName").textContent = firstName();
  b.title = isMember() ? "Signed in as " + signedInAs() : "Signed in as " + displayName() + (displayName() !== email ? " (" + email + ")" : "");
  b.setAttribute("aria-label", "Account: " + displayName());
  document.title = (store.profile && store.profile.shop_name ? store.profile.shop_name + " · " : "") + "Hangtag";
  const sn = aEl("shopName"); if(sn) sn.textContent = (isMember() && store.access.shopName) || (store.profile && store.profile.shop_name) || "";
  renderWelcome();
}
export function renderWelcome(){
  const w = aEl("welcome");
  const name = firstName();
  if(!name || !(store.authUser || storage.get("hangtag_auth_email", "")) || storage.get("hangtag_welcome_hidden", "") === dayKey(Date.now())){ w.hidden = true; return; }
  const hr = new Date().getHours();
  const hello = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  const shop = store.profile && store.profile.shop_name ? store.profile.shop_name + (store.profile.city ? " · " + store.profile.city : "") : "";
  w.innerHTML = '<span class="avatar">' + avatarHTML() + '</span><div><b></b><div class="ws"></div></div><button class="iconbtn wx" type="button" data-welcome-close aria-label="Hide welcome message">' + ICON.x + "</button>";
  w.querySelector("b").textContent = hello + ", " + name;
  w.querySelector(".ws").textContent = shop || "Welcome to your shop.";
  w.hidden = false;
}
/* A team member who takes money but can't open Reports (where the cash book is) keeps the cash drawer here: opening float,
   cash in and out, expenses and closing the day (the owner's menu is unchanged) */
const cashDrawerHTML = () => isMember() && can("create_sale") && !tabOpen("report")
  ? '<hr><span class="am-sub">Cash drawer</span>' + [["opening", "Opening float"], ["in", "Cash in"], ["out", "Cash out"], ["expense", "Expense"], ["close", "Close the day"]]
    .map(([k, l]) => '<button type="button" role="menuitem" data-am="cash:' + k + '">' + l + '</button>').join("") + "<hr>"
  : "";
export function openAcctMenu(){
  const m = aEl("acctMenu"), email = (store.authUser && store.authUser.email) || storage.get("hangtag_auth_email", "");
  m.innerHTML = '<div class="am-head"><span class="avatar lg">' + avatarHTML() + '</span><div><b></b><span class="ame"></span><span class="ams"></span></div></div>' +
    cashDrawerHTML() +
    (isMember() ? "" : '<button type="button" role="menuitem" data-am="plans">Plans &amp; Billing</button>') +
    '<button type="button" role="menuitem" data-am="settings">Settings</button>' +
    '<button type="button" role="menuitem" data-am="backup">Download backup</button>' +
    '<hr><button type="button" role="menuitem" data-am="signout" class="danger">Sign out</button>';
  m.querySelector("b").textContent = displayName();
  // a team member: "Cashier · @ravi" and "Signed in as Ravi (Cashier) at Aura Threads" (a staff address means nothing to them)
  m.querySelector(".ame").textContent = isMember() ? roleLabel(store.access.role) + (store.access.username ? " · @" + store.access.username : "") : email;
  if(isMember()){ m.querySelector('[data-am="settings"]').textContent = "Settings"; m.querySelector(".ams").textContent = "Signed in as " + signedInAs(); }
  else m.querySelector(".ams").textContent = store.profile && store.profile.shop_name ? store.profile.shop_name : "";
  m.hidden = false;
  aEl("acctBtn").setAttribute("aria-expanded", "true");
  m.querySelector("button").focus();
}
export function closeAcctMenu(){ const m = aEl("acctMenu"); if(m){ m.hidden = true; } const b = aEl("acctBtn"); if(b) b.setAttribute("aria-expanded", "false"); }
export function methodNames(){
  const ids = (store.authUser && store.authUser.identities) || [];
  const list = [...new Set(ids.map(i => i.provider))];
  if(!list.length && store.authUser && store.authUser.app_metadata && store.authUser.app_metadata.providers) list.push(...store.authUser.app_metadata.providers);
  return list.map(p => PROVIDER_NAMES[p] || p).join(", ") || "—";
}
