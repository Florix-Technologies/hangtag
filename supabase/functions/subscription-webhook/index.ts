// Supabase Edge Function "subscription-webhook": the payment provider tells Hangtag a plan payment was paid (or expired /
// cancelled), so a plan is activated even when the app is closed before the payment finished.
// - Deploy WITHOUT JWT verification (the provider can't sign in):  supabase functions deploy subscription-webhook --no-verify-jwt
// - Every request must carry the provider's valid signature (Razorpay: X-Razorpay-Signature = HMAC-SHA256 of the raw body
//   with SUBSCRIPTION_WEBHOOK_SECRET); anything else is refused before the body is read as JSON.
// - Idempotent: activation of an already paid payment changes nothing; the amount must be exactly the amount due.
// - AutoPay: subscription.authenticated / activated / charged / pending / halted / cancelled / completed / resumed move the
//   shop's AutoPay (hangtag_autopay_event). A charge counts only when the payment was CAPTURED; the same charge twice
//   changes nothing. A mandate Hangtag made but no longer tracks (replaced by a new set-up) is cancelled, not charged on.
// In the Razorpay dashboard (Hangtag's own account): Webhooks → URL https://<project>.supabase.co/functions/v1/subscription-webhook,
// the same secret, events payment_link.paid, payment_link.expired, payment_link.cancelled, and subscription.authenticated,
// subscription.activated, subscription.charged, subscription.pending, subscription.halted, subscription.cancelled,
// subscription.completed, subscription.resumed.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { verifyDecision } from "../subscription/core.js";
import { providerFor } from "../subscription/providers/index.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { ok: false });
  const env = Deno.env.toObject();
  const provider = providerFor(env);
  if (!provider || !env.SUBSCRIPTION_WEBHOOK_SECRET) return reply(503, { ok: false, error: "not_configured" });
  const raw = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  if (raw.length > 200_000 || !(await provider.verifyWebhook(raw, headers))) return reply(400, { ok: false, error: "bad_signature" });
  let event: unknown;
  try { event = JSON.parse(raw); } catch { return reply(400, { ok: false, error: "bad_request" }); }
  const target = provider.readWebhook(event);
  if (!target) return reply(200, { ok: true, ignored: true });
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  if (target.kind === "autopay") {
    const { data: a, error: aErr } = await admin.rpc("hangtag_autopay_event", { p_provider: provider.name, p_subscription: target.subscriptionId, p_event: target.event,
      p_payment: target.paymentId, p_amount: target.amount, p_next_charge_at: target.nextChargeAt });
    if (aErr) { console.error("subscription-webhook: AutoPay report refused:", aErr.code); return reply(500, { ok: false }); }   // the provider retries
    if (a && a.known === false && target.owner && ["authenticated", "activated", "charged"].includes(target.event)) {
      try { await provider.cancelAutopay(target.subscriptionId); } catch { console.error("subscription-webhook: an AutoPay Hangtag no longer tracks couldn't be cancelled"); }
      if (target.event === "charged") console.error("subscription-webhook: a charge on an AutoPay Hangtag no longer tracks: refund it in the provider's dashboard");
    }
    return reply(200, { ok: true, autopay: target.event, known: !!(a && a.known) });
  }
  const { data: row } = await admin.from("hangtag_subscription_payments").select("id, amount, status, provider_order_id")
    .eq("provider", provider.name).eq("provider_order_id", target.orderId).maybeSingle();
  if (!row) return reply(200, { ok: true, ignored: true });   // not a Hangtag plan payment
  const d = verifyDecision(row, target.view);
  if (d.action === "activate") {
    const { error } = await admin.rpc("hangtag_subscription_activate", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount });
    if (error) { console.error("subscription-webhook: activation refused:", error.code); return reply(500, { ok: false }); }   // the provider retries
    return reply(200, { ok: true, status: "paid" });
  }
  if (d.action === "fail") await admin.rpc("hangtag_subscription_fail", { p_payment: row.id, p_status: d.status });
  return reply(200, { ok: true, status: d.status });
});
