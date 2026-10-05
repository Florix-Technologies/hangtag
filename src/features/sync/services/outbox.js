// Upload queue: ordered, retried, never loses work. The rules (one upload per record, order, dependencies, which failures
// go to review) are in domain/sync/queue-rules.js.
import { store } from '../../../shared/state/store.js';
import { canDiscard, failureAction, isBlocked, mergeIntoQueue, numberTaken, ORDERED_TYPES, recordKey, uploadAllowed, waitingKeys } from '../../../domain/sync/queue-rules.js';
import { sbSessionOk } from '../../auth/services/auth-settings.js';
import { D, invalidate } from '../../inventory/services/ledger.js';
import { products } from '../../products/services/catalog.js';
import { renderSync } from '../components/sync-status.js';
import { use } from '../../../shared/di/services.js';
import { persistLocal, saveLastSync, saveReturns, saveSbQueue, saveSyncReview } from '../../../shared/state/persistence.js';
import { logger } from '../../../shared/logging/logger.js';
import { toast } from '../../../shared/components/toast.js';
import { ACCESS_LOST_TEXT, can, denied, isMember, notAllowedText, refreshAccess } from '../../shop/services/access.js';
import { deviceTill, moveTillAfterConflict, nextNumber, numberingFor } from '../../sales/services/doc-numbers.js';
import { parseDocNo } from '../../../domain/documents/numbering.js';
import { requestSignOut } from '../../../shared/ui/session-actions.js';
import { orderRepository } from '../../orders/repositories/order-repository.js';
import { purchaseItemOff, purchaseItemOn } from '../../inventory/services/purchase-state.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';

/* Add work for the cloud; identical product uploads are merged so the queue stays short */

export function enqueue(item){
  // A team member's change its role can't upload: the use case should have refused it before changing anything. One that
  // gets here anyway isn't sent (the database would refuse it on every retry) nor lost: it goes to the sync review with
  // the reason, where it can be discarded (never a bill)
  if(!uploadAllowed(item,can)){
    logger.warn("Not uploaded (the role can't upload it):",item.type);
    const it={...item,tries:0,err:notAllowedText("upload this")};
    toReview(it,{code:"PERMISSION"}); toast(it.err+" It's in the sync review."); renderSync(); return;
  }
  if(item.type==="prod"){
    const ex=store.sbOfflineQueue.find(q=>q.type==="prod"&&q.id===item.id&&!q.tries);
    if(ex){ex.delV=[...new Set([...(ex.delV||[]),...(item.delV||[])])];saveSbQueue();return}
  }
  // one waiting upload of the settings / logo is enough (it sends the latest value) — but not one already uploading:
  // that one may have read the old value, so a change made meanwhile gets its own upload
  if((item.type==="settings"||item.type==="logo")&&store.sbOfflineQueue.some(q=>q.type===item.type&&!q.tries&&!q.sending)){return}
  if(item.type==="docimg"&&store.sbOfflineQueue.some(q=>q.type==="docimg"&&q.kind===item.kind&&!q.tries&&!q.sending)){return}
  if(item.type==="autolog"&&store.sbOfflineQueue.some(q=>q.type==="autolog"&&!q.tries&&!q.sending)){return}   // one upload carries the whole log
  // one waiting upload per record (a bill, return, customer, move, event…): a later change replaces it where it stands
  store.sbOfflineQueue=mergeIntoQueue(store.sbOfflineQueue,item);saveSbQueue();
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
    await cloud.setSaleVoid(item.id, item.isVoid, item.reason);
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
  } else if(item.type === "event"){
    await cloud.saveEvent(item.ev);
  } else if(item.type === "eventdel"){
    await cloud.deleteEvent(item.id);
  } else if(item.type === "cashmove"){
    await cloud.saveCashMove(item.move);
  } else if(item.type === "dayclose"){
    await cloud.saveDayClose(item.close);
  } else if(item.type === "settings"){
    await cloud.saveSettings(store.settings);
  } else if(item.type === "logo"){
    await cloud.saveLogo(store.logo || "");
  } else if(item.type === "autolog"){
    await cloud.saveAutomationLog(store.dev, (store.autoLog || []).filter(e => e.dev === store.dev));
  } else if(item.type === "docimg"){
    await cloud.saveDocImage(item.kind, (store.docImages || {})[item.kind] || "");
  } else if(item.type === "allsales"){
    await cloud.saveAllSales(D().sales);
  } else if(item.type === "collection"){
    await cloud.saveCollection(item.col);
  } else if(item.type === "held"){
    await cloud.saveHeldCart(item.held);
  } else if(item.type === "helddel"){
    await cloud.deleteHeldCart(item.id);
  } else if(item.type === "order"){
    // the order as it is now, on the version this device last saw; the cloud's new version is kept for the next save
    const o = orderRepository().get(item.id);
    if(o){ const r = await cloud.saveOrder(o); orderRepository().saved(o.id, r.version); }
  } else if(item.type === "supplier"){
    await cloud.saveSupplier(item.sup);
  } else if(item.type === "purchase"){
    await cloud.savePurchase(item.purchase, item.moves);
  } else if(item.type === "pcancel"){
    await cloud.cancelPurchase(item.id, item.reason, item.dev, item.t);
  } else if(item.type === "spay"){
    await cloud.saveSupplierPayment(item.pay);
  } else if(item.type === "table"){
    await cloud.saveTable(item.table);
  } else if(item.type === "tsession"){
    await cloud.saveTableSession(item.session);
  } else if(item.type === "ostatus"){
    // a table order moved along by the kitchen: the cloud's new version is kept for this device's next save of it
    const r = await cloud.setOrderStatus(item.id, item.status);
    if(r.version) orderRepository().saved(item.id, r.version);
  } else if(item.type === "biz"){
    // the commerce batch (section 3r): the record as it is now; a purchase order keeps the version the cloud now holds
    const rec = bizRepository().get(item.kind, item.id);
    if(rec){ const r = await cloud.saveBiz(item.kind, rec); if(r && r.version) bizRepository().saved(item.kind, item.id, r.version); }
  } else if(item.type === "bizdel"){
    await cloud.deleteBiz(item.kind, item.id);
  } else if(item.type === "catdel"){
    // left over from the old size-only version: nothing to do with the new tables
  }
}
// Items that later work depends on: stop at the first failure so order is kept (domain/sync/queue-rules.js).
export const ORDERED = new Set(ORDERED_TYPES);

