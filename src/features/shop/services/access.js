// Who is using the till and what they may do. The owner (every account that isn't a team member) may do everything, exactly
// as before. A team member may do what its role allows in its shop: the shop's own list for the role (hangtag_roles), else
// the defaults (domain/shop/permissions.js). The database enforces all of it (supabase/schema.sql sections 3i and 5): hiding
// what a role can't do only saves the person a refusal.
//   store.access: null for the owner; for a member { userId, shopId, role, name, username, shopName, deviceId, perms,
//   overrides, at } — kept per account on this device (hangtag_access), so the till knows the role offline, and asked
//   again each time the app connects (and every 30 s while connected: a member's phone gets no live updates).
import { store } from '../../../shared/state/store.js';
import { PERMISSIONS, missingFor, permissionsFor, roleCan, roleLabel } from '../../../domain/shop/permissions.js';
import { saveAccess } from '../../../shared/state/persistence.js';
import { toast } from '../../../shared/components/toast.js';
import { teamService } from './team.js';

export const isMember = () => !!(store.access && store.access.role && store.access.role !== "owner");
export const currentRole = () => isMember() ? store.access.role : "owner";
/* The permissions of whoever is signed in (the owner: all of them) */
export const currentPerms = () => isMember() ? (store.access.perms || []).slice() : [...PERMISSIONS];
/* May the person signed in do p? (the owner: always) */
export const can = p => !isMember() || roleCan(store.access.role, store.access.perms || [], p);
export const canAny = list => (list || []).some(can);
/* What the person signed in may not do (nothing for the owner) */
export const missingPerms = () => isMember() ? missingFor(store.access.perms) : [];
/* "Ravi (Cashier) at Aura Threads" for a member; "" for the owner */
export function signedInAs(){
  if(!isMember()) return "";
  const a = store.access, shop = a.shopName || (store.profile && store.profile.shop_name) || "";
  return (a.name || a.username || "Team member") + " (" + roleLabel(a.role) + ")" + (shop ? " at " + shop : "");
}
/* What a member is told when its role can't do something */
export const notAllowedText = what => `Your role (${roleLabel(currentRole())}) can't ${what}. Ask the owner.`;
/* Stop here when the person signed in may not do p (says why) → true when refused. For components: a use case returns
   denied(...) instead, before it changes anything. */
export function refuse(p, what){
  if(can(p)) return false;
  toast(notAllowedText(what));
  return true;
}
/* For use cases: { error } when the person signed in may do none of the permissions (a name or a list), else null */
export const denied = (p, what) => (Array.isArray(p) ? canAny(p) : can(p)) ? null : { error: notAllowedText(what) };
/* Shown on the sign-in screen when a member's phone no longer reaches the shop */
export const ACCESS_LOST_TEXT = "Device revoked: this phone was signed out of the shop by the owner (or your access was switched off). Ask the owner for a new QR code, or sign in with your staff password.";

export function setAccess(a){ store.access = a; saveAccess(); }
export function clearAccess(){ if(store.access){ store.access = null; saveAccess(); } }

/* Asks the database again (as the signed-in account, with this phone's device key): the phone's standing in its shop, the
   member's own row and the shop's permission lists per role. Keeps "last seen" of the phone (RPC hangtag_touch_device).
   → { ok: true, access } (access null: an owner) | { ok: false, lost: true } (this phone no longer reaches the shop: revoked,
   member switched off, or no key) | { ok: false, error } (couldn't ask: offline, server busy) */
export async function refreshAccess(){
  const user = store.authUser;
  if(!user) return { ok: false, error: new Error("Not signed in") };
  const team = teamService();
  let t;
  try{ t = await team.touch(); }catch(e){ return { ok: false, error: e }; }
  if(!t.shopId) return { ok: false, lost: true };
  if(t.shopId === user.id){ clearAccess(); return { ok: true, access: null }; }
  let me = null, overrides = {};
  try{
    me = (await team.members()).find(m => m.userId === user.id) || null;
    (await team.roles()).forEach(r => { overrides[r.role] = r.permissions; });
  }catch(e){ return { ok: false, error: e }; }
  const was = store.access && store.access.userId === user.id ? store.access : {};
  const role = t.role || (me && me.role) || was.role || "";
  const meta = user.user_metadata || {};
  setAccess({ userId: user.id, shopId: t.shopId, role, name: (me && me.name) || meta.full_name || was.name || "", username: (me && me.username) || was.username || "",
    shopName: was.shopName || "", deviceId: t.deviceId || was.deviceId || null, perms: permissionsFor(role, overrides), overrides, at: Date.now() });
  return { ok: true, access: store.access };
}
