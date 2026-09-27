// Runtime configuration: the only module that reads config.js (window.HANGTAG_CONFIG), the derived cloud flags, and the environment.
const w = typeof window === "undefined" ? {} : window;   // no window when a unit test imports this in Node
const cfg = w.HANGTAG_CONFIG || {};
const loc = w.location || { origin: "", pathname: "", hostname: "" };

export const sbUrl = cfg.SUPABASE_URL || "";
export const sbKey = cfg.SUPABASE_ANON_KEY || "";
export const cloudWanted = !!(sbUrl && sbKey);                // config.js points at a Supabase project
export const cloudConfigured = cloudWanted && !!w.supabase;   // ...and the Supabase library loaded
export const HOME_URL = loc.origin + loc.pathname;
/* "test" when a test set window.__HANGTAG_TEST__ before the app loaded, "development" on this computer (localhost),
   "production" on the live site (github.io) and any other host. Nothing behaves differently per environment yet. */
export const APP_ENV = w.__HANGTAG_TEST__ ? "test"
  : ["localhost", "127.0.0.1", "[::1]", "::1", ""].includes(loc.hostname) ? "development"
  : "production";
