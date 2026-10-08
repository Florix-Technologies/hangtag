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
  if (action === "autopay_verify" || action === "autopay_cancel") return { ok: true, action };
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
