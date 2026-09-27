// Turns sign-in errors into plain messages.

/* Plain-words versions of Supabase's error messages */

export function authErrorText(e){
  const m = (e && (e.message || e.error_description)) || String(e || "Something went wrong.");
  const code = (e && e.code) || "";
  if(code === "invalid_credentials" || /invalid login credentials/i.test(m)) return "Wrong email or password.";
  if(code === "email_not_confirmed" || /email not confirmed/i.test(m)) return "Confirm your email first. Open the link we emailed you, then sign in.";
  if(code === "user_already_exists" || /already (been )?registered/i.test(m)) return "An account with this email already exists. Sign in instead.";
  if(code === "email_provider_disabled" || code === "signup_disabled" || /signups? not allowed|email logins are disabled|provider is not enabled/i.test(m)) return "Email sign-in isn't switched on for this app yet. Use Continue with Google, or ask the owner to turn on Email in Supabase.";
  if(code === "email_address_not_authorized" || /not allowed for this address|default SMTP/i.test(m)) return "This app can't send email to that address yet. Use Continue with Google, or ask the owner to set up email sending in Supabase.";
  if(code === "over_email_send_rate_limit" || /email rate limit/i.test(m)) return "Too many emails were sent in the last hour. Try again later, or use Continue with Google.";
  if(code === "weak_password" || /password should/i.test(m)) return m;
  if(/rate limit|too many/i.test(m) || /over_.*rate_limit/.test(code)) return "Too many attempts. Wait a few minutes and try again.";
  if(/failed to fetch|networkerror|load failed/i.test(m) || e && e.name === "AuthRetryableFetchError") return "Can't reach the server. Check the internet connection and try again.";
  return m;
}
/* Error codes from a link Supabase or a sign-in service sent back. Never show the link's own text: anyone can craft it. */

export function linkErrorText(code){
  code = String(code || "");
  if(/otp_expired|expired|invalid|flow_state/i.test(code)) return "That link has expired or was already used. Try again.";
  if(/access_denied|cancel/i.test(code)) return "Sign-in was cancelled. Try again when you're ready.";
  return "Sign-in didn't finish. Try again.";
}
export const isNetErr = e => !!e && (e.name === "AuthRetryableFetchError" || e.status === 0 || e.status >= 500 || /failed to fetch|networkerror|load failed/i.test(e.message || ""));
