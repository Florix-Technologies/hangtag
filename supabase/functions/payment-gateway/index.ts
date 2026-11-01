// Supabase Edge Function "payment-gateway": UPI QR and card-link payments on the signed-in shop's OWN Razorpay account.
// - The logic is handler.js (plain JS, tested in Node: tests/unit/payment-gateway-handler.test.mjs); this file reads the
//   request and the secrets, makes the clients and adds CORS.
// - Secrets: PAYMENT_ACCOUNTS_KEY (32 random bytes, base64: seals each shop's keys), PAYMENT_ALLOWED_USERS (the shops a
//   gateway is switched on for; unset = off), PAYMENT_LIVE_MODE=on only once live payments are approved (until then a shop
//   can connect test keys only). No Razorpay keys of Hangtag's: each shop connects its own account (README.md).
// - Needs the shop payments migration (supabase/migrations/20261023120000_hangtag_shop_payments.sql); without it, config
//   says nothing is available. Deploy with JWT verification on (the default). Payments that arrive later are caught by
//   ../payment-webhook as well.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { handlePayment } from "./handler.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const env = Deno.env.toObject();
  const r = await handlePayment({ method: req.method, auth: req.headers.get("Authorization"), device: req.headers.get("x-hangtag-device"), json: () => req.json() }, {
    env,
    userDb: (auth: string, device: string | null) => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: auth, ...(device ? { "x-hangtag-device": device } : {}) } }, auth: { persistSession: false } }),
    admin: () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }),
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
});
