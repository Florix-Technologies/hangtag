// Supabase Edge Function "subscription-webhook": the payment provider tells Hangtag a plan payment was paid (or expired /
// cancelled), so a plan is activated even when the app is closed before the payment finished.
// - Deploy WITHOUT JWT verification (the provider can't sign in):  supabase functions deploy subscription-webhook --no-verify-jwt
// - Every request must carry the provider's valid signature (Razorpay: X-Razorpay-Signature = HMAC-SHA256 of the raw body
//   with SUBSCRIPTION_WEBHOOK_SECRET); anything else is refused before the body is read as JSON.
// - Idempotent: activation of an already paid payment changes nothing; the amount must be exactly the amount due.
// - AutoPay: subscription.authenticated / activated / charged / pending / halted / cancelled / completed / resumed move the
//   shop's AutoPay (hangtag_autopay_event). A charge counts only when the payment was CAPTURED; the same charge twice
//   changes nothing. A mandate Hangtag made but no longer tracks (replaced by a new set-up) is cancelled, not charged on.
// - Answered 2xx only once an event is recorded or can never be (handler.js): otherwise the provider sends it again.
// - Secrets: SUBSCRIPTION_WEBHOOK_SECRET, SUBSCRIPTION_RAZORPAY_KEY_ID, SUBSCRIPTION_RAZORPAY_KEY_SECRET (the provider is
//   asked to cancel an AutoPay Hangtag no longer tracks); test keys only with SUBSCRIPTION_TEST_MODE=true.
// In the Razorpay dashboard (Hangtag's own account): Webhooks → URL https://<project>.supabase.co/functions/v1/subscription-webhook,
// the same secret, events payment_link.paid, payment_link.expired, payment_link.cancelled, and subscription.authenticated,
// subscription.activated, subscription.charged, subscription.pending, subscription.halted, subscription.cancelled,
// subscription.completed, subscription.resumed.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { providerFor } from "../subscription/providers/index.js";
import { handleWebhook } from "./handler.js";

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const raw = req.method === "POST" ? await req.text() : "";
  const r = await handleWebhook({ method: req.method, raw, headers }, {
    provider: providerFor(env), secret: env.SUBSCRIPTION_WEBHOOK_SECRET,
    admin: () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }),
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
});
