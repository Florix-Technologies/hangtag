// Supabase Edge Function "payment-webhook": Razorpay tells us about QR and payment-link payments here, so money that
// arrives while no phone is watching (after the QR was closed, or of another amount) is still recorded — as "verified"
// for an open intent of exactly that amount, otherwise as an "unmatched" receipt for the shop to refund or allocate.
// - Deploy WITHOUT JWT verification (Razorpay can't sign in):  supabase functions deploy payment-webhook --no-verify-jwt
// - Every request must carry a valid X-Razorpay-Signature (HMAC-SHA256 of the raw body with RAZORPAY_WEBHOOK_SECRET);
//   anything else is refused before the body is read as JSON.
// - Idempotent: the same event delivered twice changes the intent once (core.js nextIntent).
// In the Razorpay dashboard: Webhooks → URL https://<project>.supabase.co/functions/v1/payment-webhook, the same secret,
// events qr_code.credited, qr_code.closed, payment_link.paid, payment_link.expired, payment_link.cancelled.
import { createClient } from "npm:@supabase/supabase-js@2";
import { nextIntent, verifySignature, webhookTarget } from "../payment-gateway/core.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { ok: false });
  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";
  if (!secret) return reply(503, { ok: false, error: "not_configured" });
  const raw = await req.text();
  if (raw.length > 200_000 || !(await verifySignature(raw, req.headers.get("X-Razorpay-Signature") || "", secret))) return reply(400, { ok: false, error: "bad_signature" });
  let event: unknown;
  try { event = JSON.parse(raw); } catch { return reply(400, { ok: false, error: "bad_request" }); }
  const target = webhookTarget(event);
  if (!target) return reply(200, { ok: true, ignored: true });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: row } = await admin.from("hangtag_payment_intents").select("*").eq("provider", "razorpay").eq("provider_intent_id", target.providerIntentId).maybeSingle();
  if (!row) return reply(200, { ok: true, ignored: true });   // not one of ours (or another integration's QR)
  const patch = nextIntent(row, target.view);
  if (!patch) return reply(200, { ok: true, unchanged: true });
  const now = new Date().toISOString();
  const { error } = await admin.from("hangtag_payment_intents").update({ ...patch, checked_at: now, updated_at: now })
    .eq("owner_id", row.owner_id).eq("id", row.id).eq("status", row.status);
  if (error) { console.error("payment-webhook:", error.message); return reply(500, { ok: false }); }   // Razorpay retries
  return reply(200, { ok: true, status: patch.status });
});
