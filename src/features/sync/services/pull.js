// Downloads cloud data (keeping unsent local changes) and pushes everything.
import { finishDownloadedProduct } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { DEFAULT_SETTINGS } from '../../../domain/shop/settings.js';
import { keepNewerCaps } from '../../../domain/shop/capabilities.js';
import { mergeLogs } from '../../../domain/automation/rules.js';
import { sbSessionOk } from '../../auth/services/auth-settings.js';
import { products } from '../../products/services/catalog.js';
import { renderSync } from '../components/sync-status.js';
import { enqueue, flushSbQueue, markSynced } from './outbox.js';
import { use } from '../../../shared/di/services.js';
import { toast } from '../../../shared/components/toast.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { saveAutoLog, saveCashMoves, saveCatalog, saveCustomers, saveDayCloses, saveDocImages, saveEvents, saveImgs, saveLogo, saveMoves, saveReturns, saveSettings } from '../../../shared/state/persistence.js';
import { saveCollections, saveHeldCarts, saveOrders, savePurchases, saveSupplierPays, saveSuppliers, saveTableSessions, saveTables } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { logger } from '../../../shared/logging/logger.js';
import { can } from '../../shop/services/access.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { refreshShopUnits } from '../../products/services/shop-fields.js';
import { AppError, ERROR_CODES } from '../../../shared/errors/app-error.js';
import { beginPull, changedSince, mayApply } from './sync-ledger.js';

/* ---------- pulls (cloud is the truth, except for work still waiting in this device's queue) ---------- */
let seen = null;   // the shop's fingerprints this device's data matches (null: not known yet; see pullShopChanges)
let seenPurchases = null;   // …and the fingerprint of its suppliers, purchases and supplier payments (hangtag_purchase_changes)

/* The ids of a type's records this device's copy wins for: waiting in its queue, or — given the download g — uploaded
   (or brought by realtime) after g began, so possibly missing from what g read (sync-ledger.js) */
export const pendingIds = (type, g) => {
  const ids = new Set(store.sbOfflineQueue.filter(q=>q.type===type).map(q=>q.id || (q.move&&q.move.id) || (q.ret&&q.ret.id) || (q.cust&&q.cust.id) || (q.ev&&q.ev.id)));
  changedSince(type, g).forEach(id => ids.add(id));
  return ids;
};
/* The cloud's photos, except those this device changed and the cloud may not have yet: waiting to upload, uploaded or
   brought by realtime after download g began (as they are here: a photo removed here stays removed) */
function withLocalImages(images, g){
  const map = {}, mine = changedSince("img", g);
  images.forEach(im => { map[im.productId] = im.data; });
  store.sbOfflineQueue.forEach(q => { if(q.type === "img") mine.add(q.id); });
  mine.forEach(id => { if(store.imgs[id]) map[id] = store.imgs[id]; else delete map[id]; });
  return map;
}
/* opts.images: false = leave the photos as they are (a member's phone downloads them only when they changed).
   → false when the download failed (this device's products are left as they were), true otherwise */
