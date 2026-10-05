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
import { can, isMember } from '../../shop/services/access.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';

/* ---------- pulls (cloud is the truth, except for work still waiting in this device's queue) ---------- */
let seen = null;   // a member's phone: the shop's fingerprints its data matches (null: not known yet; see pullShopChanges)
let seenPurchases = null;   // …and the fingerprint of its suppliers, purchases and supplier payments (hangtag_purchase_changes)

export const pendingIds = type => new Set(store.sbOfflineQueue.filter(q=>q.type===type).map(q=>q.id || (q.move&&q.move.id) || (q.ret&&q.ret.id) || (q.cust&&q.cust.id) || (q.ev&&q.ev.id)));
/* opts.images: false = leave the photos as they are (a member's phone downloads them only when they changed) */
export async function pullCatalogFromSupabase(remoteIsTruth = false, opts = {}){
  if(!store.sbClient || !(await sbSessionOk())) return;
  try{
    const cloud = use("cloud");
    const prods = await cloud.fetchProducts();
    if(!prods.length && !products().length) return;
    const vars = await cloud.fetchVariants();
    const images = opts.images === false ? null : await cloud.fetchImages();
    if(prods.length > 0 || remoteIsTruth){
      const pending = pendingIds("prod"), local = {};
      products().forEach(p=>{ local[p.id]=p; });
      const pMap = {}, order = [];
      prods.forEach(p => { pMap[p.id] = p; order.push(p.id); });
      vars.forEach(({ productId, variant }) => { if(pMap[productId]) pMap[productId].variants.push(variant); });
      // A product changed on this device and not uploaded yet stays as it is here
      pending.forEach(id => { if(local[id]){ if(!pMap[id]) order.push(id); pMap[id] = local[id]; } });
      store.catalog = { version:3, example:false, products: order.map(id=>pMap[id]).filter(Boolean).map(finishDownloadedProduct) };
      saveCatalog();
    }
    if((images && images.length) || (remoteIsTruth && opts.images !== false)){
      const imgMap = {};
      (images||[]).forEach(im => { imgMap[im.productId] = im.data; });
      store.sbOfflineQueue.filter(q=>q.type==="img").forEach(q=>{ if(store.imgs[q.id]) imgMap[q.id]=store.imgs[q.id]; else delete imgMap[q.id]; });
      store.imgs = imgMap; saveImgs();
    }
  }catch(e){ logger.error("Error pulling catalog:", e); }
}
export async function pullMoves(){
  const list = await use("cloud").fetchMoves();
  const pending = pendingIds("move"), next = {};
  // the stock records of a purchase (or its cancel) still on its way go up with it, so they stay too
  const withPurchase = new Set([...pendingIds("purchase"), ...pendingIds("pcancel")]);
  // …and so do a repack's two records (rpk:<id>:out / :in) while the repack is on its way
  const repacks = new Set(store.sbOfflineQueue.filter(q => q.type === "biz" && q.kind === "rpk").map(q => q.id));
  list.forEach(m => { next[m.id] = m; });
  Object.values(store.moves).forEach(m => { const rk = /^rpk:(.+):(out|in)$/.exec(m.id);
    if(pending.has(m.id) || (m.imp && withPurchase.has(m.imp)) || (rk && repacks.has(rk[1]))) next[m.id] = m; });
  store.moves = next; saveMoves();
}
export async function pullReturns(){
  const list = await use("cloud").fetchReturns();
  const pending = pendingIds("return"), next = {};
  list.forEach(r => { next[r.id] = r; });
  Object.values(store.returnsMap).forEach(r => { if(pending.has(r.id)) next[r.id] = r; });
  store.returnsMap = next; saveReturns();
}
export async function pullCustomers(){
  const list = await use("cloud").fetchCustomers();
  const pending = pendingIds("cust"), next = {};
  list.forEach(c => { next[c.id] = c; });
  Object.values(store.customers).forEach(c => { if(pending.has(c.id)) next[c.id] = c; });
  store.customers = next; saveCustomers();
}
/* Events: the cloud's list, except events changed or deleted on this device and not uploaded yet */
/* Cash entries and day closes from every device of the shop (entries waiting to upload stay as they are) */
export async function pullCash(){
  const cloud = use("cloud");
  const [moves, closes] = await Promise.all([cloud.fetchCashMoves(), cloud.fetchDayCloses()]);
  const pm = pendingIds("cashmove"), pc = pendingIds("dayclose"), M = {}, C = {};
  moves.forEach(m => { M[m.id] = m; }); Object.values(store.cashMoves || {}).forEach(m => { if(pm.has(m.id) || !M[m.id]) M[m.id] = m; });
  closes.forEach(c => { C[c.id] = c; }); Object.values(store.dayCloses || {}).forEach(c => { if(pc.has(c.id)) C[c.id] = c; });
  store.cashMoves = M; saveCashMoves(); store.dayCloses = C; saveDayCloses();
}
export async function pullEvents(){
  const list = await use("cloud").fetchEvents();
  const pending = pendingIds("event"), deleted = pendingIds("eventdel"), next = {};
  list.forEach(e => { if(!deleted.has(e.id)) next[e.id] = e; });
  Object.values(store.events || {}).forEach(e => { if(pending.has(e.id)) next[e.id] = e; });
  store.events = next; saveEvents();
}
/* Suppliers, purchases and later payments to suppliers (section 3l) from every device of the shop; those still waiting to
   upload from this device stay as they are. An older database (schema.sql not re-run yet) or a failed download leaves this
   device's copy alone → false */
