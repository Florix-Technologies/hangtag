// Start-up values of the application state (restored from this device's storage, through the "storage" port, where saved).
import { store } from '../shared/state/store.js';
import { DEFAULT_SETTINGS } from '../domain/shop/settings.js';
import { discountInput } from '../domain/sales/discounts.js';
import { printerOf } from '../domain/shop/printer-settings.js';
import { scaleSettingsOf } from '../domain/shop/scale-settings.js';
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
  store.events = objOr(storage.get("rc_events",{}),{});        // events: pop-ups, exhibitions (by id); what this device sells at is prefs.event
  store.syncReview = storage.get("hangtag_sync_review",[]);    // uploads the database refused, kept for review (never dropped silently)
  if(!Array.isArray(store.syncReview)) store.syncReview=[];
  store.settings = Object.assign({},DEFAULT_SETTINGS,objOr(storage.get("rc_settings",{}),{}));
  store.payPending = objOr(storage.get("hangtag_pay_pending",null),null);   // a provider payment (UPI QR / card link) still open when the app closed
  store.payConfig = null;       // what the payment provider can take ({ upi, cardLink }), once asked
  store.unmatched = null;       // money the provider received that isn't on a bill (loaded in Books)
  store.deliveryQueue = storage.get("hangtag_delivery_queue",[]);   // receipts to send automatically (sent when online, retried)
  if(!Array.isArray(store.deliveryQueue)) store.deliveryQueue=[];
  store.cashMoves = objOr(storage.get("rc_cash_moves",{}),{});   // cash without a bill: opening float, cash in / out, expenses (by id)
  store.dayCloses = objOr(storage.get("rc_day_closes",{}),{});   // day closes: expected, counted, difference (by id)
  store.collections = objOr(storage.get("rc_collections",{}),{});   // payments customers made towards what they owe (by id)
  store.heldCarts = objOr(storage.get("rc_held",{}),{});           // bills put aside to finish later, on any till (by id)
  store.orders = objOr(storage.get("rc_orders",{}),{});            // quotations and sales orders (by id)
  store.cartOrder = objOr(storage.get("rc_cartorder",null),null);  // the order the bill being rung up comes from: { id, no, kind }
  store.tables = objOr(storage.get("rc_tables",{}),{});            // a restaurant's tables (by id)
  store.tableSessions = objOr(storage.get("rc_table_sessions",{}),{});   // guests seated at a table until their bill is paid (by id)
  store.cartTable = objOr(storage.get("rc_carttable",null),null);  // the table the bill being rung up is for: { table, name, sessions }
  store.pendingDocs = objOr(storage.get("rc_pending_docs",{}),{});   // supplier bills' originals still to upload (by import id)
  store.tableView = null;       // Tables: { sel (a table), mode: "floor" | "setup", order (an order being taken), edit, qr }
  store.ordersView = "";        // Orders tab: "held" | "quote" | "sales" ("": the first one this person has)
  store.orderForm = null;       // the quotation / sales order being edited
  store.collectForm = null;     // "Collect payment" from a customer: { cid, amount, method, ref, note, err }
  store.suppliers = objOr(storage.get("rc_suppliers",{}),{});   // who the shop buys from (by id)
  store.purchases = objOr(storage.get("rc_purchases",{}),{});   // purchases: a supplier's invoice entered line by line (by id)
  store.supplierPays = objOr(storage.get("rc_supplier_pays",{}),{});   // later payments to suppliers and their reversals (by id)
  store.invSub = "levels";      // Inventory: which part is open (levels, purchases, suppliers, count)
  store.purchaseForm = null;    // the purchase entry sheet
  store.supplierView = null;    // Inventory → Suppliers: the open supplier, its forms
  store.stockCount = null;      // Inventory → Stock count: filter, typed counts, review
  store.prodImport = null;      // Products → Import: the file, its rows checked
  store.quickProduct = null;    // a new product made from an unknown barcode
  store.cashForm = null;        // the cash entry / day close sheet
  store.voidForm = null;        // cancelling a bill: its reason
  store.gstView = null;         // the GST filing view: { month } or { from, to }
  store.cartCust = storage.get("rc_cartcust",null);            // customer on the bill being rung up
  store.logo = storage.get("rc_logo","") || "";                // shop logo for receipts (small data URL; synced as hangtag_meta "logo")
  store.printer = printerOf(storage.get("rc_printer",null));    // this device's receipt printer (not synced: each till has its own)
  store.printState = null;      // the last print from a bill: { sid, status: "printing"|"done"|"error", message }
  store.scale = scaleSettingsOf(storage.get("hangtag_scale",null));   // this device's weighing scale (not synced: each counter has its own)
  store.weigh = null;           // the weight dialog: { vid, line (a bill line weighed again), value, err, busy, note }
  store.deliveries = {};        // bills sent to customers, by bill id (this session's sends and what the server recorded)
  store.channels = null;        // which of email / WhatsApp / SMS the server can send ({ email, whatsapp, sms }), once asked
  store.prefs = Object.assign({tab:"sell",density:"photos",period:"today",day:"",from:"",to:""},storage.get("rc_prefs",{}));
  // a module id (the navigation shows the first page this person can open when that one isn't shown in this shop)
  if(typeof store.prefs.tab!=="string"||!/^[a-z][a-z0-9_-]{0,30}$/.test(store.prefs.tab))store.prefs.tab="sell";
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
  store.profile = storage.get("hangtag_profile", null);   // this account's profile (kept per account on this device); a team member: its shop's
  store.access = objOr(storage.get("hangtag_access", null), null);   // a team member's role and permissions in its shop (null: the owner)
  store.team = null;            // Settings → Team & devices / Roles & permissions (the owner's screens)
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
