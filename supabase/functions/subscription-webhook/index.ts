// Supabase Edge Function "subscription-webhook": a payment provider tells Hangtag a plan payment was paid (or expired,
// cancelled, refunded), so a plan is activated even when the app is closed before the payment finished.
// - Deploy WITHOUT JWT verification (the provider can't sign in):  supabase functions deploy subscription-webhook --no-verify-jwt
// - Every request must carry its provider's valid signature, checked on the raw body before it is read:
//   Razorpay: X-Razorpay-Signature = hex HMAC-SHA256 of the body with SUBSCRIPTION_WEBHOOK_SECRET;
//   Cashfree: x-webhook-signature = Base64 HMAC-SHA256 of x-webhook-timestamp + the body with the secret key.
// - Idempotent: activation of an already paid payment changes nothing; the amount and currency must be exactly the
//   payment's; a settled notification sent again is known (hangtag_billing_events, after the post-repair migration).
// - Cashfree's notifications are only nudges: the link, its paid orders and their payments are read from its API.
// - AutoPay (Razorpay): subscription.authenticated / activated / charged / pending / halted / cancelled / completed /
//   resumed move the shop's AutoPay; a charge counts only when CAPTURED; the same charge twice changes nothing.
// - Answered 2xx only once a notification is settled or can never be (handler.js): otherwise the provider sends it again.
// - Only in the database's billing mode (after the post-repair migration): a notification in the other mode is kept for
//   review, never acted on. Refunds and disputes are kept for review. AutoPay goes through the registry of set-ups.
// - Reconciliation (../subscription/reconcile.js): a POST with "x-hangtag-reconcile: 1" and "Authorization: Bearer
//   <SUBSCRIPTION_RECONCILE_SECRET>" (32+ characters), from the owner's hourly scheduler; without the secret, 401.
// - Secrets: Razorpay — SUBSCRIPTION_WEBHOOK_SECRET, SUBSCRIPTION_RAZORPAY_KEY_ID, SUBSCRIPTION_RAZORPAY_KEY_SECRET;
//   Cashfree — SUBSCRIPTION_CASHFREE_APP_ID, SUBSCRIPTION_CASHFREE_SECRET_KEY, SUBSCRIPTION_CASHFREE_ENV. Test credentials
//   only with SUBSCRIPTION_TEST_MODE=true (providers/index.js).
// Razorpay dashboard: Webhooks → this function's URL, the same secret, the payment_link.*, subscription.*, refund.processed
// and payment.dispute.created events (and the webhook's alert email: Razorpay disables a webhook that keeps failing).
// Cashfree: each payment link carries this function's URL as its notify_url; payment webhooks in the dashboard may point
// here too (orders that aren't Hangtag plan payments are ignored), with the refund and dispute events.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { providerFor, providerNamed, webhookProviderFor } from "../subscription/providers/index.js";
import { handleReconcile } from "../subscription/reconcile.js";
import { handleWebhook } from "./handler.js";

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const admin = () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  // the scheduled reconciliation (supabase/functions/subscription/reconcile.js): its own header and secret
  if (headers["x-hangtag-reconcile"]) {
    const rec = await handleReconcile({ method: req.method, headers }, { env, admin, provider: providerFor(env), autopay: providerNamed("razorpay", env),
      named: (name: string) => providerNamed(name, env) });
    return new Response(JSON.stringify(rec.body), { status: rec.status, headers: { "Content-Type": "application/json" } });
  }
  const raw = req.method === "POST" ? await req.text() : "";
  const r = await handleWebhook({ method: req.method, raw, headers }, {
    provider: webhookProviderFor(env, headers),
    admin,
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
});