export async function pullPurchases(){
  const cloud = use("cloud");
  let sups, purs, pays;
  try{ [sups, purs, pays] = await Promise.all([cloud.fetchSuppliers(), cloud.fetchPurchases(), cloud.fetchSupplierPayments()]); }
  catch(e){ logger.warn("Suppliers and purchases not downloaded:", e); return false; }
  const ps = pendingIds("supplier"), pp = new Set([...pendingIds("purchase"), ...pendingIds("pcancel")]), px = pendingIds("spay"), S = {}, P = {}, X = {};
  sups.forEach(s => { S[s.id] = s; }); Object.values(store.suppliers || {}).forEach(s => { if(ps.has(s.id)) S[s.id] = s; });
  purs.forEach(p => { P[p.id] = p; }); Object.values(store.purchases || {}).forEach(p => { if(pp.has(p.id)) P[p.id] = p; });
  pays.forEach(x => { X[x.id] = x; }); Object.values(store.supplierPays || {}).forEach(x => { if(px.has(x.id)) X[x.id] = x; });
  store.suppliers = S; saveSuppliers(); store.purchases = P; savePurchases(); store.supplierPays = X; saveSupplierPays();
  return true;
}
/* Settings and the receipt logo (both kept in hangtag_meta; a change still waiting to upload wins — also one made while
   the download was on its way) */
