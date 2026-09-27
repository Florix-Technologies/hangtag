// Upload queue: ordered, retried, never loses work.
import { store } from '../../../shared/state/store.js';
import { sbSessionOk } from '../../auth/services/auth-settings.js';
import { D } from '../../inventory/services/ledger.js';
import { products } from '../../products/services/catalog.js';
import { renderSync } from '../components/sync-status.js';
import { use } from '../../../shared/di/services.js';
import { saveLastSync, saveSbQueue } from '../../../shared/state/persistence.js';
import { logger } from '../../../shared/logging/logger.js';

/* Add work for the cloud; identical product uploads are merged so the queue stays short */

export function enqueue(item){
  if(item.type==="prod"){
    const ex=store.sbOfflineQueue.find(q=>q.type==="prod"&&q.id===item.id&&!q.tries);
    if(ex){ex.delV=[...new Set([...(ex.delV||[]),...(item.delV||[])])];saveSbQueue();return}
  }
  if(item.type==="settings"&&store.sbOfflineQueue.some(q=>q.type==="settings"&&!q.tries)){return}
  store.sbOfflineQueue.push(item);saveSbQueue();
}
/* Take queued changes out before they upload (e.g. a product deleted before its changes were sent) */
export function dropQueued(pred){ store.sbOfflineQueue=store.sbOfflineQueue.filter(q=>!pred(q)); saveSbQueue(); }
/* Nothing left to upload: remember when this device was last fully in step with the cloud */
export function markSynced(){ if(!store.sbOfflineQueue.length){ store.lastSyncAt = Date.now(); saveLastSync(); } }
export function flushSbQueue(){
  if(store.sbFlushP){ store.sbFlushAgain = true; return store.sbFlushP; }
  store.sbFlushP = (async () => { do{ store.sbFlushAgain = false; await flushSbQueueOnce(); } while(store.sbFlushAgain); })()
    .finally(() => { store.sbFlushP = null; });
  return store.sbFlushP;
}
/* Send one queued change to the cloud (throws if it couldn't be saved, so the queue keeps it) */
export async function sendItem(item){
  const cloud = use("cloud");
  if(item.type === "sale"){
    await cloud.saveSale(item.sale);
  } else if(item.type === "void"){
    await cloud.setSaleVoid(item.id, item.isVoid);
  } else if(item.type === "prod"){
    const i = products().findIndex(p=>p.id===item.id);
    if(i > -1) await cloud.saveProduct(products()[i], i);
    const del = (item.delV||[]).filter(id=>!(i>-1 && products()[i].variants.some(v=>v.id===id)));
    if(del.length) await cloud.deleteVariants(del);
  } else if(item.type === "proddel"){
    await cloud.deleteProduct(item.id);
  } else if(item.type === "img"){
    await cloud.saveImage(item.id, store.imgs[item.id]);
  } else if(item.type === "move"){
    await cloud.saveMove(item.move);
  } else if(item.type === "return"){
    await cloud.saveReturn(item.ret);
  } else if(item.type === "cust"){
    await cloud.saveCustomer(item.cust);
  } else if(item.type === "settings"){
    await cloud.saveSettings(store.settings);
  } else if(item.type === "allsales"){
    await cloud.saveAllSales(D().sales);
  } else if(item.type === "catdel"){
    // left over from the old size-only version: nothing to do with the new tables
  }
}
// Items that later work depends on: stop at the first failure so order is kept.
// A return isn't here: nothing depends on it, so one the database refuses (already returned on
// another device) waits with its error while later bills keep uploading.

export const ORDERED = new Set(["sale","prod","allsales"]);
export async function flushSbQueueOnce(){
  if(!store.sbClient || store.sbStatus !== "connected" || !store.sbOfflineQueue.length) return;
  if(!(await sbSessionOk())) return;   // keep everything queued until signed in again
  store.syncing = true; renderSync();
  const queue = [...store.sbOfflineQueue], done = new Set();
  for(const item of queue){
    try{ await sendItem(item); done.add(item); }
    catch(err){
      logger.warn("Queue sync item failed:", item.type, err);
      item.tries = (item.tries||0) + 1; item.err = err && (err.message || err.code) || String(err);
      if(ORDERED.has(item.type)) break;
    }
  }
  store.sbOfflineQueue = store.sbOfflineQueue.filter(x => !done.has(x));
  saveSbQueue();
  store.syncing = false;
  markSynced();
  renderSync();
}
