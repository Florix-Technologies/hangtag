// Keeps each account's local data separate on a shared device.
import { store } from '../../../shared/state/store.js';
import { DEFAULT_SETTINGS } from '../../../domain/shop/settings.js';
import { discountInput } from '../../../domain/sales/discounts.js';
import { applyCatalogMigration } from '../../products/services/catalog.js';
import { closeSheets } from '../../sales/components/bill-panel.js';
import { closeModal } from '../../../shared/components/modal.js';
import { storage } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { objOr } from '../../../shared/utils/objects.js';
import { resetAssistant } from '../../assistant/pages/assistant-page.js';
import { resetProductDraftAssistant } from '../../products/components/product-draft-assistant.js';

/* ---------- Each account keeps its own data on this device ----------
   The app works on the plain keys below. When a different account signs in, the current data is put away
   under its owner and that account's own data (or a fresh start) is brought back. */

export const USER_KEYS = ["hangtag_sb_queue", "hangtag_sync_review", "rc_local", "rc_dirty", "rc_moves", "rc_returns", "rc_customers", "rc_events", "rc_settings", "rc_pend", "rc_cart", "rc_disc", "rc_cartcust", "rc_catalog", "rc_imgs", "hangtag_profile", "rc_logo", "hangtag_pay_pending", "hangtag_delivery_queue", "rc_cash_moves", "rc_day_closes", "hangtag_access", "rc_collections", "rc_held", "rc_orders", "rc_cartorder", "rc_suppliers", "rc_purchases", "rc_supplier_pays",
  "rc_tables", "rc_table_sessions", "rc_carttable", "rc_pending_docs", "rc_quote_sends"];
export const MUST_KEEP = ["hangtag_sb_queue", "hangtag_sync_review", "rc_local", "rc_dirty", "rc_moves", "rc_returns", "rc_customers", "rc_events", "rc_cash_moves", "rc_day_closes", "rc_collections", "rc_held", "rc_orders", "rc_suppliers", "rc_purchases", "rc_supplier_pays", "rc_tables", "rc_table_sessions", "rc_pending_docs", "rc_quote_sends"];   // unsent work: never drop these
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
      // Settings, the logo or photos couldn't be put away: their queued uploads send whatever the app holds when they run,
      // which would then be empty and wipe the shop's copy in the cloud. Drop those uploads; the cloud copy comes back
      // down when the account returns.
      const type = { rc_settings: "settings", rc_logo: "logo", rc_imgs: "img" }[k];
      if(type) try{
        const qk = stashKey(owner, "hangtag_sb_queue"), q = JSON.parse(storage.getRaw(qk) || "[]");
        if(Array.isArray(q)) storage.setRaw(qk, JSON.stringify(q.filter(x => !x || x.type !== type)));
      }catch{ /* the queue itself was put away above; leaving it as it is only risks these, not unsent bills */ }
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
  store.disc = discountInput(storage.get("rc_disc", null));
  store.cartCust = storage.get("rc_cartcust", null);
  store.moves = objOr(storage.get("rc_moves", {}), {});
  store.returnsMap = objOr(storage.get("rc_returns", {}), {});
  store.customers = objOr(storage.get("rc_customers", {}), {});
  store.events = objOr(storage.get("rc_events", {}), {});
  store.syncReview = storage.get("hangtag_sync_review", []); if(!Array.isArray(store.syncReview)) store.syncReview = [];
  store.payPending = objOr(storage.get("hangtag_pay_pending", null), null); store.payConfig = null; store.unmatched = null;
  store.cashMoves = objOr(storage.get("rc_cash_moves", {}), {}); store.dayCloses = objOr(storage.get("rc_day_closes", {}), {});
  store.suppliers = objOr(storage.get("rc_suppliers", {}), {}); store.purchases = objOr(storage.get("rc_purchases", {}), {}); store.supplierPays = objOr(storage.get("rc_supplier_pays", {}), {});
  // credit, held bills and orders (section 3m), a restaurant's tables (3o), supplier bills' originals and quotations still to send
  store.collections = objOr(storage.get("rc_collections", {}), {}); store.heldCarts = objOr(storage.get("rc_held", {}), {}); store.orders = objOr(storage.get("rc_orders", {}), {});
  store.cartOrder = objOr(storage.get("rc_cartorder", null), null); store.cartTable = objOr(storage.get("rc_carttable", null), null);
  store.tables = objOr(storage.get("rc_tables", {}), {}); store.tableSessions = objOr(storage.get("rc_table_sessions", {}), {});
  store.pendingDocs = objOr(storage.get("rc_pending_docs", {}), {});
  store.quoteSends = storage.get("rc_quote_sends", []); if(!Array.isArray(store.quoteSends)) store.quoteSends = [];
  store.orderForm = null; store.collectForm = null; store.tableView = null; store.quoteDoc = null;
  store.deliveryQueue = storage.get("hangtag_delivery_queue", []); if(!Array.isArray(store.deliveryQueue)) store.deliveryQueue = [];
  store.settings = Object.assign({}, DEFAULT_SETTINGS, objOr(storage.get("rc_settings", {}), {}));
  store.sbOfflineQueue = storage.get("hangtag_sb_queue", []); if(!Array.isArray(store.sbOfflineQueue)) store.sbOfflineQueue = [];
  store.profile = storage.get("hangtag_profile", null);
  store.access = objOr(storage.get("hangtag_access", null), null); store.team = null;
  store.logo = storage.get("rc_logo", "") || ""; store.deliveries = {}; store.channels = null; store.printState = null;
  applyCatalogMigration();
  store.editor = null; store.lastSale = null; store.retState = null; store.stockOp = null; store.showAllBills = false;
  store.purchaseForm = null; store.supplierView = null; store.stockCount = null; store.prodImport = null; store.quickProduct = null; store.invSub = "levels";
  resetAssistant(); resetProductDraftAssistant();
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
