// Supabase Edge Function "payment-webhook": each shop's own Razorpay account tells us about its QR, payment-link and
// refund events here, so money that arrives while no phone is watching (after the QR was closed, or of another amount) is
// still recorded — as "verified" for an open intent of exactly that amount, otherwise as an "unmatched" receipt for the
// shop to refund or allocate — and a refund's outcome is kept.
// - The logic is handler.js (plain JS, tested in Node); this file reads the request and makes the service-role client.
// - Deploy WITHOUT JWT verification (Razorpay can't sign in):  supabase functions deploy payment-webhook --no-verify-jwt
// - Every request must name a connected account (?a=<its hook id>) and carry a valid X-Razorpay-Signature for THAT
//   account's webhook secret; anything else is refused before the body is read as JSON. Secret: PAYMENT_ACCOUNTS_KEY (the
//   same as payment-gateway's: it opens the account's sealed webhook secret).
// - Idempotent: the same event delivered twice is recorded once and changes the intent once.
// The shop sets the webhook up in ITS OWN Razorpay dashboard with the address and events Hangtag shows on connecting.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { handleWebhook } from "./handler.js";

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const r = await handleWebhook({ method: req.method, hookId: new URL(req.url).searchParams.get("a"), signature: req.headers.get("X-Razorpay-Signature"),
    eventId: req.headers.get("X-Razorpay-Event-Id"), text: () => req.text() }, {
    env, admin: () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }),
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
});