export async function pullCatalogFromSupabase(remoteIsTruth = false, opts = {}){
  if(!store.sbClient || !(await sbSessionOk())) return false;
  const g = beginPull("catalog"), gi = opts.images === false ? null : beginPull("images");
  try{
    const cloud = use("cloud");
    const prods = await cloud.fetchProducts();
    if(!prods.length && !products().length) return true;
    const vars = await cloud.fetchVariants();
    const images = gi ? await cloud.fetchImages() : null;
    if((prods.length > 0 || remoteIsTruth) && mayApply(g)){
      const pending = pendingIds("prod", g), gone = pendingIds("proddel", g), local = {};
      products().forEach(p=>{ local[p.id]=p; });
      const pMap = {}, order = [];
      prods.forEach(p => { pMap[p.id] = p; order.push(p.id); });
      vars.forEach(({ productId, variant }) => { if(pMap[productId]) pMap[productId].variants.push(variant); });
      // A product changed on this device and not uploaded yet stays as it is here; one deleted here stays deleted
      pending.forEach(id => { if(local[id]){ if(!pMap[id]) order.push(id); pMap[id] = local[id]; } });
      gone.forEach(id => { if(!local[id]) delete pMap[id]; });
      store.catalog = { version:3, example:false, products: order.map(id=>pMap[id]).filter(Boolean).map(finishDownloadedProduct) };
      saveCatalog();
    }
    if(gi && ((images && images.length) || remoteIsTruth) && mayApply(gi)){ store.imgs = withLocalImages(images || [], gi); saveImgs(); }
    return true;
  }catch(e){ logger.event("sync", "download-failed", { op: "catalog", code: e && e.code }); return false; }
}
export async function pullMoves(){
  const g = beginPull("moves");
  const list = await use("cloud").fetchMoves();
  if(!mayApply(g)) return;
  const pending = pendingIds("move", g), next = {};
  // the stock records of a purchase (or its cancel) still on its way go up with it, so they stay too
  const withPurchase = new Set([...pendingIds("purchase", g), ...pendingIds("pcancel", g)]);
  // …and so do a repack's two records (rpk:<id>:out / :in) while the repack is on its way
  const repacks = new Set([...store.sbOfflineQueue.filter(q => q.type === "biz" && q.kind === "rpk").map(q => q.id), ...changedSince("biz:rpk", g)]);
  list.forEach(m => { next[m.id] = m; });
  Object.values(store.moves).forEach(m => { const rk = /^rpk:(.+):(out|in)$/.exec(m.id);
    if(pending.has(m.id) || (m.imp && withPurchase.has(m.imp)) || (rk && repacks.has(rk[1]))) next[m.id] = m; });
  store.moves = next; saveMoves();
}
export async function pullReturns(){
  const g = beginPull("returns");
  const list = await use("cloud").fetchReturns();
  if(!mayApply(g)) return;
  const pending = pendingIds("return", g), next = {};
  list.forEach(r => { next[r.id] = r; });
  Object.values(store.returnsMap).forEach(r => { if(pending.has(r.id)) next[r.id] = r; });
  store.returnsMap = next; saveReturns();
}
export async function pullCustomers(){
  const g = beginPull("customers");
  const list = await use("cloud").fetchCustomers();
  if(!mayApply(g)) return;
  const pending = pendingIds("cust", g), next = {};
  list.forEach(c => { next[c.id] = c; });
  Object.values(store.customers).forEach(c => { if(pending.has(c.id)) next[c.id] = c; });
  store.customers = next; saveCustomers();
}
/* Events: the cloud's list, except events changed or deleted on this device and not uploaded yet */
/* Cash entries and day closes from every device of the shop (entries waiting to upload stay as they are) */
export async function pullCash(){
  const cloud = use("cloud"), g = beginPull("cash");
  const [moves, closes] = await Promise.all([cloud.fetchCashMoves(), cloud.fetchDayCloses()]);
  if(!mayApply(g)) return;
  const pm = pendingIds("cashmove", g), pc = pendingIds("dayclose", g), M = {}, C = {};
  moves.forEach(m => { M[m.id] = m; }); Object.values(store.cashMoves || {}).forEach(m => { if(pm.has(m.id) || !M[m.id]) M[m.id] = m; });
  closes.forEach(c => { C[c.id] = c; }); Object.values(store.dayCloses || {}).forEach(c => { if(pc.has(c.id)) C[c.id] = c; });
  store.cashMoves = M; saveCashMoves(); store.dayCloses = C; saveDayCloses();
}
export async function pullEvents(){
  const g = beginPull("events");
  const list = await use("cloud").fetchEvents();
  if(!mayApply(g)) return;
  const pending = pendingIds("event", g), deleted = pendingIds("eventdel", g), next = {};
  list.forEach(e => { if(!deleted.has(e.id)) next[e.id] = e; });
  Object.values(store.events || {}).forEach(e => { if(pending.has(e.id)) next[e.id] = e; });
  store.events = next; saveEvents();
}
/* Suppliers, purchases and later payments to suppliers (section 3l) from every device of the shop; those still waiting to
   upload from this device stay as they are. An older database (schema.sql not re-run yet) or a failed download leaves this
   device's copy alone → false */
