// Supabase Edge Function "subscription": Hangtag's plans — checkout and payment confirmation for the signed-in shop owner.
// - The database decides everything that costs money: hangtag_subscription_checkout (called AS the user) computes the plan
//   price and the promo discount and creates the payment; hangtag_subscription_activate (service role) activates it only
//   when the provider confirmed exactly that amount. The app never sends a price, discount or amount (ignored if it does).
// - Provider: providers/index.js — Razorpay or Cashfree payment links with Hangtag's own keys (test credentials only on a
//   test project). Not configured → { available: false }: the app says online payment isn't set up; a 100% promo still
//   works (nothing to pay, activated at once). A payment is always checked with the provider that took it. Cashfree needs
//   the payer's mobile number: the shop's (Settings → Business), asked for when missing.
// - AutoPay (the 30-day trial, then the AutoPay plan monthly; Razorpay): autopay_start checks the provider's plan against
//   the AutoPay terms, then records the owner's consent (hangtag_autopay_begin, AS the owner), makes the mandate and
//   stores it in the registry (service role). Only the provider moves AutoPay on, and only a CAPTURED charge at the price
//   agreed adds paid time (its webhook, or the owner's autopay_verify reading the provider back, at most every 5 minutes).
// - Money counts only in the database's billing mode (after the post-repair migration): keys in the other mode do nothing
//   but config, which then says payment isn't available. billing_selfcheck (console staff who manage settings) proves
//   AutoPay's webhook with a ₹1 link and a far-off subscription, both cancelled at once.
// - The provider is asked a limited number of times per account (after the post-repair migration; REMEDIATION step 11):
//   the payment check 60 a minute and 900 an hour (over it, the database's own answer, "pending" until the notification
//   or the reconciler settles the payment), starting AutoPay 6 a minute and 30 an hour (429).
// - The logic is handler.js (plain JS, tested in Node); this file reads the request and the secrets and adds CORS: the
//   app's origin (APP_URL) and SUBSCRIPTION_ALLOWED_ORIGINS (e.g. the Previews' https://hangtag-*-<team>.vercel.app).
// - Deploy with JWT verification on (the default). Secrets: SUBSCRIPTION_PROVIDER, the provider's keys
//   (SUBSCRIPTION_RAZORPAY_KEY_ID / _KEY_SECRET with SUBSCRIPTION_WEBHOOK_SECRET, or SUBSCRIPTION_CASHFREE_APP_ID /
//   _SECRET_KEY with SUBSCRIPTION_CASHFREE_ENV), APP_URL (return page), SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID (AutoPay's
//   monthly plan at Razorpay); SUBSCRIPTION_TEST_MODE=true only on a test project.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { autopayPlanId, autopayProviderFor, providerFor, providerNamed } from "./providers/index.js";
import { corsOrigin } from "./core.js";
import { handleSubscription } from "./handler.js";

const CORS_BASE = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const allow = corsOrigin(req.headers.get("Origin"), env);
  const cors = { ...CORS_BASE, ...(allow ? { "Access-Control-Allow-Origin": allow } : {}) };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const r = await handleSubscription({ method: req.method, auth: req.headers.get("Authorization"), device: req.headers.get("x-hangtag-device"), json: () => req.json() }, {
    env, provider: providerFor(env), autopay: autopayProviderFor(env), named: (name: string) => providerNamed(name, env), planId: autopayPlanId(env),
    userDb: (auth: string, device: string | null) => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: auth, ...(device ? { "x-hangtag-device": device } : {}) } }, auth: { persistSession: false } }),
    admin: () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }),
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
});
