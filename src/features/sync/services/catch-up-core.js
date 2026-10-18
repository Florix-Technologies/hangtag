// An owner's device keeps up with the shop's other devices. Realtime brings their changes as they happen; this catches up
// on what realtime missed — a dropped socket, the device offline, asleep, frozen or in the background — with the same check
// a team member's phone makes every 30 s (pull.js pullShopChanges): first this device's own work goes up, then the shop's
// small fingerprints come down, and only the parts that moved are downloaded, through the same downloads (which keep what
// still waits to upload, or went up while they were on their way: sync-ledger.js). The first connection isn't a gap: its
// full download covers it.
// When: realtime joins again after a drop; the device comes back online; the app comes back to the screen after a while
// (hidden, frozen, or restored from the back/forward cache); and every 5 minutes while on screen. One check at a time:
// a reason that comes during a check runs one more after it, never two at once. Only a check that got everything counts:
// one that failed is owed and retried after 1, 2, 4, then at most 5 minutes; a real online/realtime/foreground signal
// tries immediately. A check left to a download already under way stays owed without consuming a retry step.
// The clock, the checks and the page are given (catch-up.js wires the app's), and the retry clock (retry-backoff.js) has no
// timers of its own, so all of it can be tested.
import { createRetryBackoff } from './retry-backoff.js';

export const POLL_MS = 5 * 60e3, RESUME_MS = 30e3, TICK_MS = 60e3;
// a check still going after 2 minutes (a connection that hangs after sleep) no longer holds the next one back; the
// upload before a check is waited for at most 30 s (the downloads keep what is still going up)
export const STUCK_MS = 2 * 60e3, FLUSH_WAIT_MS = 30e3;
const DROPPED = new Set(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);

/* realtime's status callback, in order: true for a join that follows a drop after an earlier join */
export function createRealtimeTracker(){
  let joined = false, dropped = false;
  return {
    status(s){
      if(s === "SUBSCRIBED"){ const again = joined && dropped; joined = true; dropped = false; return again; }
      if(joined && DROPPED.has(s)) dropped = true;
      return false;
    },
    reset(){ joined = false; dropped = false; },
  };
}

/* Is a check due? reason: realtime | online | foreground | poll; lastCheckAt: the last check that got everything;
   hiddenFor: how long the page was away (foreground); owed: the last check didn't get everything */
export function catchUpDue({ reason, now, lastCheckAt = 0, hiddenFor = 0, owed = false }){
  const since = now - lastCheckAt;
  // realtime joined again, or the network came back: whatever happened meanwhile never reached this device, however
  // recently it looked before (a network that flaps runs one check at a time: see createCatchUp)
  if(reason === "realtime" || reason === "online") return true;
  if(reason === "foreground") return owed || hiddenFor >= RESUME_MS || since >= POLL_MS;
  if(reason === "poll") return owed || since >= POLL_MS;
  return false;
}

/* deps: now() → ms; eligible() → an owner's device, signed in and connected; busy() → a download is under way;
   flush() → this device's queued work goes up; sleep(ms) → a promise resolved after ms; check() → the change check
   (throws as the gateway does); fullPull() → the whole download (→ true when it got everything); isOutdated(e) → the
   database has no change check yet; warn(e) */