export async function pullPurchases(){
  const cloud = use("cloud"), g = beginPull("purchases");
  let sups, purs, pays;
  try{ [sups, purs, pays] = await Promise.all([cloud.fetchSuppliers(), cloud.fetchPurchases(), cloud.fetchSupplierPayments()]); }
  catch(e){ logger.event("sync", "download-failed", { op: "purchases", code: e && e.code }, "warn"); return false; }
  if(!mayApply(g)) return true;   // a download that began later has brought them already
  const ps = pendingIds("supplier", g), pp = new Set([...pendingIds("purchase", g), ...pendingIds("pcancel", g)]), px = pendingIds("spay", g), S = {}, P = {}, X = {};
  sups.forEach(s => { S[s.id] = s; }); Object.values(store.suppliers || {}).forEach(s => { if(ps.has(s.id)) S[s.id] = s; });
  purs.forEach(p => { P[p.id] = p; }); Object.values(store.purchases || {}).forEach(p => { if(pp.has(p.id)) P[p.id] = p; });
  pays.forEach(x => { X[x.id] = x; }); Object.values(store.supplierPays || {}).forEach(x => { if(px.has(x.id)) X[x.id] = x; });
  store.suppliers = S; saveSuppliers(); store.purchases = P; savePurchases(); store.supplierPays = X; saveSupplierPays();
  return true;
}
/* Settings and the receipt logo (both kept in hangtag_meta; a change still waiting to upload wins — also one made while
   the download was on its way) */
export async function pullSettings(){
  // waiting: still to upload, or uploaded after this download began (the cloud's copy read before it is older)
  const g = beginPull("settings"), waiting = type => store.sbOfflineQueue.some(q=>q.type===type) || changedSince(type, g).size > 0;
  if(!waiting("settings")){
    const value = await use("cloud").fetchSettings();
    // the capability choices changed last win: a copy uploaded by a phone that was behind never undoes newer ones here
    if(value && typeof value === "object" && !waiting("settings") && mayApply(g)){ store.settings = Object.assign({}, DEFAULT_SETTINGS, keepNewerCaps(value, store.settings)); saveSettings(); }
  }
  if(!waiting("logo")){
    const logo = await use("cloud").fetchLogo();
    if(!waiting("logo") && mayApply(g)){ store.logo = logo; saveLogo(); }
  }
  // the signature and stamp: the cloud's copy, unless this device is still sending its own
  if(!waiting("docimg")){
    const im = await use("cloud").fetchDocImages();
    if(!waiting("docimg") && mayApply(g)){ store.docImages = im; saveDocImages(); }
  }
  // the automation log of every device (Settings → Automation), with this device's own
  try{ const log = await use("cloud").fetchAutomationLogs(); store.autoLog = mergeLogs(store.autoLog || [], log); saveAutoLog(); }
  catch(e){ logger.warn("Automation log:", e); }
}
export async function pullFromSupabase(showToast = true){
  if(!store.sbClient || store.sbStatus !== "connected" || !(await sbSessionOk())) return;
  store.syncing = true; renderSync();
  try{
    // the device notes where the shop stands first, so its next look fetches only what changed after: a member's phone
    // every 30 s, an owner's device when it catches up (catch-up.js); unknown (null) means the next look downloads all
    const marks = await use("cloud").shopChanges().catch(() => null);
    const pmarks = await use("cloud").purchaseChanges().catch(() => null);
    const catalogOk = await pullCatalogFromSupabase();
    await pullMoves();
    await pullReturns();
    await pullCustomers();
    await pullEvents();
    await pullCash();
    // orders, held bills and payments collected (section 3m): a database without them yet doesn't stop the rest
    await pullOrders().catch(e => logger.event("sync", "download-failed", { op: "orders", code: e && e.code }, "warn"));
    await pullPurchases();
    // price lists, purchase orders, GST readiness, repacks, vouchers (section 3r): a database without them keeps this device's copy
    await pullBiz().catch(e => logger.event("sync", "download-failed", { op: "commerce", code: e && e.code }, "warn"));
    await pullSettings();
    await pullSales();
    // products that didn't come down aren't up to date: the next look downloads them again
    seen = marks && !catalogOk ? Object.assign({}, marks, { catalog: null }) : marks; seenPurchases = pmarks;
    if(catalogOk) markSynced();
    renderAll();
    if(!catalogOk) throw new AppError(ERROR_CODES.NETWORK, "The products weren't downloaded.");
    if(showToast) toast("Everything is up to date.");
    return true;
  }catch(e){
    logger.error("Pull from Supabase failed:", e);
    if(showToast) toast("Couldn't refresh from the cloud. Your work is saved on this device.");
    return false;
  }finally{ store.syncing = false; renderSync(); }
}
/* Every bill of the shop (with lines and payments), grouped by day and device as the ledger reads them */
export async function pullSales(){
  const g = beginPull("sales");
  const sales = await use("cloud").fetchSales();
  if(!mayApply(g)) return;
  const newRemoteDays = {};
  sales.forEach(s => addRemoteSale(newRemoteDays, s));
  keepLiveSales(newRemoteDays, g);
  store.remoteDays = newRemoteDays;
}
/* Bills realtime brought, or cancelled, after download g began (remote-events.js): as they are here — one the download
   hasn't got is kept, one it has keeps its cancelled state from here. And a bill cancelled or restored on this device and
   not uploaded yet (or uploaded after g began) keeps its state here: a restore isn't undone by the cloud's older copy */
