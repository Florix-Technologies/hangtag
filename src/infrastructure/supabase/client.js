// Creates the Supabase client (publishable key only) from the settings its caller passes in.

export function makeSbClient({ url, key, storageKey }){
  return window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce", storageKey }
  });
}
