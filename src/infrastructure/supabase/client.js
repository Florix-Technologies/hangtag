// Creates the Supabase client (publishable key only) from the settings its caller passes in.
// Team members: the database gives a member its shop only from an enrolled device, so every request of a member's phone
// carries the device key in the x-hangtag-device header (supabase/schema.sql section 3i). deviceKey() is read on every
// request (REST, RPC, Edge Functions, sign-in): once a phone is enrolled or registered, its next request carries the key,
// without a second client (two clients would refresh the same session against each other). No key: no header.

export const DEVICE_HEADER = "x-hangtag-device";
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
    ...(deviceKey ? { global: { fetch: withDeviceHeader((input, init) => fetch(input, init), deviceKey) } } : {})
  });
}
