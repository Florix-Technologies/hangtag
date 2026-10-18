// Supabase Edge Function "subscription": Hangtag's plans — checkout and payment confirmation for the signed-in shop owner.
// - The database decides everything that costs money: hangtag_subscription_checkout (called AS the user) computes the plan
//   price and the promo discount and creates the payment; hangtag_subscription_activate (service role) activates it only
//   when the provider confirmed exactly that amount. The app never sends a price, discount or amount (ignored if it does).
// - Provider: providers/index.js (Razorpay Payment Links with Hangtag's own keys). Not configured → { available: false }:
//   the app says online payment isn't set up; a 100% promo still works (nothing to pay, activated at once).
// - AutoPay (the 30-day trial, then the AutoPay plan monthly): autopay_start checks the provider's plan against the AutoPay
//   terms, then records the owner's consent in the database (hangtag_autopay_begin, AS the owner), makes the mandate and
//   stores it (service role). Only the provider's reports move AutoPay on (autopay_verify asks it; subscription-webhook
//   is told) and only a CAPTURED charge (webhook) adds paid time. autopay_cancel turns it off at the provider first.
// - The logic is handler.js (plain JS, tested in Node); this file reads the request and the secrets and adds CORS.
// - Deploy with JWT verification on (the default). Secrets: SUBSCRIPTION_PROVIDER=razorpay, SUBSCRIPTION_RAZORPAY_KEY_ID,
//   SUBSCRIPTION_RAZORPAY_KEY_SECRET, SUBSCRIPTION_WEBHOOK_SECRET (for subscription-webhook), APP_URL (return page),
//   SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID (AutoPay's monthly plan at the provider); test keys only with
//   SUBSCRIPTION_TEST_MODE=true (providers/index.js).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { autopayPlanId, providerFor } from "./providers/index.js";
import { handleSubscription } from "./handler.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const env = Deno.env.toObject();
  const r = await handleSubscription({ method: req.method, auth: req.headers.get("Authorization"), device: req.headers.get("x-hangtag-device"), json: () => req.json() }, {
    env, provider: providerFor(env), planId: autopayPlanId(env),
    userDb: (auth: string, device: string | null) => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: auth, ...(device ? { "x-hangtag-device": device } : {}) } }, auth: { persistSession: false } }),
    admin: () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }),
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
});
