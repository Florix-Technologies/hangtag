// A team member's session on this phone: joining the shop (a QR from the owner, or the staff password plus registering
// this phone), opening the shop as the member (its role and permissions, the shop's profile — never the owner's setup
// screen), and telling it plainly when the phone can't reach the shop. The database decides all of it (hangtag_shop_id()
// with the device key); a staff account's user_metadata.staff is only a hint for which way to open.
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { userMessage } from '../../../shared/errors/app-error.js';
import { ACCESS_LOST_TEXT, refreshAccess, setAccess } from '../../shop/services/access.js';
import { teamService } from '../../shop/services/team.js';
import { loadShopProfile } from '../../shop/services/profile-service.js';
import { forgetDevice, putDeviceAway, setDevice, thisDevice, useDeviceOf } from './device.js';

/* A staff account (made by the team function), or this account was a member on this phone before */
export const isStaffAccount = user => !!(user && ((user.user_metadata && user.user_metadata.staff === true)
  || (store.access && store.access.userId === user.id && store.access.role && store.access.role !== "owner")));

/* Opens the shop for a member. mayRegister: the member just signed in with its password, so this phone may be added to
   its devices when it has no key yet (the team function allows that only within 10 minutes of the sign-in).
   → { ok: true, member: true } | { ok: true, member: false } (the database says this account is an owner)
   | { ok: false, message, lost? } (lost: the phone no longer reaches the shop — its key is useless) */
export async function openAsMember(user, { mayRegister = false } = {}){
  useDeviceOf(user.id);
  let r = await refreshAccess();
  if(r.lost && mayRegister){
    try{
      const d = thisDevice();
      const reg = await teamService().registerDevice({ deviceName: d.name, platform: d.platform });
      setDevice({ key: reg.deviceKey, id: reg.deviceId }, user.id);
      r = await refreshAccess();
    }catch(e){ return { ok: false, message: userMessage(e, "This phone couldn't be added to the shop. Try again.") }; }
  }
  if(r.lost) return { ok: false, lost: true, message: mayRegister ? "This phone couldn't reach the shop. Ask the owner to check your access." : ACCESS_LOST_TEXT };
  if(!r.ok){
    // couldn't ask (offline, server busy): open with what this phone knew about the member last time
    if(store.access && store.access.userId === user.id) return { ok: true, member: true, offline: true };
    return { ok: false, message: "Connect to the internet to open the shop on this phone the first time." };
  }
  if(!r.access) return { ok: true, member: false };
  const shop = await loadShopProfile(r.access.shopId);
  setAccess({ ...store.access, shopName: (shop && shop.shop_name) || store.access.shopName || "" });
  return { ok: true, member: true };
}

/* The phone opened the owner's QR (<app>#enroll=<token>): redeem the single-use code for a device key, then sign in as the
   member with the one-time sign-in the team function made. → { ok: true, session, joined } | { ok: false, message } */
export async function enrollThisPhone(token){
  if(typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, message: "You're offline. Connect to the internet, then scan the QR code again." };
  const d = thisDevice();
  let j;
  try{ j = await teamService().enrollRedeem({ token, deviceName: d.name, platform: d.platform }); }
  catch(e){ return { ok: false, message: userMessage(e, "This QR code couldn't be used. Ask the owner for a new one.") }; }
  putDeviceAway();   // another member's key on this phone is kept aside for that member
  setDevice({ key: j.deviceKey, id: j.deviceId }, "");
  const auth = use("cloud").auth;
  let res = null;
  try{
    res = await auth.verifyOtp({ type: "magiclink", token_hash: j.tokenHash });
    if(res.error || !(res.data && res.data.session)) res = await auth.verifyOtp({ type: "email", token_hash: j.tokenHash });
  }catch(e){ res = { error: e }; }
  const session = res && !res.error && res.data && res.data.session;
  if(!session){ forgetDevice(""); return { ok: false, message: "This phone couldn't sign in with that QR code. Ask the owner for a new one." }; }
  setDevice({ key: j.deviceKey, id: j.deviceId }, session.user.id);
  return { ok: true, session, joined: j };
}
