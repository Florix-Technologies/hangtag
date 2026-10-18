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
import { catchUpConnected, onRealtimeStatus, resetRealtimeCatchUp } from './catch-up.js';
import { createRetryBackoff } from './retry-backoff.js';
import { aggregateDownloadFailure, downloadFailed, downloadRecovered, failedParts, isReportedDownloadFailure, pullPart } from './download-health.js';

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
    // everything is here: the next catch-up (catch-up.js) counts from now — only when the download got through (connected
    // while the network was gone, it didn't: the next reason, e.g. back online, catches up at once)
    if(await pullFromSupabase(false)){
      catchUpConnected();
      if(isMember()) memberPollConnected();
    }
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
/* A member has no realtime channel. The existing 30-second app timer asks this scheduler to look, but a failed download
   backs off (1, 2, 4, then 5 minutes) instead of filling Diagnostics. Online/foreground are evidence that conditions
   changed, so they bypass the delay. They still share one flight and request at most one follow-up if one is running. */
const IMMEDIATE_MEMBER_REASONS = new Set(["online", "foreground"]);
export function createMemberPoller(deps){
  const retry = createRetryBackoff({ now: deps.now });
  let inFlight = null, again = false;
  const run = () => {
    const p = (async () => {
      do{
        again = false;
        let ok = false, error = null;
        try{ ok = (await deps.check()) !== false; }catch(e){ error = e; }
        if(ok) retry.succeeded();
        else{
          retry.failed();
          if(error && !(deps.isReported && deps.isReported(error))) deps.warn(error);
        }
      }while(again && deps.eligible());
      return true;
    })().finally(() => { if(inFlight === p) inFlight = null; });
    inFlight = p;
    return p;
  };
  return {
    poll(reason = "poll"){
      if(!deps.eligible()) return Promise.resolve(false);
      const immediate = IMMEDIATE_MEMBER_REASONS.has(reason);
      if(inFlight){ if(immediate) again = true; return inFlight; }
      if(!retry.canTry({ immediate })) return Promise.resolve(false);
      return run();
    },
    connected(){ retry.succeeded(); },
    state: () => ({ ...retry.state(), inFlight: !!inFlight, again }),
  };
}

let lastFull = 0;
async function checkMemberChanges(){
  const a = await refreshAccess();
  if(a.lost){ accessLost(); return true; }
  // the team check itself didn't get through (offline, a server error): noted once, until it gets through again
  if(!a.ok) throw downloadFailed('access', a.error || new Error("The team member's access couldn't be refreshed."), { level: 'warn' });
  downloadRecovered('access');
  try{ await pullShopChanges(); }
  catch(e){
    // A database without the small change check still gets the whole shop, at most every five minutes. A failed full
    // download does not move that five-minute marker: the retry clock gets another chance after its current delay.
    if(!(e && e.code === ERROR_CODES.OUTDATED_DATABASE)) throw e;
    const now = Date.now();
    if(now - lastFull <= 300000) return true;
    forgetShopChanges();
    const ok = !!(await pullFromSupabase(false));
    if(ok) lastFull = now;
    return ok;
  }
  // orders, held bills and collections; price lists, purchase orders…: each noted once when it fails (a database without
  // them yet has nothing to bring: that isn't a failure, and never sends the phone to the whole download)
  const failures = [await pullPart(pullOrderChanges, 'orders'), await pullPart(pullBizChanges, 'commerce')].filter(Boolean);
  if(failures.length) throw aggregateDownloadFailure(failures.flatMap(failedParts), "Not everything was downloaded.");
  return true;
}
const memberPoller = createMemberPoller({
  now: () => Date.now(),
  eligible: () => !!(isMember() && store.sbStatus === "connected"),
  check: checkMemberChanges,
  isReported: isReportedDownloadFailure,
  warn: e => logger.warn("Member refresh:", e),
});
/* reason: poll | online | foreground. Returns whether a check ran (or joined one already running). */
export const memberPoll = (reason = "poll") => memberPoller.poll(reason);
/* A successful full download on connect is a clean baseline: the next failure starts again at one minute. */
export const memberPollConnected = () => { lastFull = Date.now(); memberPoller.connected(); };
export const memberPollState = () => memberPoller.state();
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
    resetRealtimeCatchUp();   // a new channel: its first join isn't a re-join
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
    }, (status)=>{
      if(status === "SUBSCRIBED" && store.sbStatus !== "update"){ store.sbStatus = "connected"; renderSync(); }
      // joined again after a drop: what the other devices did meanwhile never came as events (catch-up.js)
      onRealtimeStatus(status);
    });
  }catch(e){ logger.warn("Realtime subscription notice:", e); }
}