export async function pullSettings(){
  const waiting = type => store.sbOfflineQueue.some(q=>q.type===type);
  if(!waiting("settings")){
    const value = await use("cloud").fetchSettings();
    // the capability choices changed last win: a copy uploaded by a phone that was behind never undoes newer ones here
    if(value && typeof value === "object" && !waiting("settings")){ store.settings = Object.assign({}, DEFAULT_SETTINGS, keepNewerCaps(value, store.settings)); saveSettings(); }
  }
  if(!waiting("logo")){
    const logo = await use("cloud").fetchLogo();
    if(!waiting("logo")){ store.logo = logo; saveLogo(); }
  }
  // the signature and stamp: the cloud's copy, unless this device is still sending its own
  if(!waiting("docimg")){
    const im = await use("cloud").fetchDocImages();
    if(!waiting("docimg")){ store.docImages = im; saveDocImages(); }
  }
  // the automation log of every device (Settings → Automation), with this device's own
  try{ const log = await use("cloud").fetchAutomationLogs(); store.autoLog = mergeLogs(store.autoLog || [], log); saveAutoLog(); }
  catch(e){ logger.warn("Automation log:", e); }
}
export async function pullFromSupabase(showToast = true){
  if(!store.sbClient || store.sbStatus !== "connected" || !(await sbSessionOk())) return;
  store.syncing = true; renderSync();
  try{
    // a member's phone notes where the shop stands first, so its next look (every 30 s) fetches only what changed after
    const marks = isMember() ? await use("cloud").shopChanges().catch(() => null) : null;
    const pmarks = isMember() ? await use("cloud").purchaseChanges().catch(() => null) : null;
    await pullCatalogFromSupabase();
    await pullMoves();
    await pullReturns();
    await pullCustomers();
    await pullEvents();
    await pullCash();
    // orders, held bills and payments collected (section 3m): a database without them yet doesn't stop the rest
    await pullOrders().catch(e => logger.warn("Orders and credit not downloaded:", e));
    await pullPurchases();
    // price lists, purchase orders, GST readiness, repacks, vouchers (section 3r): a database without them keeps this device's copy
    await pullBiz().catch(e => logger.warn("Price lists, purchase orders and vouchers not downloaded:", e));
    await pullSettings();
    await pullSales();
    if(isMember()){ seen = marks; seenPurchases = pmarks; }
    markSynced();
    renderAll();
    if(showToast) toast("Everything is up to date.");
  }catch(e){
    logger.error("Pull from Supabase failed:", e);
    if(showToast) toast("Couldn't refresh from the cloud. Your work is saved on this device.");
  }finally{ store.syncing = false; renderSync(); }
}
/* Every bill of the shop (with lines and payments), grouped by day and device as the ledger reads them */
export async function pullSales(){
  const sales = await use("cloud").fetchSales();
  const newRemoteDays = {};
  sales.forEach(s => addRemoteSale(newRemoteDays, s));
  store.remoteDays = newRemoteDays;
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
/* → the parts downloaded (e.g. ["sales","customers"]); [] when nothing changed */
export async function pullShopChanges(){
  if(!store.sbClient || store.sbStatus !== "connected" || !(await sbSessionOk())) return [];
  const cloud = use("cloud");
  const now = await cloud.shopChanges();
  if(!seen){ await pullFromSupabase(false); return ["all"]; }   // not known what this phone's copy matches: once, everything
  const was = seen, parts = ["catalog", "images", "moves", "returns", "customers", "events", "cash", "settings", "sales"].filter(k => now[k] !== was[k]);
  const pnow = await cloud.purchaseChanges().catch(() => null);
  if(pnow != null && pnow !== seenPurchases) parts.push("purchases");
  if(!parts.length) return [];
  store.syncing = true; renderSync();
  try{
    if(parts.includes("catalog")) await pullCatalogFromSupabase(false, { images: false });
    if(parts.includes("images")) await pullImages();
    if(parts.includes("moves")) await pullMoves();
    if(parts.includes("returns")) await pullReturns();
    if(parts.includes("customers")) await pullCustomers();
    if(parts.includes("events")) await pullEvents();
    if(parts.includes("cash")) await pullCash();
    if(parts.includes("settings")) await pullSettings();
    if(parts.includes("purchases") && await pullPurchases()) seenPurchases = pnow;
    if(parts.includes("sales")) await pullNewSales(was, now);
    seen = now;
    markSynced();
    renderAll();
  }finally{ store.syncing = false; renderSync(); }
  return parts;
}
/* The shop's photos (only when one changed); a photo still waiting to upload from this phone stays as it is */
export async function pullImages(){
  const images = await use("cloud").fetchImages();
  if(!images) return;
  const imgMap = {};
  images.forEach(im => { imgMap[im.productId] = im.data; });
  store.sbOfflineQueue.filter(q=>q.type==="img").forEach(q=>{ if(store.imgs[q.id]) imgMap[q.id]=store.imgs[q.id]; else delete imgMap[q.id]; });
  store.imgs = imgMap; saveImgs();
}
/* The bills saved since the last look, and which bills are cancelled now. If this phone's copy then doesn't hold as many
   bills as the cloud (a bill removed, a very long upload, 1000 new ones), it downloads them all once. */
async function pullNewSales(was, now){
  const cloud = use("cloud");
  const since = isoMinus(was.sales_since, MARGIN_MS);
  const fresh = since ? await cloud.fetchSalesSince(since) : null;
  if(!fresh || fresh.length >= 1000){ await pullSales(); return; }
  const days = Object.assign({}, store.remoteDays);
  Object.keys(days).forEach(k => { days[k] = Object.assign({}, days[k], { sales: days[k].sales.slice(), voids: (days[k].voids || []).slice() }); });
  fresh.forEach(s => addRemoteSale(days, s));
  if(now.sales_voids !== was.sales_voids){
    const voided = new Map((await cloud.fetchVoidedSales()).map(v => [v.id, v.reason]));
    Object.values(days).forEach(doc => {
      doc.voids = doc.sales.filter(s => voided.has(s.id)).map(s => s.id);
      doc.sales.forEach(s => { s.void = voided.has(s.id); if(s.void && voided.get(s.id)) s.voidReason = voided.get(s.id); else if(!s.void) delete s.voidReason; });
    });
  }
  const held = new Set(); Object.values(days).forEach(doc => doc.sales.forEach(s => held.add(s.id)));
  if(held.size !== +now.sales_count){ await pullSales(); return; }
  store.remoteDays = days;
}

/* Upload everything this device has (after a restore, or loading examples). Uses the same queue as everyday work. */

export async function pushLocalToSupabase(){
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
  const cloud = use("cloud");
  const [orders, held, cols] = await Promise.all([cloud.fetchOrders(), cloud.fetchHeldCarts(), cloud.fetchCollections()]);
  const po = new Set([...pendingIds("order"), ...pendingIds("ostatus")]), ro = reviewIds("order"), ph = pendingIds("held"), pd = pendingIds("helddel"), pc = pendingIds("collection");
  const O = {}, H = {}, C = {};
  orders.forEach(o => { O[o.id] = o; });
  Object.values(store.orders || {}).forEach(o => { if(po.has(o.id) || (!O[o.id] && ro.has(o.id))) O[o.id] = o; });
  // a restaurant's tables and sessions (section 3o): a database without them yet doesn't stop the rest
  await pullTables().catch(e => logger.warn("Tables not downloaded:", e));
  held.forEach(h => { if(!pd.has(h.id)) H[h.id] = h; });
  Object.values(store.heldCarts || {}).forEach(h => { if(ph.has(h.id)) H[h.id] = h; });
  cols.forEach(c => { C[c.id] = c; });
  Object.values(store.collections || {}).forEach(c => { if(pc.has(c.id) || !C[c.id]) C[c.id] = c; });
  store.orders = O; saveOrders(); store.heldCarts = H; saveHeldCarts(); store.collections = C; saveCollections();
}
/* A restaurant's tables and the sessions going on (and those closed lately), except what this device hasn't uploaded yet */
export async function pullTables(){
  const cloud = use("cloud");
  const [tables, sessions] = await Promise.all([cloud.fetchTables(), cloud.fetchTableSessions()]);
  const pt = pendingIds("table"), ps = pendingIds("tsession"), T = {}, S = {};
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
  const got = await use("cloud").fetchBiz();
  const waiting = kind => new Set([...store.sbOfflineQueue, ...(store.syncReview || []).map(r => r.item)].filter(q => q && (q.type === "biz" || q.type === "bizdel") && q.kind === kind).map(q => q.id));
  Object.entries(got || {}).forEach(([kind, list]) => {
    if(!Array.isArray(list)) return;
    const keep = waiting(kind), next = {};
    list.forEach(r => { next[r.id] = r; });
    bizRepository().list(kind).forEach(r => { if(keep.has(r.id)) next[r.id] = r; });
    // a repack waiting to upload keeps its stock records here (pullMoves keeps them too)
    bizRepository().replace(kind, next);
  });
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