export function createCatchUp(deps){
  const tracker = createRealtimeTracker();
  const retry = createRetryBackoff({ now: deps.now });
  let lastCheckAt = 0, lastFull = 0, inFlight = null, startedAt = 0, again = false, owed = false;
  const sleep = deps.sleep || (() => new Promise(() => {}));
  const warn = e => { if(!(deps.isReported && deps.isReported(e))) deps.warn(e); };
  /* one check returns success, failure, or deferred while another download is under way */
  async function once(){
    await Promise.race([deps.flush(), sleep(FLUSH_WAIT_MS)]);
    if(deps.busy()) return "deferred";   // a download under way: the next minute's look checks again
    try{ await deps.check(); return "success"; }
    catch(e){
      if(!deps.isOutdated(e)){ warn(e); return "failure"; }
      // a database without the change check yet: the whole download, at most every 5 minutes (as on a member's phone;
      // until then nothing is owed)
      if(deps.now() - lastFull < POLL_MS) return "success";
      lastFull = deps.now();
      return (await deps.fullPull()) ? "success" : "failure";
    }
  }
  function run(){
    const p = (async () => {
      do{
        again = false;
        let outcome;
        try{ outcome = await once(); }
        catch(e){ warn(e); outcome = "failure"; }
        if(outcome === "success"){
          lastCheckAt = deps.now(); owed = false; retry.succeeded();
        }else{
          owed = true;
          if(outcome === "failure") retry.failed();
        }
      }while(again && deps.eligible());
      return true;
    })().finally(() => { if(inFlight === p) inFlight = null; });
    inFlight = p; startedAt = deps.now();
    return p;
  }
  const api = {
    /* → a promise of whether a check ran (false: not this device, or not due) */
    catchUp(reason, { hiddenFor = 0 } = {}){
      if(!deps.eligible()) return Promise.resolve(false);
      // during a check: realtime, online and foreground run one more after it (what changed while it ran); a poll doesn't.
      // A check that hangs is left to finish on its own (what it brings can't replace newer: sync-ledger.js)
      if(inFlight && deps.now() - startedAt < STUCK_MS){ if(reason !== "poll") again = true; return inFlight; }
      if(!catchUpDue({ reason, now: deps.now(), lastCheckAt, hiddenFor, owed })) return Promise.resolve(false);
      // Network/device signals are fresh evidence and try now; the one-minute look observes bounded backoff.
      if(!retry.canTry({ immediate: reason !== "poll" })) return Promise.resolve(false);
      if(inFlight) deps.warn(new Error("A catch-up has been waiting 2 minutes; another starts."));
      return run();
    },
    /* realtime's status callback: a join after a drop catches up */
    realtimeStatus(s){ return tracker.status(s) ? api.catchUp("realtime") : Promise.resolve(false); },
    /* a new channel: its first join is a join, not a re-join */
    realtimeReset(){ tracker.reset(); },
    /* the device connected and downloaded everything: the next poll counts from now */
    connected(){ lastCheckAt = deps.now(); lastFull = lastCheckAt; owed = false; retry.succeeded(); },
    /* the page's events and the 5-minute look → a function that removes them all. timers: { setInterval, clearInterval } */
    install({ win, doc, timers, onForeground }){
      let hiddenAt = doc && doc.visibilityState === "hidden" ? deps.now() : null;
      const away = () => { if(hiddenAt == null) hiddenAt = deps.now(); };
      const back = () => { const hiddenFor = hiddenAt == null ? 0 : deps.now() - hiddenAt; hiddenAt = null; api.catchUp("foreground", { hiddenFor }); if(onForeground) onForeground({ hiddenFor }); };
      const onVisibility = () => { if(doc.visibilityState === "hidden") away(); else back(); };
      // restored from the back/forward cache: away for an unknown while, its socket closed — always a catch-up
      const onShow = (e) => { if(e && e.persisted){ hiddenAt = null; api.catchUp("foreground", { hiddenFor: RESUME_MS }); if(onForeground) onForeground({ hiddenFor: RESUME_MS }); } };
      const listeners = [[doc, "visibilitychange", onVisibility], [doc, "freeze", away], [doc, "resume", back], [win, "pageshow", onShow]].filter(([t]) => t && t.addEventListener);
      listeners.forEach(([t, k, f]) => t.addEventListener(k, f));
      // a device asleep: its timer fires again on waking, 5 minutes or more after the last check — one catch-up
      const timer = timers.setInterval(() => { if(!doc || doc.visibilityState !== "hidden") api.catchUp("poll"); }, TICK_MS);
      return () => { timers.clearInterval(timer); listeners.forEach(([t, k, f]) => t.removeEventListener(k, f)); };
    },
    /* for tests: what the scheduler knows */
    state: () => ({ lastCheckAt, inFlight: !!inFlight, again, owed, ...retry.state() }),
  };
  return api;
}
