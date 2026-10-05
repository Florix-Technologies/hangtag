// The ONE place the app asks whether the shop may be used now. It keeps the server's last answer about the shop's Hangtag
// plan (store.subscription, saved per account on this device) and judges it with a trusted time (domain/billing/
// subscription.js), never the bare device clock. Every business screen sits behind it (app/navigation.js draws the lock
// screen instead), background work checks it (app/main.js), and the upload queue pauses on it (features/sync/services/
// outbox.js). The server refuses the shop's writes anyway once the plan has ended (HT402): this layer only makes the app
// say so clearly — tampering with it unlocks nothing that matters.
import { store } from '../../../shared/state/store.js';
import { storage } from '../../../shared/state/persistence.js';
import { use } from '../../../shared/di/services.js';
import { ERROR_CODES } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';
import { isLocked, stateAt, trustedNow } from '../../../domain/billing/subscription.js';
import { isMember } from '../../shop/services/access.js';

export const SUBSCRIPTION_KEY = "hangtag_subscription";   // per account (features/auth/services/account-data.js USER_KEYS)
const CHECK_EVERY = 10 * 60e3, FOCUS_GAP = 30e3, FLOOR_SAVE_GAP = 60e3;
let perfAt = null;          // performance.now() when this session last heard from the server
let lastAsk = 0, asking = null, timer = null, savedFloor = 0;
const listeners = new Set();
const perfNow = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : null);

/* The saved record: { status, serverAt (the server's time then, ms), clientAt (this device's clock then), floor (the latest
   trusted time seen) } — or null */
export function subscriptionRecord(){
  const r = store.subscription;
  return r && typeof r === "object" && r.status && typeof r.status === "object" ? r : null;
}
export const subscriptionStatus = () => { const r = subscriptionRecord(); return r ? r.status : null; };

/* The time the lock decisions use (see domain/billing/subscription.js trustedNow) */
export function subscriptionNow(){
  const r = subscriptionRecord();
  if(!r) return null;
  const t = trustedNow({ serverAt: r.serverAt, perfAt, perfNow: perfNow(), clientAt: r.clientAt, clockNow: Date.now(), floor: r.floor });
  if(t != null && t > (r.floor || 0)){
    r.floor = t;
    if(t - savedFloor > FLOOR_SAVE_GAP){ savedFloor = t; storage.set(SUBSCRIPTION_KEY, r); }   // a restart never goes back in time
  }
  return t;
}
/* Is the shop's plan over (trial ended, plan ended, suspended)? Only for a signed-in account: nothing is locked before
   sign-in, while the shop isn't set up yet, or when the server can't say (e.g. the database update isn't applied). */
export function subscriptionLocked(){
  if(!store.authUser) return false;
  const s = subscriptionStatus();
  return !!s && isLocked(s, subscriptionNow());
}
export const subscriptionState = () => { const s = subscriptionStatus(); return s ? stateAt(s, subscriptionNow()) : "none"; };
/* Only the shop's owner chooses and pays for a plan */
export const mayPay = () => !isMember() && (subscriptionStatus() ? subscriptionStatus().is_owner !== false : true);

/* Called when the lock or the plan changes (e.g. the upload queue starts again after a renewal) */
export function onSubscriptionChange(cb){ listeners.add(cb); return () => listeners.delete(cb); }
function changed(before, after){
  const sig = s => s ? [s.state, s.access_until, s.plan_code, s.suspended].join("|") : "";
  return sig(before) !== sig(after);
}
function remember(status){
  const before = subscriptionStatus(), lockedBefore = subscriptionLocked();
  const serverAt = Date.parse(status && status.server_now);
  const rec = { status, serverAt: Number.isFinite(serverAt) ? serverAt : Date.now(), clientAt: Date.now(), floor: Number.isFinite(serverAt) ? serverAt : null };
  perfAt = perfNow();
  store.subscription = rec;
  savedFloor = rec.floor || 0;
  storage.set(SUBSCRIPTION_KEY, rec);
  schedule();
  if(changed(before, status) || lockedBefore !== subscriptionLocked()) listeners.forEach(cb => { try{ cb(subscriptionLocked()); }catch(e){ logger.warn("Subscription listener failed:", e && e.code); } });
}

/* Ask the server for the shop's plan (signed in and connected only; offline, the saved answer stands). force: even if it
   was asked moments ago. Returns the status, or null when it couldn't ask. */
export function refreshSubscription({ force = false } = {}){
  if(!store.authUser || !store.sbClient || (typeof navigator !== "undefined" && navigator.onLine === false)) return Promise.resolve(null);
  if(asking) return asking;
  if(!force && Date.now() - lastAsk < 5e3) return Promise.resolve(subscriptionStatus());
  lastAsk = Date.now();
  asking = (async () => {
    try{
      const s = await use("subscriptionService").status();
      if(s && typeof s === "object" && s.state){ remember(s); return s; }
      return null;
    }catch(e){
      // the database hasn't got Plans & Billing yet (schema.sql section 3t not applied): nothing to lock, nothing to sell
      if(e && e.code === ERROR_CODES.OUTDATED_DATABASE){ remember({ state: "unavailable", server_now: new Date().toISOString() }); return subscriptionStatus(); }
      if(!(e && (e.code === ERROR_CODES.NETWORK || e.code === ERROR_CODES.AUTH))) logger.warn("Plan status check failed:", e && e.code);
      return null;
    }finally{ asking = null; }
  })();
  return asking;
}
/* The upload queue was refused because the plan ended (HT402): the server knows better than this device — ask it now */
export function noteSubscriptionRefused(){ return refreshSubscription({ force: true }); }

/* Lock exactly when the trial or plan runs out (the server is asked again then) */
function schedule(){
  if(timer){ clearTimeout(timer); timer = null; }
  const s = subscriptionStatus(), until = s && Date.parse(s.access_until), now = subscriptionNow();
  if(!Number.isFinite(until) || now == null || until <= now) return;
  timer = setTimeout(() => { timer = null; listeners.forEach(cb => { try{ cb(subscriptionLocked()); }catch{ /* reported by the listener */ } }); refreshSubscription({ force: true }); },
    Math.min(until - now + 1000, 2 ** 31 - 1));
}

let installed = false;
/* Start-up (app/main.js): the saved answer is used at once (offline too); the server is asked when the cloud connects, when
   the app comes back to the screen, every 10 minutes and the moment the plan runs out. */
export function installSubscription({ onConnected } = {}){
  if(installed) return;
  installed = true;
  schedule();
  if(typeof onConnected === "function") onConnected(() => refreshSubscription({ force: true }));
  const back = () => { if(Date.now() - lastAsk > FOCUS_GAP) refreshSubscription(); };
  if(typeof window !== "undefined"){
    window.addEventListener("focus", back);
    window.addEventListener("online", () => refreshSubscription({ force: true }));
  }
  if(typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") back(); });
  setInterval(() => refreshSubscription(), CHECK_EVERY);
}