/* A refused upload goes to the review list with its reason. A refused return is taken off this device's stock and books
   until it is sent again (the database didn't accept it); a refused bill stays: a completed sale is never undone. */
function toReview(item, err){
  store.syncReview = [...(store.syncReview||[]), { item, err: item.err, code: err && err.code || "", t: Date.now() }];
  saveSyncReview();
  if(item.type === "return" && item.ret && store.returnsMap[item.ret.id]){ delete store.returnsMap[item.ret.id]; saveReturns(); invalidate(); }
  purchaseItemOff(item);   // a purchase, its cancel or a supplier payment: off this device's stock and books too
}
/* One pass over the queue; passes repeat while an upload unblocks items waiting for it */
export async function flushSbQueueOnce(){
  if(!store.sbClient || store.sbStatus !== "connected" || !store.sbOfflineQueue.length) return;
  if(!(await sbSessionOk())) return;   // keep everything queued until signed in again
  store.syncing = true; renderSync();
  const done = new Set(), review = new Set();
  let again = true, stopped = false;
  while(again && !stopped){
    again = false;
    let skipped = 0, sentNow = 0;
    const waiting = waitingKeys(store.sbOfflineQueue, store.syncReview, new Set([...done, ...review]));
    for(const item of [...store.sbOfflineQueue]){
      if(done.has(item) || review.has(item)) continue;
      if(isBlocked(item, waiting)){ skipped++; continue; }   // its bill / product is still on its way (or under review)
      item.sending = true;
      try{ await sendItem(item); done.add(item); sentNow++; const k = recordKey(item); if(k) waiting.delete(k); }
      catch(err){
        logger.warn("Queue sync item failed:", item.type, err);
        item.tries = (item.tries||0) + 1; item.err = err && (err.message || err.code) || String(err);
        const member = isMember(), refused = err && err.code === "PERMISSION";
        if(member && refused){
          // Is this phone still in the shop? If not (revoked, switched off): sign out; the work stays queued for the member
          const a = await refreshAccess();
          if(a.lost){ stopped = true; requestSignOut({ message: ACCESS_LOST_TEXT, forgetDevice: true }); break; }
          if(!a.ok){ stopped = ORDERED.has(item.type); if(stopped) break; continue; }
          item.err = notAllowedText("upload this");
        }
        if(failureAction(err && err.code, item.tries, { member }) === "review"){ review.add(item); toReview(item, err); if(member && refused) toast(item.err + " It's in the sync review."); continue; }
        if(ORDERED.has(item.type)){ stopped = true; break; }
      }
      finally{ delete item.sending; }
    }
    again = skipped > 0 && sentNow > 0;
  }
  store.sbOfflineQueue = store.sbOfflineQueue.filter(x => !done.has(x) && !review.has(x));
  saveSbQueue();
  store.syncing = false;
  markSynced();
  renderSync();
}
/* Review list: send a refused upload again (it goes to the end of the queue; a return comes back onto this device) */
export function retryReview(index){
  const r = (store.syncReview||[])[index]; if(!r) return false;
  store.syncReview = store.syncReview.filter((_, i) => i !== index); saveSyncReview();
  const item = { ...r.item, tries: 0 }; delete item.err;
  if(item.type === "return" && item.ret){ store.returnsMap[item.ret.id] = item.ret; saveReturns(); invalidate(); }
  purchaseItemOn(item);
  enqueue(item); renderSync(); flushSbQueue();
  return true;
}
/* Review list: give up on a refused upload (never a bill). The record stays out of this device's data. */
export function discardReview(index){
  const r = (store.syncReview||[])[index]; if(!r || !canDiscard(r.item)) return false;
  store.syncReview = store.syncReview.filter((_, i) => i !== index); saveSyncReview();
  renderSync();
  return true;
}
/* Review list: a bill or return refused because another one of the shop already has its number (two devices that took the
   same series before either saw the other's documents, a reinstall…) gets a new number and is sent again. When the clash
   is in this device's own series and the number's holder is another device's document (or one this device hasn't seen),
   the device first moves to a series no other device uses (a till letter), so it can't happen again; a clash with this
   device's own document only takes the next number of its series. The old number was never saved in the cloud.
   → { ok, no } or { error }. A team member needs the right to make that record. */
