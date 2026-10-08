// The "platform" port: the Platform Console's link to Hangtag's database. Sign-in on a session of its own (its own storage
// key: never the shop app's session), and the console's functions (schema.sql section 3w), each of which checks the
// caller's console role in the database. Errors come back as a PlatformError with a code the console acts on: DENIED (the
// role can't), REFUSED (the database explained why: its own words), AUTH (sign in again), OUTDATED (the database update
// isn't applied), NETWORK — never an internal detail.

export class PlatformError extends Error {
  constructor(code, message){ super(message); this.name = "PlatformError"; this.code = code; }
}
const PLAIN = "The console couldn't reach Hangtag's database. Try again.";
/* A Supabase error → a PlatformError */
export function platformError(e){
  const code = e && e.code, msg = String((e && e.message) || "");
  if(code === "42501" || /HANGTAG_PLATFORM_DENIED/.test(msg)) return new PlatformError("DENIED", "Your console role can't do this.");
  if(code === "P0001" || code === "P0002") return new PlatformError("REFUSED", msg.replace(/^HANGTAG_\w+:\s*/, "").slice(0, 200) || "Refused.");
  if(code === "23514" || code === "22P02" || code === "22003" || code === "22007" || code === "22008") return new PlatformError("REFUSED", "Check the values.");
  if(code === "PGRST202" || code === "42883") return new PlatformError("OUTDATED", "The console needs the database update (schema.sql section 3w).");
  if(code === "PGRST301" || code === "401" || /JWT|not authenticated/i.test(msg)) return new PlatformError("AUTH", "Your sign-in has ended. Sign in again.");
  if(/Failed to fetch|NetworkError|network/i.test(msg)) return new PlatformError("NETWORK", "No connection. Check the internet and try again.");
  return new PlatformError("UNKNOWN", PLAIN);
}

/* client: a supabase-js client made for the console (its own session storage key) */
export function createPlatformGateway({ client }){
  async function rpc(fn, args){
    let r;
    try{ r = await client.rpc(fn, args || {}); }
    catch{ throw new PlatformError("NETWORK", "No connection. Check the internet and try again."); }
    if(r && r.error) throw platformError(r.error);
    return r ? r.data : null;
  }
  return Object.freeze({
    /* the console's session on this device, or null */
    async session(){ const { data } = await client.auth.getSession(); return (data && data.session) || null; },
    /* cb(event, session): "SIGNED_OUT" when the session ends */
    onAuthChange(cb){ const { data } = client.auth.onAuthStateChange((event, session) => cb(event, session)); return () => data && data.subscription && data.subscription.unsubscribe(); },
    async signInWithPassword(email, password){
      let r;
      try{ r = await client.auth.signInWithPassword({ email, password }); }
      catch{ throw new PlatformError("NETWORK", "No connection. Check the internet and try again."); }
      if(r.error) throw new PlatformError("AUTH", /invalid|credentials/i.test(r.error.message || "") ? "That email and password don't match." : "Couldn't sign in. Try again.");
      return r.data && r.data.session;
    },
    /* Google: the browser leaves for Google and comes back to redirectTo (the console) */
    async signInWithGoogle(redirectTo){
      const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
      if(error) throw new PlatformError("AUTH", "Google sign-in couldn't start. Try again.");
    },
    async signOut(){ try{ await client.auth.signOut(); }catch{ /* the session is dropped on this device regardless */ } },
    whoami: () => rpc("hangtag_platform_whoami"),
    /* whoami, with the sign-in noted in the console's audit log */
    signedIn: () => rpc("hangtag_platform_sign_in"),
    dashboard: () => rpc("hangtag_platform_dashboard"),
    promotions: () => rpc("hangtag_platform_promotions"),
    saveCampaign: (code, patch) => rpc("hangtag_platform_campaign_save", { p_code: code, p_patch: patch }),
    savePlan: (code, patch) => rpc("hangtag_platform_plan_save", { p_code: code, p_patch: patch }),
    audit: (limit, before) => rpc("hangtag_platform_audit_list", { p_limit: limit || 50, p_before: before || null }),
    settings: () => rpc("hangtag_platform_settings"),
    saveSettings: patch => rpc("hangtag_platform_settings_save", { p_patch: patch }),
    staff: () => rpc("hangtag_platform_staff_list"),
    saveStaff: (userId, role, active, name) => rpc("hangtag_platform_staff_save", { p_user: userId, p_role: role, p_active: active, p_name: name || null }),
  });
}
