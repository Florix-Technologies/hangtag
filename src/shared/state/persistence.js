// Keeps the state store's slices on this device, and gives other code this device's keys, through the "storage" port.
import { store } from './store.js';
import { use } from '../di/services.js';
import { toast } from '../components/toast.js';

/* This device's key/value storage for keys that aren't a state slice (see StoragePort in shared/di/ports.js) */
export const storage = {
  get: (k, d) => use("storage").get(k, d),
  set: (k, v) => use("storage").set(k, v),
  getRaw: k => use("storage").getRaw(k),
  setRaw: (k, v) => use("storage").setRaw(k, v),
  remove: k => use("storage").remove(k)
};

/* ---------- state slices ---------- */

export const persistLocal=()=>{
  const ok=storage.set("rc_local",store.localDays);
  storage.set("rc_dirty",[...store.dirty]);
  if(!ok&&!store.warnedFull){store.warnedFull=true;setTimeout(()=>toast("Browser storage is full. Download a backup from Products now."),50)}
};
export const savePend=()=>storage.set("rc_pend",store.pend);
export const saveCart=()=>{storage.set("rc_cart",store.cart);storage.set("rc_disc",store.disc);storage.set("rc_cartcust",store.cartCust)};
export const savePrefs=()=>storage.set("rc_prefs",store.prefs);
export const saveSbQueue=()=>storage.set("hangtag_sb_queue",store.sbOfflineQueue);
export const saveCatalog=()=>storage.set("rc_catalog",store.catalog);
export const saveImgs=()=>storage.set("rc_imgs",store.imgs);
export const saveMoves=()=>storage.set("rc_moves",store.moves);
export const saveReturns=()=>storage.set("rc_returns",store.returnsMap);
export const saveCustomers=()=>storage.set("rc_customers",store.customers);
export const saveSettings=()=>storage.set("rc_settings",store.settings);
export const saveLogo=()=>storage.set("rc_logo",store.logo||"");
export const savePrinter=()=>storage.set("rc_printer",store.printer);
export const saveProfile=()=>storage.set("hangtag_profile",store.profile);
export const saveLastSync=()=>storage.set("hangtag_last_sync",store.lastSyncAt);
