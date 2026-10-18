// The subscription-webhook Edge Function's logic, in plain JS so it runs (and is tested) in Node as in Deno: index.ts only
// reads the request and the secrets, makes the clients and sends the answer.
// What the provider is told decides whether it sends the event again (Razorpay retries anything that isn't a 2xx, and
// never a 2xx), so the answer is a 2xx only once the event is recorded, or can never be:
// - a database that can't be asked, or refuses for a reason that may pass (a lost connection, a timeout): 5xx — retried;
// - a refusal that will never pass (P0001: the amount isn't the amount due, the reference is missing): 200, and an error
//   line with the payment's and the provider's ids (no personal data) for Hangtag to settle by hand;
// - a payment that isn't a Hangtag plan payment, or an event Hangtag doesn't use: 200, ignored.
import { verifyDecision } from "../subscription/core.js";

const out = (status, body) => ({ status, body });

/* req: { method, raw (the body as text), headers (lower-case names) }; provider: providerFor(env) or null; secret: the
   webhook secret; admin(): the service-role client (made only after the signature is checked); log: console-like */
export async function handleWebhook({ method, raw, headers }, { provider, secret, admin, log = console }) {
  if (method !== "POST") return out(405, { ok: false });
  if (!provider || !secret) return out(503, { ok: false, error: "not_configured" });
  const body = typeof raw === "string" ? raw : "";
  if (body.length > 200_000 || !(await provider.verifyWebhook(body, headers || {}))) return out(400, { ok: false, error: "bad_signature" });
  let event;
  try { event = JSON.parse(body); } catch { return out(400, { ok: false, error: "bad_request" }); }
  const target = provider.readWebhook(event);
  if (!target) return out(200, { ok: true, ignored: true });
  const db = admin();
  if (target.kind === "autopay") {
    const { data: a, error: aErr } = await db.rpc("hangtag_autopay_event", { p_provider: provider.name, p_subscription: target.subscriptionId, p_event: target.event,
      p_payment: target.paymentId, p_amount: target.amount, p_next_charge_at: target.nextChargeAt });
    if (aErr) { log.error("subscription-webhook: AutoPay report refused:", aErr.code); return out(500, { ok: false }); }   // the provider retries
    if (a && a.known === false && target.owner && ["authenticated", "activated", "charged"].includes(target.event)) {
      try { await provider.cancelAutopay(target.subscriptionId); } catch { log.error("subscription-webhook: an AutoPay Hangtag no longer tracks couldn't be cancelled"); }
      if (target.event === "charged") log.error("subscription-webhook: a charge on an AutoPay Hangtag no longer tracks: refund it in the provider's dashboard", target.subscriptionId, target.paymentId);
    }
    return out(200, { ok: true, autopay: target.event, known: !!(a && a.known) });
  }
  const { data: row, error: rowErr } = await db.from("hangtag_subscription_payments").select("id, amount, status, provider_order_id")
    .eq("provider", provider.name).eq("provider_order_id", target.orderId).maybeSingle();
  if (rowErr) { log.error("subscription-webhook: payment lookup failed:", rowErr.code); return out(503, { ok: false }); }   // the provider retries
  if (!row) return out(200, { ok: true, ignored: true });   // not a Hangtag plan payment
  const d = verifyDecision(row, target.view);
  if (d.action === "activate") {
    const { error } = await db.rpc("hangtag_subscription_activate", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount });
    if (error && error.code === "P0001") {
      log.error("subscription-webhook: activation refused for good (settle by hand):", error.code, row.id, target.orderId, d.ref);
      return out(200, { ok: false, status: "refused" });
    }
    if (error) { log.error("subscription-webhook: activation failed:", error.code); return out(500, { ok: false }); }   // the provider retries
    return out(200, { ok: true, status: "paid" });
  }
  if (d.status === "mismatch") log.error("subscription-webhook: the amount paid isn't the amount due (settle by hand):", row.id, target.orderId);
  if (d.action === "fail") {
    const { error } = await db.rpc("hangtag_subscription_fail", { p_payment: row.id, p_status: d.status });
    if (error) { log.error("subscription-webhook: payment state not recorded:", error.code); return out(500, { ok: false }); }   // the provider retries
  }
  return out(200, { ok: true, status: d.status });
}
