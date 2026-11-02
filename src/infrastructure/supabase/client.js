// Creates the Supabase client (publishable key only) from the settings its caller passes in.
// Team members: the database gives a member its shop only from an enrolled device, so every request of a member's phone
// carries the device key in the x-hangtag-device header (supabase/schema.sql section 3i). deviceKey() is read on every
// request (REST, RPC, Edge Functions, sign-in): once a phone is enrolled or registered, its next request carries the key,
// without a second client (two clients would refresh the same session against each other). No key: no header.

import { recordEvent, recordLatency } from '../../shared/logging/diagnostics.js';
import { createNetworkTiming } from './network-timing.js';

export const DEVICE_HEADER = "x-hangtag-device";
export const SLOW_MS = 3000;   // a call slower than this is noted (by its operation name and a duration band)
/* What a request is for, without any value: rpc:hangtag_save_sales, table:hangtag_sales, fn:send-receipt, auth:token, storage */
export function apiOp(url){
  try{
    const p = new URL(String(url || ""), "https://x.invalid").pathname; let m;
    if((m = /\/rest\/v1\/rpc\/([\w-]+)/.exec(p))) return "rpc:" + m[1];
    if((m = /\/rest\/v1\/([\w-]+)/.exec(p))) return "table:" + m[1];
    if((m = /\/functions\/v1\/([\w-]+)/.exec(p))) return "fn:" + m[1];
    if((m = /\/auth\/v1\/([\w-]+)/.exec(p))) return "auth:" + m[1];
    return /\/storage\/v1\//.test(p) ? "storage" : "other";
  }catch{ return "other"; }
}
/* fetch that times every call (the 24-hour latency by operation) and notes slow calls, server errors and failed connections
   (never the address's values, the body or the answer). This timer runs until the page's thread takes the answer, so a
   slow call is noted with the network's own time as the browser measured it, and whether the page was hidden meanwhile
   (a busy or hidden page makes a quick answer look slow); a failed connection with the latter (network-timing.js). */
export function withTiming(fetchImpl, clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()),
  timing = createNetworkTiming({ opOf: apiOp })){
  // the notes never stand in the call's way: an error in them is dropped, the answer (or the failure) goes back as it came
  const safe = (fn, dflt) => { try{ return fn(); }catch{ return dflt; } };
  return async (input, init) => {
    const t0 = clock(), url = typeof input === "string" ? input : (input && input.url) || "", op = apiOp(url);
    const hidden0 = safe(() => timing.hidden(), false);
    safe(() => timing.begin && timing.begin(op, t0));
    let res;
    try{ res = await fetchImpl(input, init); }
    catch(e){
      if(!(e && e.name === "AbortError")) safe(() => {
        const ms = clock() - t0;
        recordLatency(op, ms, false);
        recordEvent("api", "connection-failed", { op, ms, hidden: hidden0 || safe(() => timing.hiddenSince(t0), false) }, "warn");
      });
      throw e;
    }
    safe(() => {
      const ms = clock() - t0, at = Date.now();
      recordLatency(op, ms, !(res && res.status >= 500));
      if(res && res.status >= 500) recordEvent("api", "server-error", { op, status: res.status, ms });
      else if(ms > SLOW_MS){
        const status = res && res.status, hidden = hidden0 || safe(() => timing.hiddenSince(t0), false);
        // noted once the browser has told the network time (or not), stamped with the time the answer came
        Promise.resolve(timing.network(op, t0)).catch(() => null)
          .then((net) => safe(() => recordEvent("api", "slow-call", { op, status, ms, net, hidden, at }, "warn")));
      }
    });
    return res;
  };
}
/* fetch with this phone's device key added when there is one */
export function withDeviceHeader(fetchImpl, deviceKey){
  return (input, init) => {
    const k = deviceKey ? deviceKey() : "";
    if(!k) return fetchImpl(input, init);
    const headers = new Headers((init && init.headers) || (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
    headers.set(DEVICE_HEADER, k);
    return fetchImpl(input, Object.assign({}, init, { headers }));
  };
}
/* deviceKey: () => this phone's device key or "" (the only extra header; see above) */
export function makeSbClient({ url, key, storageKey, deviceKey }){
  return window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce", storageKey },
    global: { fetch: withTiming(withDeviceHeader((input, init) => fetch(input, init), deviceKey)) }
  });
}
