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
  return ok;
};
export const savePend=()=>storage.set("rc_pend",store.pend);
export const saveCart=()=>{storage.set("rc_cart",store.cart);storage.set("rc_disc",store.disc);storage.set("rc_cartcust",store.cartCust);if(store.cartOrder)storage.set("rc_cartorder",store.cartOrder);else if(store.cartOrder!==undefined)storage.remove("rc_cartorder");if(store.cartTable)storage.set("rc_carttable",store.cartTable);else if(store.cartTable!==undefined)storage.remove("rc_carttable")};
export const savePrefs=()=>storage.set("rc_prefs",store.prefs);
export const saveSbQueue=()=>storage.set("hangtag_sb_queue",store.sbOfflineQueue);
export const saveCatalog=()=>storage.set("rc_catalog",store.catalog);
export const saveImgs=()=>storage.set("rc_imgs",store.imgs);
export const saveMoves=()=>storage.set("rc_moves",store.moves);
export const saveReturns=()=>storage.set("rc_returns",store.returnsMap);
export const saveCustomers=()=>storage.set("rc_customers",store.customers);
export const saveEvents=()=>storage.set("rc_events",store.events);
export const saveSyncReview=()=>storage.set("hangtag_sync_review",store.syncReview);
export const savePayPending=()=>{ if(store.payPending) storage.set("hangtag_pay_pending",store.payPending); else storage.remove("hangtag_pay_pending"); };
export const saveCashMoves=()=>storage.set("rc_cash_moves",store.cashMoves);
export const saveDayCloses=()=>storage.set("rc_day_closes",store.dayCloses);
/* suppliers, purchases from them and later payments to them (section 3l), by id */
export const saveSuppliers=()=>storage.set("rc_suppliers",store.suppliers);
export const savePurchases=()=>storage.set("rc_purchases",store.purchases);
export const saveSupplierPays=()=>storage.set("rc_supplier_pays",store.supplierPays);
export const saveDeliveryQueue=()=>storage.set("hangtag_delivery_queue",store.deliveryQueue);
export const saveSettings=()=>storage.set("rc_settings",store.settings);
export const saveLogo=()=>storage.set("rc_logo",store.logo||"");
/* The authorised signature and company stamp printed on A4 documents ({ signature, stamp }: small data URLs) */
export const saveDocImages=()=>storage.set("rc_docimg",store.docImages||{});
export const saveAutoLog=()=>storage.set("rc_autolog",store.autoLog||[]);
export const savePrinter=()=>storage.set("rc_printer",store.printer);
/* This device's weighing scale settings (not synced: each counter has its own scale) */
export const saveScale=()=>storage.set("hangtag_scale",store.scale);
export const saveProfile=()=>storage.set("hangtag_profile",store.profile);
export const saveLastSync=()=>storage.set("hangtag_last_sync",store.lastSyncAt);
/* A team member's role and permissions in its shop (null for the owner), kept per account so the till knows them offline */
export const saveAccess=()=>{ if(store.access) storage.set("hangtag_access",store.access); else storage.remove("hangtag_access"); };
/* Customer credit, held bills and orders (section 3m): kept per account on this device until uploaded */
export const saveCollections=()=>storage.set("rc_collections",store.collections);
export const saveHeldCarts=()=>storage.set("rc_held",store.heldCarts);
export const saveOrders=()=>storage.set("rc_orders",store.orders);
/* A restaurant's tables and their sessions (section 3o): kept per account on this device until uploaded */
export const saveTables=()=>storage.set("rc_tables",store.tables);
export const saveTableSessions=()=>storage.set("rc_table_sessions",store.tableSessions);
/* Supplier bills' originals that couldn't reach the cloud yet (the files themselves are in the blobStore), by import id */
export const savePendingDocs=()=>storage.set("rc_pending_docs",store.pendingDocs||{});
/* Quotations sent to customers from this device: each press of Send until it went out (queued → sent / failed) */
export const saveQuoteSends=()=>storage.set("rc_quote_sends",store.quoteSends||[]);
/* The commerce batch's records (section 3r), by kind then id: pl price lists, po purchase orders, ei / ew e-invoice / e-way
   readiness, rpk repacks, gv gift vouchers (the cloud's copy) */
export const saveBiz=()=>storage.set("rc_biz",store.biz||{});
/* The price list chosen on the bill being rung up (null: the default list) */
export const saveCartPriceList=()=>{ if(store.cartPriceList) storage.set("rc_cartpl",store.cartPriceList); else storage.remove("rc_cartpl"); };
