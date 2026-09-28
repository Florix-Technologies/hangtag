// Start-up values of the application state (restored from this device's storage, through the "storage" port, where saved).
import { store } from '../shared/state/store.js';
import { DEFAULT_SETTINGS } from '../domain/shop/settings.js';
import { discountInput } from '../domain/sales/discounts.js';
import { printerOf } from '../domain/shop/printer-settings.js';
import { storage } from '../shared/state/persistence.js';
import { objOr } from '../shared/utils/objects.js';

export function initState(){
  /* ================= state ================= */

  store.dev = storage.get("rc_dev",null);
  if(!store.dev){store.dev=Math.random().toString(36).slice(2,8);storage.set("rc_dev",store.dev)}
  store.mode = "standalone";
  store.syncFail = false;
  store.catalog = storage.get("rc_catalog",null);
  store.imgs = objOr(storage.get("rc_imgs",{}),{});
  store.remoteDays = {};
  store.localDays = objOr(storage.get("rc_local",{}),{});
  store.dirty = new Set(storage.get("rc_dirty",[]));
  store.pend = objOr(storage.get("rc_pend",null),{cat:false,img:{}});
  if(!store.pend.img)store.pend.img={};
  store.cart = storage.get("rc_cart",[]);
  if(!Array.isArray(store.cart))store.cart=[];
  store.disc = discountInput(storage.get("rc_disc",null));   // bill discount box { type: "fixed"|"percent", value } (older versions saved ₹ off as a number)
  store.moves = objOr(storage.get("rc_moves",{}),{});          // stock history: opening, stock in, adjustments (by id)
  store.returnsMap = objOr(storage.get("rc_returns",{}),{});   // returns and exchanges (by id)
  store.customers = objOr(storage.get("rc_customers",{}),{});  // customers (by id)
  store.settings = Object.assign({},DEFAULT_SETTINGS,objOr(storage.get("rc_settings",{}),{}));
  store.cartCust = storage.get("rc_cartcust",null);            // customer on the bill being rung up
  store.logo = storage.get("rc_logo","") || "";                // shop logo for receipts (small data URL; synced as hangtag_meta "logo")
  store.printer = printerOf(storage.get("rc_printer",null));    // this device's receipt printer (not synced: each till has its own)
  store.printState = null;      // the last print from a bill: { sid, status: "printing"|"done"|"error", message }
  store.deliveries = {};        // bills sent to customers, by bill id (this session's sends and what the server recorded)
  store.channels = null;        // which of email / WhatsApp / SMS the server can send ({ email, whatsapp, sms }), once asked
  store.prefs = Object.assign({tab:"sell",density:"photos",period:"today",day:"",from:"",to:""},storage.get("rc_prefs",{}));
  if(!["sell","stock","report","products","customers"].includes(store.prefs.tab))store.prefs.tab="sell";
  store.pick = null;            // variant picker: {pid, color, qty:{vid:n}, last, target:"cart"|"exchange"}
  store.billOpen = false;
  store.justAdded = null;
  store.editor = null;          // product editor state
  store.lastSale = null;
  store.showAllBills = false;
  store.warnedFull = false;
  store.sellQuery = "";
  store.sellCat = "";
  store.prodQuery = "";
  store.prodView = "active";
  store.prodCat = "";
  store.stockView = "all";
  store.sbClient = null;
  store.sbRealtimeChannel = null;
  store.sbStatus = "disconnected"; // 'connected' | 'connecting' | 'error' | 'update' | 'disconnected'
  store.sbOfflineQueue = storage.get("hangtag_sb_queue", []);
  if(!Array.isArray(store.sbOfflineQueue)) store.sbOfflineQueue=[];
  store.lastSyncAt = +storage.get("hangtag_last_sync", 0) || 0;
  store.syncing = false;
  /* ================= derived ================= */

  store._d = null;
  /* ================= Sign-in (Google, other services, or email) + profiles ================= */

  store.authUser = null;
  store.authSettings = null;   // Supabase's public auth settings: which sign-in services are switched on
  store.bootDone = false;
  store.signingIn = null;
  store.signedOutByUser = false;   // set by Sign out; a token refresh that finishes afterwards must not sign back in
  store.emailMode = "signin";      // "signin" | "signup" | "forgot"
  store.profile = storage.get("hangtag_profile", null);   // this account's profile (kept per account on this device)
  /* ================= Supabase Database Engine ================= */

  store.sbInitP = null;
  store.sbErrorText = "";
  store.catPullT = null;
  /* ---------- the upload queue ---------- */

  store.sbFlushP = null;
  store.sbFlushAgain = false;
  /* ---------- checkout ---------- */

  store.lastCheckout = 0;
  store.custQ = "";
  store.custForm = null;
  store.lineDisc = null;        // line discount sheet: { i, type, value, err }
  store.payState = null;        // payment sheet: { mode:"single"|"split", method, received, ref, split:{cash,upi,card}, recv, refs, err }
  /* ================= returns and exchanges ================= */

  store.retState = null;
  /* ---------- choose a product (for stock in / adjust / exchange) ---------- */

  store.chooserFor = null;
  store.chooserQ = "";
  /* ---------- stock in and stock adjustment (many variants in one go; every change is recorded) ---------- */

  store.stockOp = null;
  store.restoreCheck = null;
  /* ================= toast + tooltip ================= */

  store.toastT = null;
  /* ---------- keyboard: shortcuts, pickers, and USB/Bluetooth barcode scanners (they type fast and press Enter) ---------- */

  store.scanBuf = "";
  store.scanT0 = 0;
  store.scanLast = 0;
  store.scanTimer = null;
  store.scanHeld = null;
  store.rT = null;
}