export function renumberReview(index){
  const r = (store.syncReview||[])[index]; if(!numberTaken(r)) return { error: "This one isn't waiting for a new number." };
  const sale = r.item.type === "sale", no = denied(sale ? "create_sale" : "perform_return", sale ? "renumber bills" : "renumber returns"); if(no) return no;
  let fresh;
  const type = sale ? "invoice" : "credit", rec = sale ? r.item.sale : r.item.ret, was = parseDocNo(rec.no, numberingFor(type));
  const holder = (sale ? D().sales : D().rets).find(x => x.no === rec.no && x.id !== rec.id);
  if(was && was.till === deviceTill() && !(holder && holder.dev === store.dev)) moveTillAfterConflict();
  if(sale){
    const id = r.item.sale.id; fresh = nextNumber("invoice", D().sales, r.item.sale.t, { claim: true });
    // the bill as kept in its day on this device (D() hands out copies)
    Object.values(store.localDays).forEach(d => (d.sales||[]).forEach(s => { if(s.id === id) s.no = fresh; }));
    if(store.lastSale && store.lastSale.id === id) store.lastSale.no = fresh;
    r.item.sale = { ...r.item.sale, no: fresh };
    persistLocal(); invalidate();
  } else {
    // the refused return is off this device's returns until sent again: count its number too, so the next one is past it
    fresh = nextNumber("credit", [...D().rets, r.item.ret], r.item.ret.t, { claim: true }); r.item.ret = { ...r.item.ret, no: fresh };
  }
  saveSyncReview(); retryReview(index);
  return { ok: true, no: fresh };
}