function keepLiveSales(days, g){
  const live = changedSince("sale", g), mine = pendingIds("void", g);
  if(!live.size && !mine.size) return;
  const wasVoid = new Set(); Object.values(store.remoteDays).forEach(doc => (doc.voids || []).forEach(id => wasVoid.add(id)));
  const got = new Map(); Object.values(days).forEach(doc => doc.sales.forEach(s => got.set(s.id, s)));
  Object.values(store.remoteDays).forEach(doc => (doc.sales || []).forEach(s => {
    if(!live.has(s.id)) return;
    const d = got.get(s.id);
    if(!d) addRemoteSale(days, s);
    else if(!!d.void !== !!s.void) addRemoteSale(days, Object.assign({}, d, { void: !!s.void }));
  }));
  if(mine.size) Object.values(days).forEach(doc => doc.sales.forEach(s => {
    if(!mine.has(s.id)) return;
    const v = wasVoid.has(s.id);
    doc.voids = doc.voids.filter(x => x !== s.id); if(v) doc.voids.push(s.id);
  }));
}
function addRemoteSale(days, s){
  const d = dayKey(s.t), devId = s.dev || "cloud", dayId = `${d}_${devId}_0`;
  if(!days[dayId]) days[dayId] = { date: d, dev: devId, chunk: 0, sales: [], voids: [] };
  const doc = days[dayId], i = doc.sales.findIndex(x => x.id === s.id);
  if(i > -1) doc.sales[i] = s; else doc.sales.push(s);
  doc.voids = doc.voids.filter(v => v !== s.id);
  if(s.void) doc.voids.push(s.id);
}

/* ---------- a team member's phone: only what changed ----------
   It gets no live updates (realtime can't carry its device key), so every 30 s it asks the database for one small
   fingerprint per part of the shop (hangtag_shop_changes) and downloads only the parts whose fingerprint moved: photos
   only when a photo changed, and of the bills only those saved since its last look (plus which are cancelled). The full
   download stays for connecting and "Refresh". */
export const forgetShopChanges = () => { seen = null; seenPurchases = null; };
const MARGIN_MS = 120000;   // bills saved by a long upload that began before the last look still come along
const isoMinus = (t, ms) => { const x = Date.parse(String(t || "").replace(/(\.\d{3})\d+/, "$1")); return Number.isFinite(x) ? new Date(x - ms).toISOString() : null; };
/* → the parts downloaded (e.g. ["sales","customers"]); [] when nothing changed. Throws when a part didn't come down: the
   parts it did are kept, and the next look downloads the rest again (it is not counted as up to date) */
