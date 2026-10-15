// How long a Supabase call took on the network, as the browser measured it (Resource Timing), and whether the page was
// hidden meanwhile. The app's own timer (withTiming) runs until the page's thread takes the answer, so a busy page, or a
// hidden one whose timers the browser slows, makes a call look slow that the network answered quickly. This tells the two
// apart. Kept in memory only, by operation name and start time: never an address, a query or a value.
// The browser's buffer of timings fills up with the app's own files (250 entries), so an observer takes them as they come.
// A timing is given to one call only, the one that started closest to it; when two calls of one operation started within
// the matching window of each other, neither gets one (a guess could blame the page for the network, or the reverse).
const KEEP = 100, MATCH_MS = 100, STARTS_MS = 60000, WAIT_MS = 3000;

/* opOf: the operation name of an address (apiOp); win: the page (none in Node: then nothing is known) */
export function createNetworkTiming({ opOf, win = typeof window === "undefined" ? null : window } = {}){
  const doc = win && win.document, perf = win && win.performance;
  const now = () => (perf && perf.now ? perf.now() : Date.now());
  const recent = [], waiting = new Set(), starts = [];
  let hiddenAt = -Infinity;   // when the page last became hidden (the same clock as performance.now)
  const isHidden = () => !!doc && doc.visibilityState === "hidden";
  if(doc && doc.addEventListener){ if(isHidden()) hiddenAt = now(); doc.addEventListener("visibilitychange", () => { if(isHidden()) hiddenAt = now(); }); }
  // leaving the page, or the page frozen (an installed app in the background may be frozen, then ended, without a
  // pagehide): every call still waiting is noted now (without a network time) rather than lost
  const noteWaiting = () => { for(const w of waiting){ waiting.delete(w); clearTimeout(w.timer); w.resolve(null); } };
  if(win && win.addEventListener) win.addEventListener("pagehide", noteWaiting);
  if(doc && doc.addEventListener) doc.addEventListener("freeze", noteWaiting);
  const near = (op, t0, r) => r.op === op && Math.abs(r.start - t0) < MATCH_MS;
  /* another call of op started within the window of t0: which timing is whose can't be told */
  const ambiguous = (op, t0) => starts.filter((s) => s.op === op && Math.abs(s.t0 - t0) < MATCH_MS).length > 1;
  const closest = (list, op, t0, at) => { let best = null; for(const x of list) if(near(op, t0, x) && (!best || Math.abs(at(x) - t0) < Math.abs(at(best) - t0))) best = x; return best; };
  let observing = false;
  if(win && typeof win.PerformanceObserver === "function" && typeof opOf === "function"){
    try{
      new win.PerformanceObserver((list) => {
        for(const e of list.getEntries()){
          if(e.initiatorType !== "fetch") continue;
          const op = opOf(e.name); if(!op || op === "other") continue;
          const r = { op, start: e.startTime, duration: e.duration };
          // the waiting call that started closest to it takes it; otherwise it is kept for a call that asks a moment later
          let w = null; for(const x of waiting) if(near(op, x.t0, r) && (!w || Math.abs(x.t0 - r.start) < Math.abs(w.t0 - r.start))) w = x;
          if(w){ waiting.delete(w); clearTimeout(w.timer); w.resolve(r.duration); continue; }
          recent.push(r); if(recent.length > KEEP) recent.shift();
        }
      }).observe({ type: "resource", buffered: false });
      observing = true;
    }catch{ observing = false; }
  }
  return {
    now,
    /* the page is hidden now */
    hidden: isHidden,
    /* the page was hidden at some time since t0 (or is now) */
    hiddenSince: (t0) => isHidden() || hiddenAt >= t0,
    /* a call of op starts at t0 (so two calls of one operation at the same moment can be told apart, or not) */
    begin(op, t0){ starts.push({ op, t0 }); const cut = t0 - STARTS_MS; while(starts.length && (starts[0].t0 < cut || starts.length > 500)) starts.shift(); },
    /* the network time (ms) of the call of op that started at t0, or null: when the browser doesn't tell within wait ms,
       or when another call of op started at the same moment */
    network(op, t0, wait = WAIT_MS){
      if(ambiguous(op, t0)) return Promise.resolve(null);
      const r = closest(recent, op, t0, (x) => x.start);
      if(r){ recent.splice(recent.indexOf(r), 1); return Promise.resolve(r.duration); }
      if(!observing) return Promise.resolve(null);
      return new Promise((resolve) => { const w = { op, t0, resolve }; w.timer = setTimeout(() => { waiting.delete(w); resolve(null); }, wait); waiting.add(w); });
    },
  };
}
