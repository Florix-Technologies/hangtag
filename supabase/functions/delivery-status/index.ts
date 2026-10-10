// Supabase Edge Function "delivery-status": the messaging providers report here what happened to the bills and quotations
// send-receipt handed them, so a receipt shows "Delivered" — or why it failed — without anyone pressing Refresh, and for
// WhatsApp through Meta (whose messages can't be looked up afterwards) at all.
// - Deploy WITHOUT JWT verification (the providers can't sign in):  supabase functions deploy delivery-status --no-verify-jwt
// - Nothing is believed without the provider's own signature (core.js): WhatsApp Cloud API — X-Hub-Signature-256 with
//   WHATSAPP_APP_SECRET; Twilio — X-Twilio-Signature with TWILIO_AUTH_TOKEN over DELIVERY_STATUS_URL?provider=twilio;
//   Resend — the Svix headers with RESEND_WEBHOOK_SECRET. A provider whose secret isn't set is refused (503).
// - Only a message of ours changes: the delivery record with that provider and message id, and only from pending or sent
//   (a delivered receipt never turns failed). Another integration's messages are acknowledged and left alone.
// Set-up (the same address on send-receipt makes Twilio report here):
//   DELIVERY_STATUS_URL = https://<project>.supabase.co/functions/v1/delivery-status
//   Meta: the app → WhatsApp → Configuration → Callback URL <DELIVERY_STATUS_URL>?provider=meta, Verify token = WHATSAPP_VERIFY_TOKEN,
//         Webhook fields: messages.
//   Resend: Webhooks → Add endpoint <DELIVERY_STATUS_URL>?provider=resend, events email.delivered and email.bounced; its
//         signing secret (whsec_…) = RESEND_WEBHOOK_SECRET.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { MAX_BODY, PROVIDERS, callbackUrl, metaChallenge, patchFor, reportsOf, verifyMeta, verifySvix, verifyTwilio } from "./core.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") || "";
  if (!PROVIDERS.includes(provider)) return reply(404, { ok: false, error: "unknown_provider" });
  // Meta's check when the webhook is set up: the agreed token → its challenge back
  if (req.method === "GET" && provider === "meta") {
    const challenge = metaChallenge(url.searchParams, env("WHATSAPP_VERIFY_TOKEN"));
    return challenge === null ? reply(403, { ok: false }) : new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  if (req.method !== "POST") return reply(405, { ok: false });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return reply(413, { ok: false });

  let payload: unknown = null;
  if (provider === "meta") {
    const secret = env("WHATSAPP_APP_SECRET");
    if (!secret) return reply(503, { ok: false, error: "not_configured" });
    if (!(await verifyMeta(secret, raw, req.headers.get("X-Hub-Signature-256") || ""))) return reply(401, { ok: false, error: "bad_signature" });
    try { payload = JSON.parse(raw); } catch { return reply(400, { ok: false, error: "bad_request" }); }
  } else if (provider === "twilio") {
    // Twilio signs the address it was given (send-receipt: callbackUrl(DELIVERY_STATUS_URL, "twilio")), not this server's own
    const token = env("TWILIO_AUTH_TOKEN"), signedUrl = callbackUrl(env("DELIVERY_STATUS_URL"), "twilio");
    if (!token || !signedUrl) return reply(503, { ok: false, error: "not_configured" });
    const form = new URLSearchParams(raw);
    if (!(await verifyTwilio(token, signedUrl, form, req.headers.get("X-Twilio-Signature") || ""))) return reply(401, { ok: false, error: "bad_signature" });
    payload = form;
  } else {
    const secret = env("RESEND_WEBHOOK_SECRET");
    if (!secret) return reply(503, { ok: false, error: "not_configured" });
    if (!(await verifySvix(secret, req.headers, raw))) return reply(401, { ok: false, error: "bad_signature" });
    try { payload = JSON.parse(raw); } catch { return reply(400, { ok: false, error: "bad_request" }); }
  }

  const reports = reportsOf(provider, payload);
  if (!reports.length) return reply(200, { ok: true, ignored: true });   // sent, queued, opened… nothing to record
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let updated = 0;
  for (const r of reports) {
    const p = patchFor(r);
    const { data, error } = await admin.from("hangtag_deliveries").update(p.set)
      .eq("provider", p.match.provider).eq("provider_message_id", p.match.provider_message_id).in("status", p.match.from).select("id");
    if (error) { console.error("delivery-status: couldn't record a report:", provider, error.message); return reply(500, { ok: false }); }   // the provider sends it again
    updated += (data || []).length;
  }
  return reply(200, { ok: true, updated });
});
