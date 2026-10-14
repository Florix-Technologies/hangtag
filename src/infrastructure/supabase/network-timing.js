// How long a Supabase call took on the network, as the browser measured it (Resource Timing), and whether the page was
// hidden meanwhile. The app's own timer (withTiming) runs until the page's thread takes the answer, so a busy page, or a
// hidden one whose timers the browser slows, makes a call look slow that the network answered quickly. This tells the two
// apart. Kept in memory only, by operation name and start time: never an address, a query or a value.
// The browser's buffer of timings fills up with the app's own files (250 entries), so an observer takes them as they come.
const KEEP = 100, MATCH_MS = 100;

/* opOf: the operation name of an address (apiOp); win: the page (none in Node: then nothing is known) */
export function createNetworkTiming({ opOf, win = typeof window === "undefined" ? null : window } = {}){
  const doc = win && win.document, perf = win && win.performance;
  const now = () => (perf && perf.now ? perf.now() : Date.now());
  const recent = [], waiting = new Set();
  let hiddenAt = -Infinity;   // when the page last became hidden (the same clock as performance.now)
  const isHidden = () => !!doc && doc.visibilityState === "hidden";
  if(doc && doc.addEventListener){ if(isHidden()) hiddenAt = now(); doc.addEventListener("visibilitychange", () => { if(isHidden()) hiddenAt = now(); }); }
  const same = (op, t0, r) => r.op === op && Math.abs(r.start - t0) < MATCH_MS;
  let observing = false;
  if(win && typeof win.PerformanceObserver === "function" && typeof opOf === "function"){
    try{
      new win.PerformanceObserver((list) => {
        for(const e of list.getEntries()){
          if(e.initiatorType !== "fetch") continue;
          const op = opOf(e.name); if(!op || op === "other") continue;
          const r = { op, start: e.startTime, duration: e.duration };
          recent.push(r); if(recent.length > KEEP) recent.shift();
          for(const w of waiting) if(same(w.op, w.t0, r)){ waiting.delete(w); clearTimeout(w.timer); w.resolve(r.duration); }
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
    /* the network time (ms) of the call of op that started at t0, or null when the browser doesn't tell within wait ms */
    network(op, t0, wait = 10000){
      const r = recent.find((x) => same(op, t0, x));
      if(r) return Promise.resolve(r.duration);
      if(!observing) return Promise.resolve(null);
      return new Promise((resolve) => { const w = { op, t0, resolve }; w.timer = setTimeout(() => { waiting.delete(w); resolve(null); }, wait); waiting.add(w); });
    },
  };
}