export async function pullShopChanges(){
  if(!store.sbClient || store.sbStatus !== "connected" || !(await sbSessionOk())) return [];
  const cloud = use("cloud");
  const now = await cloud.shopChanges();
  // not known what this phone's copy matches: once, everything
  if(!seen){ if(!(await pullFromSupabase(false))) throw new AppError(ERROR_CODES.NETWORK, "The shop wasn't downloaded."); return ["all"]; }
  const was = seen, parts = ["catalog", "images", "moves", "returns", "customers", "events", "cash", "settings", "sales"].filter(k => now[k] !== was[k]);
  const pnow = await cloud.purchaseChanges().catch(() => null);
  if(pnow != null && pnow !== seenPurchases) parts.push("purchases");
  if(!parts.length) return [];
  store.syncing = true; renderSync();
  let missed = [];
  try{
    if(parts.includes("catalog") && !(await pullCatalogFromSupabase(false, { images: false }))) missed.push("catalog");
    if(parts.includes("images")) await pullImages();
    if(parts.includes("moves")) await pullMoves();
    if(parts.includes("returns")) await pullReturns();
    if(parts.includes("customers")) await pullCustomers();
    if(parts.includes("events")) await pullEvents();
    if(parts.includes("cash")) await pullCash();
    if(parts.includes("settings")) await pullSettings();
    if(parts.includes("purchases")){ if(await pullPurchases()) seenPurchases = pnow; else missed.push("purchases"); }
    if(parts.includes("sales")) await pullNewSales(was, now);
    // a part that didn't come down keeps its old fingerprint, so the next look asks for it again
    seen = Object.assign({}, now); missed.forEach(k => { if(k in was) seen[k] = was[k]; });
    if(!missed.length) markSynced();
    renderAll();
  }finally{ store.syncing = false; renderSync(); }
  if(missed.length) throw new AppError(ERROR_CODES.NETWORK, "Not downloaded: " + missed.join(", "));
  return parts;
}
/* The shop's photos (only when one changed); a photo still waiting to upload from this phone stays as it is */
export async function pullImages(){
  const g = beginPull("images");
  const images = await use("cloud").fetchImages();
  if(!images || !mayApply(g)) return;
  store.imgs = withLocalImages(images, g); saveImgs();
}
/* The bills saved since the last look, and which bills are cancelled now. If this phone's copy then doesn't hold as many
   bills as the cloud (a bill removed, a very long upload, 1000 new ones), it downloads them all once. */
async function pullNewSales(was, now){
  const cloud = use("cloud"), g = beginPull("sales");
  const since = isoMinus(was.sales_since, MARGIN_MS);
  const fresh = since ? await cloud.fetchSalesSince(since) : null;
  if(!fresh || fresh.length >= 1000){ await pullSales(); return; }
  const voided = now.sales_voids !== was.sales_voids ? new Map((await cloud.fetchVoidedSales()).map(v => [v.id, v.reason])) : null;
  if(!mayApply(g)) return;
  // this device's copy as it is now (with what realtime brought while the bills came down)
  const days = Object.assign({}, store.remoteDays), live = changedSince("sale", g);
  Object.keys(days).forEach(k => { days[k] = Object.assign({}, days[k], { sales: days[k].sales.slice(), voids: (days[k].voids || []).slice() }); });
  fresh.forEach(s => addRemoteSale(days, s));
  if(voided){
    Object.values(days).forEach(doc => {
      doc.sales.forEach(s => { if(live.has(s.id)) return; s.void = voided.has(s.id); if(s.void && voided.get(s.id)) s.voidReason = voided.get(s.id); else if(!s.void) delete s.voidReason; });
      doc.voids = doc.sales.filter(s => s.void).map(s => s.id);
    });
  }
  keepLiveSales(days, g);
  const held = new Set(); Object.values(days).forEach(doc => doc.sales.forEach(s => held.add(s.id)));
  if(held.size !== +now.sales_count){ await pullSales(); return; }
  store.remoteDays = days;
}

/* Upload everything this device has (after a restore, or loading examples). Uses the same queue as everyday work. */

