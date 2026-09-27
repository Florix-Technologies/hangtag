// Sign-in constants: storage keys, providers, password rules.
import { storage } from '../../shared/state/persistence.js';

export const AUTH_STORE = "hangtag-auth";          // where supabase-js keeps the session
export const RESET_KEY = "hangtag_pw_reset";       // time this device asked for a password-reset link
export const RECOVERY_KEY = "hangtag_recovery";    // a reset link was opened; new password not saved yet
export const PICK_ACCOUNT = "hangtag_pick_account";   // set by Sign out: show Google's account chooser on the next sign-in
export const OTP_TYPES = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];
export const MIN_PW = 8;
export const clearStoredSession = () => [AUTH_STORE, AUTH_STORE + "-code-verifier", AUTH_STORE + "-user"].forEach(k => { try{ storage.remove(k); }catch(e){} });
export const recent = key => { const t = +storage.get(key, 0) || 0; return t > 0 && Date.now() - t < 3600e3; };
/* Sign-in services shown when switched on in Supabase (Authentication > Sign In / Providers). Google is always shown. */

export const PROVIDERS = {
  google:        { label: "Google" },
  azure:         { label: "Microsoft", scopes: "email", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg>' },
  apple:         { label: "Apple", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#000" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1zM13.9 5c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3-1.5z"/></svg>' },
  github:        { label: "GitHub", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#181717" d="M12 1.5A10.5 10.5 0 0 0 8.7 22c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-1-.7.1-.7.1-.7 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.2 3.1.9.1-.7.4-1.2.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.3 0c2-1.4 2.9-1.1 2.9-1.1.6 1.5.2 2.6.1 2.9.7.7 1.1 1.7 1.1 2.8 0 4-2.5 4.9-4.8 5.2.4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5z"/></svg>' },
  facebook:      { label: "Facebook", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#1877F2"/><path fill="#fff" d="M13.4 21v-6.6h2.2l.4-2.6h-2.6v-1.7c0-.7.2-1.3 1.3-1.3h1.4V6.5c-.2 0-1.1-.1-2.1-.1-2 0-3.4 1.2-3.4 3.5v1.9H8.4v2.6h2.2V21z"/></svg>' },
  linkedin_oidc: { label: "LinkedIn" },
  discord:       { label: "Discord" },
  gitlab:        { label: "GitLab" },
  twitter:       { label: "X" }
};
export const PROVIDER_NAMES = { email: "Email and password", google: "Google", azure: "Microsoft", apple: "Apple", github: "GitHub", facebook: "Facebook", linkedin_oidc: "LinkedIn", discord: "Discord", gitlab: "GitLab", twitter: "X" };
