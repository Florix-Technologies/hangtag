// Keeps each account's local data separate on a shared device.
import { store } from '../../../shared/state/store.js';
import { DEFAULT_SETTINGS } from '../../../domain/shop/settings.js';
import { applyCatalogMigration } from '../../products/services/catalog.js';
import { closeSheets } from '../../sales/components/bill-panel.js';
import { closeModal } from '../../../shared/components/modal.js';
import { storage } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { objOr } from '../../../shared/utils/objects.js';

/* ---------- Each account keeps its own data on this device ----------
   The app works on the plain keys below. When a different account signs in, the current data is put away
   under its owner and that account's own data (or a fresh start) is brought back. */

export const USER_KEYS = ["hangtag_sb_queue", "rc_local", "rc_dirty", "rc_moves", "rc_returns", "rc_customers", "rc_settings", "rc_pend", "rc_cart", "rc_disc", "rc_cartcust", "rc_catalog", "rc_imgs", "hangtag_profile"];
export const MUST_KEEP = ["hangtag_sb_queue", "rc_local", "rc_dirty", "rc_moves", "rc_returns", "rc_customers"];   // unsent work: never drop these
export const DATA_OWNER = "hangtag_data_owner";
export const stashKey = (owner, k) => "hangtag_u_" + owner + "_" + k;
export function switchLocalDataTo(userId){
  const cur = storage.get(DATA_OWNER, "");
  if(cur === userId) return false;
  // Put the current data away. Data from before accounts existed is kept aside as "legacy", not given to anyone.
  const owner = cur || "legacy";
  USER_KEYS.forEach(k => {
    const v = storage.getRaw(k);
    try{
      if(v != null) storage.setRaw(stashKey(owner, k), v);
      else if(cur) storage.remove(stashKey(owner, k));
    }catch(e){
      // Storage full. Products and photos can be pulled from the cloud again; unsent work can't.
      if(MUST_KEEP.includes(k)) throw new Error("This device's storage is full, so the other account's unsent bills can't be put away safely. Sign in as that account and let it sync first.");
    }
  });
  // Bring back this account's own data, or start empty
  USER_KEYS.forEach(k => {
    const v = storage.getRaw(stashKey(userId, k));
    if(v != null) storage.setRaw(k, v); else storage.remove(k);
    storage.remove(stashKey(userId, k));
  });
  storage.set(DATA_OWNER, userId);
  return true;
}
/* Re-read everything the till keeps per account, after switchLocalDataTo swapped it in */

export function loadUserState(){
  store.catalog = storage.get("rc_catalog", null);
  store.imgs = objOr(storage.get("rc_imgs", {}), {});
  store.remoteDays = {};
  store.localDays = objOr(storage.get("rc_local", {}), {});
  store.dirty = new Set(storage.get("rc_dirty", []));
  store.pend = objOr(storage.get("rc_pend", null), { cat: false, img: {} }); if(!store.pend.img) store.pend.img = {};
  store.cart = storage.get("rc_cart", []); if(!Array.isArray(store.cart)) store.cart = [];
  store.disc = Math.max(0, +storage.get("rc_disc", 0) || 0);
  store.cartCust = storage.get("rc_cartcust", null);
  store.moves = objOr(storage.get("rc_moves", {}), {});
  store.returnsMap = objOr(storage.get("rc_returns", {}), {});
  store.customers = objOr(storage.get("rc_customers", {}), {});
  store.settings = Object.assign({}, DEFAULT_SETTINGS, objOr(storage.get("rc_settings", {}), {}));
  store.sbOfflineQueue = storage.get("hangtag_sb_queue", []); if(!Array.isArray(store.sbOfflineQueue)) store.sbOfflineQueue = [];
  store.profile = storage.get("hangtag_profile", null);
  applyCatalogMigration();
  store.editor = null; store.lastSale = null; store.retState = null; store.stockOp = null; store.showAllBills = false;
  closeSheets(); closeModal();
  renderAll();
}

/* Registered once at start-up (app/main.js). */
export function installAccountSwitchWatch(){
  // Another tab switched this device to a different account: reload so this tab doesn't write into it

  window.addEventListener("storage", e => {
    if(e.key === DATA_OWNER && store.authUser && e.newValue && JSON.parse(e.newValue) !== store.authUser.id) location.reload();
  });
}