export async function pushLocalToSupabase(){
  // the shop's own units and fields first: products name them (section 3z)
  ["un", "at"].forEach(kind => Object.values((store.biz && store.biz[kind]) || {}).forEach(r => enqueue({ type:"biz", kind, id:r.id, rec:{} })));
  products().forEach(p => enqueue({ type:"prod", id:p.id }));
  Object.keys(store.imgs).forEach(id => enqueue({ type:"img", id }));
  Object.values(store.moves).forEach(m => enqueue({ type:"move", id:m.id, move:m }));
  Object.values(store.customers).forEach(c => enqueue({ type:"cust", id:c.id, cust:c }));
  Object.values(store.events || {}).forEach(e => enqueue({ type:"event", id:e.id, ev:e }));
  enqueue({ type:"allsales" });
  Object.values(store.returnsMap).forEach(r => enqueue({ type:"return", id:r.id, ret:r }));
  Object.values(store.cashMoves || {}).sort((x, y) => (x.type === "reversal") - (y.type === "reversal")).forEach(m => enqueue({ type:"cashmove", id:m.id, move:m }));
  Object.values(store.dayCloses || {}).forEach(c => enqueue({ type:"dayclose", id:c.id, close:c }));
  // payments collected from customers (added once: sending one the cloud has changes nothing); orders upload on their own
  // version and held bills are short-lived, so neither is sent again here
  if(can("collect_credit")) Object.values(store.collections || {}).forEach(c => enqueue({ type:"collection", id:c.id, col:c }));
  // suppliers, purchases (a cancelled one: saved, then cancelled) and supplier payments (reversals after what they reverse)
  Object.values(store.suppliers || {}).forEach(s => enqueue({ type:"supplier", id:s.id, sup:s }));
  Object.values(store.purchases || {}).sort((x, y) => x.t - y.t).forEach(p => {
    const posted = { ...p, status:"posted" }; delete posted.cancelReason; delete posted.cancelledAt;
    enqueue({ type:"purchase", id:p.id, purchase:posted, moves:Object.values(store.moves).filter(m => m.imp === p.id && m.type === "RESTOCK") });
    if(p.status === "cancelled") enqueue({ type:"pcancel", id:p.id, reason:p.cancelReason || "Cancelled", t:p.cancelledAt || Date.now(), dev:p.dev || store.dev });
  });
  Object.values(store.supplierPays || {}).sort((x, y) => (x.reverses ? 1 : 0) - (y.reverses ? 1 : 0)).forEach(x => enqueue({ type:"spay", id:x.id, pay:x }));
  enqueue({ type:"settings" });
  if(store.logo) enqueue({ type:"logo" });
  ["signature","stamp"].forEach(kind => { if(store.docImages && store.docImages[kind]) enqueue({ type:"docimg", kind }); });
  renderSync();
  if(!store.sbClient || store.sbStatus !== "connected" || !(await sbSessionOk())){ toast("Saved on this device. It will upload when you're online."); return false; }
  await flushSbQueue();
  const left = store.sbOfflineQueue.length;
  toast(left ? "Some changes are still uploading." : "Everything is uploaded to the cloud.");
  return !left;
}

/* ---------- orders, held bills, payments collected from customers (section 3m) ---------- */
/* Records of a kind still waiting on this device: queued, or refused and kept in the sync review */
const reviewIds = type => new Set((store.syncReview || []).filter(r => r.item && r.item.type === type).map(r => r.item.id));
/* The cloud's orders, held bills and collections, except what this device changed and hasn't uploaded yet: an order
   waiting to upload stays as it is here (one refused as changed elsewhere is replaced by the cloud's, unless the cloud
   doesn't have it); a held bill recalled here stays gone; collections are never removed, so this device's own stay */
