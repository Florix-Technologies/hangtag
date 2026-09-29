// This phone as a team member's device: its key (sent with every request as x-hangtag-device: see
// infrastructure/supabase/client.js; the database keeps only its hash), the device's id, and the member it belongs to.
// Only a member's phone has one. The key belongs to that member alone: when the member signs out it is put away for that
// member (signing in again on this phone needs no new QR, and adds no device), and no other account ever sends it. A key
// the owner revoked is forgotten.
import { DEVICE_ID, DEVICE_KEY, DEVICE_USER } from '../config.js';
import { storage } from '../../../shared/state/persistence.js';

const KEYS = [DEVICE_KEY, DEVICE_ID];
const awayKey = (userId, k) => "hangtag_dev_" + userId + "_" + k;
const quiet = f => { try{ f(); }catch{ /* storage blocked: nothing to put away */ } };

export const deviceUser = () => String(storage.get(DEVICE_USER, "") || "");
export const deviceKeyNow = () => { const k = storage.get(DEVICE_KEY, ""); return typeof k === "string" ? k : ""; };
export const deviceIdNow = () => String(storage.get(DEVICE_ID, "") || "");
/* A new key for this phone (enrolled or registered); userId: the member ("" until the sign-in finishes) */
export function setDevice({ key, id }, userId){
  if(userId && deviceUser() && deviceUser() !== userId) putDeviceAway();   // another member's key is kept aside, never overwritten
  storage.set(DEVICE_KEY, String(key || "")); storage.set(DEVICE_ID, String(id || "")); storage.set(DEVICE_USER, String(userId || ""));
}
/* Sign-out: the active key is kept aside for its member, and no longer sent */
export function putDeviceAway(){
  const uid = deviceUser();
  if(uid && deviceKeyNow()) KEYS.forEach(k => quiet(() => { const v = storage.getRaw(k); if(v != null) storage.setRaw(awayKey(uid, k), v); }));
  [...KEYS, DEVICE_USER].forEach(k => quiet(() => storage.remove(k)));
}
/* The owner revoked this phone (or the member was switched off): its key is useless, forget it (and any kept aside) */
export function forgetDevice(userId){
  const uid = userId || deviceUser();
  [...KEYS, DEVICE_USER].forEach(k => quiet(() => storage.remove(k)));
  if(uid) KEYS.forEach(k => quiet(() => storage.remove(awayKey(uid, k))));
}
/* An account signs in on this phone: make its own key the active one (another member's is put away first).
   → true when this account has a key here */
export function useDeviceOf(userId){
  const cur = deviceUser();
  if(cur && cur !== userId) putDeviceAway();
  if(deviceKeyNow()){
    if(!deviceUser()) storage.set(DEVICE_USER, userId);   // a key just enrolled, before the sign-in finished
    return true;
  }
  let back = false;
  KEYS.forEach(k => quiet(() => { const v = storage.getRaw(awayKey(userId, k)); if(v != null){ storage.setRaw(k, v); storage.remove(awayKey(userId, k)); back = true; } }));
  if(back) storage.set(DEVICE_USER, userId);
  return back && !!deviceKeyNow();
}
/* A name for this phone in the owner's device list, and its platform */
export function thisDevice(){
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
    : /Windows/.test(ua) ? "Windows PC" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux PC" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return { name: br ? os + " (" + br + ")" : os, platform: os };
}
