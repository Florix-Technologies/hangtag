// Creates the Supabase client (publishable key only) from the settings its caller passes in.
// Team members: the database gives a member its shop only from an enrolled device, so every request of a member's phone
// carries the device key in the x-hangtag-device header (supabase/schema.sql section 3i). deviceKey() is read on every
// request (REST, RPC, Edge Functions, sign-in): once a phone is enrolled or registered, its next request carries the key,
// without a second client (two clients would refresh the same session against each other). No key: no header.

import { recordEvent } from '../../shared/logging/diagnostics.js';

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
/* fetch that notes slow calls, server errors and failed connections (never the address's values, the body or the answer) */
export function withTiming(fetchImpl, clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now())){
  return async (input, init) => {
    const t0 = clock(), url = typeof input === "string" ? input : (input && input.url) || "";
    try{
      const res = await fetchImpl(input, init), ms = clock() - t0;
      if(res && res.status >= 500) recordEvent("api", "server-error", { op: apiOp(url), status: res.status, ms });
      else if(ms > SLOW_MS) recordEvent("api", "slow-call", { op: apiOp(url), status: res && res.status, ms }, "warn");
      return res;
    }catch(e){
      if(!(e && e.name === "AbortError")) recordEvent("api", "connection-failed", { op: apiOp(url), ms: clock() - t0 }, "warn");
      throw e;
    }
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
