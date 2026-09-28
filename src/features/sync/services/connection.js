// Connects to the cloud database and live updates.
import { store } from '../../../shared/state/store.js';
import { sbSessionOk } from '../../auth/services/auth-settings.js';
import { renderSync } from '../components/sync-status.js';
import { flushSbQueue } from './outbox.js';
import { pullFromSupabase } from './pull.js';
import { debouncePull, mergeRemoteItems, onRemoteCatalogEvent, onRemoteImageEvent, onRemoteMoveEvent, onRemoteSaleEvent } from './remote-events.js';
import { sbKey, sbUrl } from '../../../shared/config/app-config.js';
import { use } from '../../../shared/di/services.js';
import { ERROR_CODES, userMessage } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';

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
    setupSupabaseRealtime();
    // Send queued offline work first (bills, stock, returns, product changes), then pull the latest
    await flushSbQueue();
    await pullFromSupabase(false);
    return true;
  }catch(e){
    logger.error("Failed to connect to Supabase:", e);
    store.sbStatus = "error"; store.sbErrorText = userMessage(e, "Unexpected error."); store.mode = "standalone"; renderSync(); return false;
  }
}
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
    }, (status)=>{ if(status === "SUBSCRIBED" && store.sbStatus !== "update"){ store.sbStatus = "connected"; renderSync(); } });
  }catch(e){ logger.warn("Realtime subscription notice:", e); }
}