export async function pullOrders(){
  const cloud = use("cloud"), g = beginPull("orders");
  const [orders, held, cols] = await Promise.all([cloud.fetchOrders(), cloud.fetchHeldCarts(), cloud.fetchCollections()]);
  // a restaurant's tables and sessions (section 3o): a database without them yet doesn't stop the rest
  await pullTables().catch(e => logger.warn("Tables not downloaded:", e));
  if(!mayApply(g)) return;
  const po = new Set([...pendingIds("order", g), ...pendingIds("ostatus", g)]), ro = reviewIds("order"), ph = pendingIds("held", g), pd = pendingIds("helddel", g), pc = pendingIds("collection", g);
  const O = {}, H = {}, C = {};
  orders.forEach(o => { O[o.id] = o; });
  Object.values(store.orders || {}).forEach(o => { if(po.has(o.id) || (!O[o.id] && ro.has(o.id))) O[o.id] = o; });
  held.forEach(h => { if(!pd.has(h.id)) H[h.id] = h; });
  Object.values(store.heldCarts || {}).forEach(h => { if(ph.has(h.id)) H[h.id] = h; });
  cols.forEach(c => { C[c.id] = c; });
  Object.values(store.collections || {}).forEach(c => { if(pc.has(c.id) || !C[c.id]) C[c.id] = c; });
  store.orders = O; saveOrders(); store.heldCarts = H; saveHeldCarts(); store.collections = C; saveCollections();
}
/* A restaurant's tables and the sessions going on (and those closed lately), except what this device hasn't uploaded yet */
export async function pullTables(){
  const cloud = use("cloud"), g = beginPull("tables");
  const [tables, sessions] = await Promise.all([cloud.fetchTables(), cloud.fetchTableSessions()]);
  if(!mayApply(g)) return;
  const pt = pendingIds("table", g), ps = pendingIds("tsession", g), T = {}, S = {};
  tables.forEach(t => { T[t.id] = t; });
  Object.values(store.tables || {}).forEach(t => { if(pt.has(t.id)) T[t.id] = t; });
  sessions.forEach(s => { S[s.id] = s; });
  // this device's sessions: waiting to upload, or still going here though the cloud's list (open or recent) doesn't have them
  Object.values(store.tableSessions || {}).forEach(s => { if(ps.has(s.id)) S[s.id] = s; });
  store.tables = T; saveTables(); store.tableSessions = S; saveTableSessions();
}
/* ---------- the commerce batch (section 3r) ---------- */
/* The cloud's records of every kind, except what this device changed and hasn't uploaded (or the cloud refused for review):
   those stay as they are here. A kind the database doesn't have yet (schema.sql not re-run) leaves this device's copy alone. */
export async function pullBiz(){
  const g = beginPull("biz");
  const got = await use("cloud").fetchBiz();
  if(!mayApply(g)) return;
  // waiting here: queued, refused and kept for review, or uploaded after this download began (sync-ledger.js)
  const waiting = kind => new Set([...[...store.sbOfflineQueue, ...(store.syncReview || []).map(r => r.item)].filter(q => q && (q.type === "biz" || q.type === "bizdel") && q.kind === kind).map(q => q.id),
    ...changedSince("biz:" + kind, g), ...changedSince("bizdel:" + kind, g)]);
  Object.entries(got || {}).forEach(([kind, list]) => {
    if(!Array.isArray(list)) return;
    const keep = waiting(kind), next = {}, mine = {};
    list.forEach(r => { next[r.id] = r; });
    bizRepository().list(kind).forEach(r => { mine[r.id] = r; });
    // this device's version of each: as it is here — one removed here stays removed
    keep.forEach(id => { if(mine[id]) next[id] = mine[id]; else delete next[id]; });
    // a repack waiting to upload keeps its stock records here (pullMoves keeps them too)
    bizRepository().replace(kind, next);
  });
  refreshShopUnits();
}
/* A team member's phone (no live updates): the batch's records again only when their fingerprint moved */
let seenBiz = null;
export async function pullBizChanges(){
  if(!store.sbClient || store.sbStatus !== "connected") return false;
  const now = await use("cloud").bizChanges(), was = seenBiz;
  if(was && JSON.stringify(was) === JSON.stringify(now)) return false;
  await pullBiz(); seenBiz = now; renderAll();
  return true;
}
/* A team member's phone (no live updates): orders, held bills and collections again only when their fingerprint moved */
let seenOrders = null;
export async function pullOrderChanges(){
  if(!store.sbClient || store.sbStatus !== "connected") return false;
  const now = await use("cloud").orderChanges(), was = seenOrders;
  if(was && was.orders === now.orders && was.held === now.held && was.credit === now.credit && was.tables === now.tables) return false;
  await pullOrders(); seenOrders = now; renderAll();
  return true;
}
