// Connects to the cloud database and live updates.
import { store } from '../../../shared/state/store.js';
import { sbSessionOk } from '../../auth/services/auth-settings.js';
import { renderSync } from '../components/sync-status.js';
import { flushSbQueue } from './outbox.js';
import { forgetShopChanges, pullBizChanges, pullFromSupabase, pullOrderChanges, pullShopChanges } from './pull.js';
import { debouncePull, mergeRemoteItems, onRemoteCatalogEvent, onRemoteImageEvent, onRemoteMoveEvent, onRemoteSaleEvent } from './remote-events.js';
import { sbKey, sbUrl } from '../../../shared/config/app-config.js';
import { use } from '../../../shared/di/services.js';
import { ERROR_CODES, userMessage } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';
import { ACCESS_LOST_TEXT, isMember, refreshAccess } from '../../shop/services/access.js';
import { requestSignOut } from '../../../shared/ui/session-actions.js';
import { renderAll } from '../../../shared/ui/render.js';

/* The one Supabase client this app uses (settings from config.js, created by the cloud port) */
export const newSbClient = () => use("cloud").createClient();
export function initSupabase(){
  if(store.sbInitP) return store.sbInitP;
  store.sbInitP = initSupabaseOnce().finally(() => { store.sbInitP = null; });
  return store.sbInitP;
}
export async function initSupabaseOnce(){
  if(!sbUrl || !sbKey || !window.supabase || !store.authUser){
    store.sbStatus = "disconnected"; store.mode = "standalone"; renderSync(); return false;
  }
  store.sbStatus = "connecting"; renderSync();
  try{
    if(!store.sbClient) store.sbClient = newSbClient();
    if(!(await sbSessionOk())){ store.sbStatus = "error"; store.mode = "standalone"; renderSync(); return false; }
    // Quick check that the database has the variant tables (schema.sql has been run)
    const { error } = await use("cloud").checkSchema();
    if(error){
      logger.warn("Supabase check:", error.cause || error);
      const missing = error.code === ERROR_CODES.OUTDATED_DATABASE;
      store.sbStatus = missing ? "update" : "error";
      store.sbErrorText = missing ? "" : error.message;
      store.mode = "standalone"; renderSync(); return false;
    }
    store.sbStatus = "connected"; store.mode = "online"; renderSync();
    if(isMember()){
      // A team member: is this phone still in the shop (and "last seen" now)? Its role may have changed too.
      // No live updates for a member's phone (realtime can't carry the device key): it asks every 30 s (memberPoll).
      const a = await refreshAccess();
      if(a.lost){ accessLost(); return false; }
      renderAll();
    } else setupSupabaseRealtime();
    // Send queued offline work first (bills, stock, returns, product changes), then pull the latest
    await flushSbQueue();
    await pullFromSupabase(false);
    connectedHooks.forEach(f => { try{ Promise.resolve(f()).catch(e => logger.warn("After connecting:", e)); }catch(e){ logger.warn("After connecting:", e); } });
    return true;
  }catch(e){
    logger.event("sync", "connect-failed", { code: e && e.code });
    store.sbStatus = "error"; store.sbErrorText = userMessage(e, "Unexpected error."); store.mode = "standalone"; renderSync(); return false;
  }
}
/* A team member's phone no longer reaches its shop (revoked, switched off): sign out and say so. Its unsent work stays
   with the member's data on this phone. */
export function accessLost(){ requestSignOut({ message: ACCESS_LOST_TEXT, forgetDevice: true }); }
/* Every 30 s on a member's phone (app/main.js): still in the shop (and the role now)? then only what changed in the shop
   (pull.js pullShopChanges: small fingerprints, then just those parts; never the whole shop). A database without
   hangtag_shop_changes yet (schema.sql not run again): the whole download, at most every 5 minutes. */
let polling = false, lastFull = 0;
export async function memberPoll(){
  if(polling || !isMember() || store.sbStatus !== "connected") return;
  polling = true;
  try{
    const a = await refreshAccess();
    if(a.lost){ accessLost(); return; }
    if(!a.ok) return;
    try{ await pullShopChanges(); await pullOrderChanges().catch(e => logger.warn("Orders:", e)); await pullBizChanges().catch(e => logger.warn("Price lists, purchase orders:", e)); }
    catch(e){
      // the database doesn't have hangtag_shop_changes yet: the whole download, at most every 5 minutes (anything else,
      // e.g. a dropped connection, is simply tried again at the next check)
      if(!(e && e.code === ERROR_CODES.OUTDATED_DATABASE)){ logger.warn("What changed:", e); return; }
      if(Date.now() - lastFull > 300000){ lastFull = Date.now(); forgetShopChanges(); await pullFromSupabase(false); }
    }
  }catch(e){ logger.warn("Member refresh:", e); }
  finally{ polling = false; }
}
/* Work that needs the cloud and runs each time the app connects (registered by app/main.js): open provider payments,
   hand-checked UPI to verify, receipts waiting to be sent */
export const connectedHooks = [];
export const onConnected = f => { connectedHooks.push(f); };
/* Registered once at start-up (app/main.js): while connected, work still queued (e.g. waiting on another upload, or after
   a server error) is tried again every 30 seconds, without waiting for the next change */
export function installSyncRetryTimer(){
  setInterval(()=>{ if(store.sbStatus==="connected" && store.sbOfflineQueue.length && !store.sbFlushP) flushSbQueue(); }, 30000);
}
export function setupSupabaseRealtime(){
  if(!store.sbClient) return;
  try{
    const cloud = use("cloud");
    if(store.sbRealtimeChannel) cloud.removeChannel(store.sbRealtimeChannel);
    store.sbRealtimeChannel = cloud.subscribe({
      sale: onRemoteSaleEvent,
      saleLine: p=>{ if(p.new) mergeRemoteItems(p.new.sale_id,[p.new]); },
      catalog: onRemoteCatalogEvent,
      image: onRemoteImageEvent,
      move: onRemoteMoveEvent,
      returns: ()=>debouncePull("returns"),
      customers: ()=>debouncePull("customers"),
      settings: ()=>debouncePull("settings"),
      events: ()=>debouncePull("events"),
      orders: ()=>debouncePull("orders"),
      held: ()=>debouncePull("orders"),
      collections: ()=>debouncePull("orders"),
      tables: ()=>debouncePull("orders"),
      biz: ()=>debouncePull("biz"),
    }, (status)=>{ if(status === "SUBSCRIBED" && store.sbStatus !== "update"){ store.sbStatus = "connected"; renderSync(); } });
  }catch(e){ logger.warn("Realtime subscription notice:", e); }
}
