// The "subscription" Edge Function's logic (plain JS, unit-tested in Node: tests/unit/subscription-function.test.mjs).
// It never trusts a price, discount, amount, plan or state sent by the app: the database computes the payment
// (hangtag_subscription_checkout, called AS the signed-in owner) and activates it only after the payment provider confirmed
// exactly the amount due (hangtag_subscription_activate, service role).
//   config   → { ok, available, provider }
//   checkout → { plan, promo? } → { ok, payment_id, amount, pay_url, provider } or { ok, free: true, status: "paid", … }
//   verify   → { payment_id } → { ok, status: "paid"|"pending"|"failed"|"expired"|"cancelled", state?, period_end? }
//   autopay_start  → { consent: true, consent_version } → { ok, auth_url, first_charge_at, today, price, currency }
//   autopay_verify → { ok, status } (what the provider says now about the owner's mandate; charges come only by webhook)
//   autopay_cancel → { ok, status: "cancelled" } (turned off at the provider first; the time already running is kept)
//   billing_selfcheck → (console staff who manage settings) { ok, steps } — a ₹1 link and a far-off subscription made and
//                    cancelled at the provider, whose notifications prove the webhook (no money moves)
const str = (v) => (v == null ? "" : String(v));
const fail = (status, error, message) => ({ ok: false, status, error, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PLAN = /^[a-z0-9_]{1,20}$/;
export const PROMO = /^[A-Za-z0-9_-]{0,32}$/;

export function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_request", "Send the request as JSON.");
  const action = body.action;
  if (action === "config") return { ok: true, action };
  if (action === "checkout") {
    const plan = str(body.plan).trim(), promo = str(body.promo).trim();
    if (!PLAN.test(plan)) return fail(400, "bad_plan", "Choose a plan.");
    if (!PROMO.test(promo)) return fail(400, "bad_promo", "This promo code isn't valid.");
    // anything else in the request (an amount, a discount, a price…) is ignored on purpose
    return { ok: true, action, plan, promo: promo || null };
  }
  if (action === "autopay_start") {
    // the owner's explicit consent to the terms shown (the database checks the version is the current one)
    const version = str(body.consent_version).trim();
    if (body.consent !== true || !/^[a-z0-9._-]{3,40}$/.test(version)) return fail(400, "consent_required", "Agree to the AutoPay terms first.");
    return { ok: true, action, consentVersion: version };
  }
  if (action === "autopay_verify" || action === "autopay_cancel" || action === "billing_selfcheck") return { ok: true, action };
  if (action === "verify") {
    const id = str(body.payment_id).trim();
    if (!UUID.test(id)) return fail(400, "bad_payment", "Unknown payment.");
    return { ok: true, action, paymentId: id };
  }
  return fail(400, "bad_action", "Unknown action.");
}

/* A database error → the reply the app shows: the database's own plain message for refusals it explains (P0001: not the
   owner, a refused promo code, no such plan, too many attempts), a generic one otherwise (never internal details) */
export function rpcErrorReply(error) {
  if (error && error.code === "P0001" && error.message) return { status: 400, body: { ok: false, error: "refused", message: str(error.message).slice(0, 160) } };
  return { status: 503, body: { ok: false, error: "server_error", message: "Plans & Billing isn't available right now. Try again." } };
}

/* What to do with a plan payment after asking the provider: activate it (paid, exactly the amount due), mark it failed /
   expired / cancelled, or leave it (still waiting). paid is in paise; the row's amount in rupees. */
export function verifyDecision(row, view) {
  if (!row) return { action: "none", status: "failed" };
  if (row.status === "paid") return { action: "none", status: "paid" };
  if (!view) return { action: "none", status: "pending" };
  if (view.state === "paid") {
    // money in another currency than the payment's is never this payment (a provider that says its currency)
    if (view.currency && row.currency && str(view.currency).toUpperCase() !== str(row.currency).toUpperCase()) return { action: "none", status: "currency_mismatch" };
    const due = Math.round((+row.amount || 0) * 100);
    if (view.paid !== due) return { action: "none", status: "mismatch" };   // never activate on a different amount
    if (!view.paymentId) return { action: "none", status: "pending" };
    return { action: "activate", status: "paid", amount: view.paid / 100, ref: view.paymentId };
  }
  if (["expired", "cancelled", "failed"].includes(view.state)) return row.status === "created" ? { action: "fail", status: view.state } : { action: "none", status: row.status };
  return { action: "none", status: "pending" };
}

/* The provider's plan must be exactly the AutoPay plan the owner agreed to: its price (in paise), currency and length */
export function autopayPlanMatches(providerPlan, terms) {
  if (!providerPlan || !terms || !terms.plan) return false;
  const months = +terms.plan.months || 1;
  return providerPlan.amount === Math.round((+terms.price || 0) * 100) && str(providerPlan.currency).toUpperCase() === str(terms.currency).toUpperCase()
    && ((providerPlan.period === "monthly" && providerPlan.interval === months) || (providerPlan.period === "yearly" && months === 12 && providerPlan.interval === 1));
}
/* When AutoPay charges first (ms): when the trial or plan running now ends — or null (at once) when it ends within ten
   minutes (the provider needs a start in the future) */
export function autopayStartAt(terms, now = Date.now()) {
  const t = Date.parse(terms && terms.first_charge_at);
  return Number.isFinite(t) && t > now + 10 * 60e3 ? t : null;
}
export const description = (q) => `Hangtag ${str(q && q.plan_label) || "plan"}`.slice(0, 120);
export const callbackUrl = (env, paymentId) => {
  const base = str(env.APP_URL).trim().replace(/\/+$/, "");
  return /^https:\/\//.test(base) ? `${base}/#plans?payment=${encodeURIComponent(paymentId)}` : null;
};
/* Where a provider that is told per payment (Cashfree) reports it: this project's subscription-webhook (https only) */
export const notifyUrl = (env) => {
  const base = str(env.SUPABASE_URL).trim().replace(/\/+$/, "");
  return /^https:\/\//.test(base) ? `${base}/functions/v1/subscription-webhook` : null;
};
/* The payer's mobile number a provider may ask for (Cashfree): 10 digits from what the shop saved (+91, 0, spaces and
   dashes allowed), or "" when there is none that works */
export function payerPhone(v) {
  let d = str(v).replace(/[\s().-]/g, "");
  if (/^\+91[0-9]{10}$/.test(d)) d = d.slice(3);
  else if (/^91[0-9]{10}$/.test(d)) d = d.slice(2);
  else if (/^0[0-9]{10}$/.test(d)) d = d.slice(1);
  return /^[6-9][0-9]{9}$/.test(d) ? d : "";
}
export const PHONE_NEEDED = "Add the shop's 10-digit mobile number in Settings → Business, then choose Pay again.";
/* The browser origin the subscription function answers (CORS): the app's own (APP_URL) and SUBSCRIPTION_ALLOWED_ORIGINS
   (comma-separated origins; a "*" stands for one part of a host name, e.g. https://hangtag-*-team.vercel.app for
   Previews). Neither set → "*" (the function authenticates by the caller's token; no cookie is involved). Not allowed →
   null (no CORS header: the browser refuses the answer). */
export function corsOrigin(origin, env) {
  const app = (() => { try { return /^https:\/\//.test(str(env && env.APP_URL)) ? new URL(str(env.APP_URL)).origin : ""; } catch { return ""; } })();
  const listed = str(env && env.SUBSCRIPTION_ALLOWED_ORIGINS).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!app && !listed.length) return "*";
  const o = str(origin).trim();
  if (!o) return app || null;
  // a pattern has at most one "*", standing for letters, digits and dashes only (never a dot: one part of the host name)
  const fits = (p) => {
    if (p === o) return true;
    const parts = p.split("*");
    if (parts.length !== 2) return false;
    const [head, tail] = parts, mid = o.slice(head.length, o.length - tail.length);
    return o.length > head.length + tail.length && o.startsWith(head) && o.endsWith(tail) && /^[a-z0-9-]+$/i.test(mid);
  };
  return [app, ...listed].filter(Boolean).some(fits) ? o : null;
}

/* A database function the deployed database doesn't have yet (before the post-repair migration, or after its undo): the
   caller then uses the older function, or does nothing that needs the newer one */
export const missingRpc = (e) => !!e && (e.code === "PGRST202" || e.code === "PGRST205" || e.code === "42883" || e.code === "42P01");

/* Whether a provider in this mode may count money on this database: the database's billing mode must be the provider's.
   A database without the billing mode yet (before the post-repair migration) is taken as live, so only live keys pass. */
export async function billingModeAllows(sr, provider) {
  if (!provider) return false;
  const { data, error } = await sr.rpc("hangtag_billing_mode");
  if (error) return missingRpc(error) && provider.mode === "live";
  return data === provider.mode;
}

const TERMINAL = ["cancelled", "completed", "expired"];
/* Turn an AutoPay subscription off at the provider, or find it already off: { confirmed, status }. A 4xx answer (Razorpay
   answers 400 both for a subscription already ended and for one it can't find) is followed by a read of where it stands;
   a subscription still only "created" (never authorised) ends by itself and counts as not confirmed. A 5xx, 401, 429 or
   a network error is thrown: the provider may be down, try later. */
export async function cancelOrConfirm(ap, subscriptionId) {
  let st = null;
  try { st = await ap.cancelAutopay(subscriptionId); }
  catch (e) {
    const code = e && e.status;
    if (!code || code >= 500 || code === 401 || code === 429) throw e;
  }
  if (!st || !TERMINAL.includes(str(st.status))) {
    try { st = await ap.getAutopay(subscriptionId); }
    catch (e) { const code = e && e.status; if (!code || code >= 500 || code === 401 || code === 429) throw e; return { confirmed: false, status: "unknown" }; }
  }
  return { confirmed: !!st && TERMINAL.includes(str(st.status)), status: str(st && st.status) };
}

/* A promise given at most ms milliseconds (the webhook answers a provider within its few seconds): its value, or
   { timedOut: true } */
export function withBudget(promise, ms) {
  let t;
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), new Promise((resolve) => { t = setTimeout(() => resolve({ timedOut: true }), ms); })]);
}
