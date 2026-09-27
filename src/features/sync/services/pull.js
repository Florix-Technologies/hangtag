// Downloads cloud data (keeping unsent local changes) and pushes everything.
import { finishDownloadedProduct } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { DEFAULT_SETTINGS } from '../../../domain/shop/settings.js';
import { sbSessionOk } from '../../auth/services/auth-settings.js';
import { products } from '../../products/services/catalog.js';
import { renderSync } from '../components/sync-status.js';
import { enqueue, flushSbQueue, markSynced } from './outbox.js';
import { use } from '../../../shared/di/services.js';
import { toast } from '../../../shared/components/toast.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { saveCatalog, saveCustomers, saveImgs, saveMoves, saveReturns, saveSettings } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { logger } from '../../../shared/logging/logger.js';

/* ---------- pulls (cloud is the truth, except for work still waiting in this device's queue) ---------- */

export const pendingIds = type => new Set(store.sbOfflineQueue.filter(q=>q.type===type).map(q=>q.id || (q.move&&q.move.id) || (q.ret&&q.ret.id) || (q.cust&&q.cust.id)));
export async function pullCatalogFromSupabase(remoteIsTruth = false){
  if(!store.sbClient || !(await sbSessionOk())) return;
  try{
    const cloud = use("cloud");
    const prods = await cloud.fetchProducts();
    if(!prods.length && !products().length) return;
    const vars = await cloud.fetchVariants();
    const images = await cloud.fetchImages();
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
    if((images && images.length) || remoteIsTruth){
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
  list.forEach(m => { next[m.id] = m; });
  Object.values(store.moves).forEach(m => { if(pending.has(m.id)) next[m.id] = m; });
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
export async function pullSettings(){
  if(store.sbOfflineQueue.some(q=>q.type==="settings")) return;
  const value = await use("cloud").fetchSettings();
  if(value && typeof value === "object"){ store.settings = Object.assign({}, DEFAULT_SETTINGS, value); saveSettings(); }
}
export async function pullFromSupabase(showToast = true){
  if(!store.sbClient || store.sbStatus !== "connected" || !(await sbSessionOk())) return;
  store.syncing = true; renderSync();
  try{
    await pullCatalogFromSupabase();
    await pullMoves();
    await pullReturns();
    await pullCustomers();
    await pullSettings();
    const sales = await use("cloud").fetchSales();
    const newRemoteDays = {};
    sales.forEach(s => {
      const d = dayKey(s.t), devId = s.dev || "cloud", dayId = `${d}_${devId}_0`;
      if(!newRemoteDays[dayId]) newRemoteDays[dayId] = { date: d, dev: devId, chunk: 0, sales: [], voids: [] };
      newRemoteDays[dayId].sales.push(s);
      if(s.void) newRemoteDays[dayId].voids.push(s.id);
    });
    store.remoteDays = newRemoteDays;
    markSynced();
    renderAll();
    if(showToast) toast("Everything is up to date.");
  }catch(e){
    logger.error("Pull from Supabase failed:", e);
    if(showToast) toast("Couldn't refresh from the cloud. Your work is saved on this device.");
  }finally{ store.syncing = false; renderSync(); }
}
/* Upload everything this device has (after a restore, or loading examples). Uses the same queue as everyday work. */

export async function pushLocalToSupabase(){
  products().forEach(p => enqueue({ type:"prod", id:p.id }));
  Object.keys(store.imgs).forEach(id => enqueue({ type:"img", id }));
  Object.values(store.moves).forEach(m => enqueue({ type:"move", id:m.id, move:m }));
  Object.values(store.customers).forEach(c => enqueue({ type:"cust", id:c.id, cust:c }));
  enqueue({ type:"allsales" });
  Object.values(store.returnsMap).forEach(r => enqueue({ type:"return", id:r.id, ret:r }));
  enqueue({ type:"settings" });
  renderSync();
  if(!store.sbClient || store.sbStatus !== "connected" || !(await sbSessionOk())){ toast("Saved on this device. It will upload when you're online."); return false; }
  await flushSbQueue();
  const left = store.sbOfflineQueue.length;
  toast(left ? "Some changes are still uploading." : "Everything is uploaded to the cloud.");
  return !left;
}
