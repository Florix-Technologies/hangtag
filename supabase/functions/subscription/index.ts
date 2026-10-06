// Supabase Edge Function "subscription": Hangtag's plans — checkout and payment confirmation for the signed-in shop owner.
// - The database decides everything that costs money: hangtag_subscription_checkout (called AS the user) computes the plan
//   price and the promo discount and creates the payment; hangtag_subscription_activate (service role) activates it only
//   when the provider confirmed exactly that amount. The app never sends a price, discount or amount (ignored if it does).
// - Provider: providers/index.js (Razorpay Payment Links with Hangtag's own keys). Not configured → { available: false }:
//   the app says online payment isn't set up; a 100% promo still works (nothing to pay, activated at once).
// - Deploy with JWT verification on (the default). Secrets: SUBSCRIPTION_PROVIDER=razorpay, SUBSCRIPTION_RAZORPAY_KEY_ID,
//   SUBSCRIPTION_RAZORPAY_KEY_SECRET, SUBSCRIPTION_WEBHOOK_SECRET (for subscription-webhook), APP_URL (return page).
import { createClient } from "npm:@supabase/supabase-js@2";
import { callbackUrl, description, rpcErrorReply, validateRequest, verifyDecision } from "./core.js";
import { providerFor } from "./providers/index.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  const auth = req.headers.get("Authorization");
  if (!auth) return reply(401, { ok: false, error: "unauthorized", message: "Sign in first." });
  const env = Deno.env.toObject();
  const device = req.headers.get("x-hangtag-device");
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { global: { headers: { Authorization: auth, ...(device ? { "x-hangtag-device": device } : {}) } }, auth: { persistSession: false } });
  const { data: who } = await db.auth.getUser();
  const user = who && who.user;
  if (!user) return reply(401, { ok: false, error: "unauthorized", message: "Sign in again." });

  let body: unknown;
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_request", message: "Send the request as JSON." }); }
  const r = validateRequest(body);
  if (!r.ok) return reply(r.status, { ok: false, error: r.error, message: r.message });
  const provider = providerFor(env);
  if (r.action === "config") return reply(200, { ok: true, available: !!provider, provider: provider ? provider.name : null });
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  if (r.action === "checkout") {
    // the price first (owner only, promo checked): nothing is created when there is nothing that could take the payment
    const { data: q, error: qErr } = await db.rpc("hangtag_subscription_quote", { p_plan: r.plan, p_promo: r.promo });
    if (qErr) { const e = rpcErrorReply(qErr); return reply(e.status, e.body); }
    if (q && q.promo && q.promo.valid === false) return reply(400, { ok: false, error: "promo", reason: q.promo.reason, message: q.promo.message });
    if (!provider && Number(q && q.amount) > 0) return reply(503, { ok: false, error: "not_configured", message: "Online payment isn't set up yet. Contact Hangtag support to renew." });
    const { data: c, error: cErr } = await db.rpc("hangtag_subscription_checkout", { p_plan: r.plan, p_promo: r.promo, p_provider: provider ? provider.name : "none" });
    if (cErr || !c) { const e = rpcErrorReply(cErr); return reply(e.status, e.body); }
    if (Number(c.amount) === 0) {
      const { data: a, error: aErr } = await admin.rpc("hangtag_subscription_activate", { p_payment: c.payment_id, p_provider_payment: "free:" + c.payment_id, p_amount: 0 });
      if (aErr) { console.error("subscription: free activation failed:", aErr.code); return reply(503, { ok: false, error: "server_error", message: "Couldn't start the plan. Try again." }); }
      // the code's limits are checked again under a lock: a burst of free checkouts gives one plan, not several
      if (a && a.ok === false) return reply(409, { ok: false, error: "promo", reason: a.reason || "promo_limit", message: a.message || "This promo code has already been used." });
      return reply(200, { ok: true, free: true, payment_id: c.payment_id, status: "paid", amount: 0, state: a.state, period_end: a.period_end });
    }
    try {
      const page = await provider!.createPayment({ paymentId: c.payment_id, amount: Number(c.amount), currency: c.currency, description: description(c), email: user.email, callbackUrl: callbackUrl(env, c.payment_id) });
      const { error: atErr } = await admin.rpc("hangtag_subscription_attach", { p_payment: c.payment_id, p_provider: provider!.name, p_order: page.orderId });
      if (atErr) throw new Error("attach");
      return reply(200, { ok: true, payment_id: c.payment_id, amount: Number(c.amount), currency: c.currency, pay_url: page.payUrl, provider: provider!.name });
    } catch (e) {
      console.error("subscription: provider checkout failed:", (e as { status?: number }).status || "");
      await admin.rpc("hangtag_subscription_fail", { p_payment: c.payment_id, p_status: "failed" });
      return reply(502, { ok: false, error: "provider_error", message: "The payment page couldn't be opened. Try again." });
    }
  }

  // verify: the payment must be one of the caller's own (row security: the owner reads only the shop's payments)
  const { data: row, error: rowErr } = await db.from("hangtag_subscription_payments").select("id, owner_id, amount, status, provider, provider_order_id, period_end").eq("id", r.paymentId).maybeSingle();
  if (rowErr) { const e = rpcErrorReply(rowErr); return reply(e.status, e.body); }
  if (!row || row.owner_id !== user.id) return reply(404, { ok: false, error: "not_found", message: "Unknown payment." });
  if (row.status === "paid") return reply(200, { ok: true, status: "paid", period_end: row.period_end });
  if (!provider || !row.provider_order_id) return reply(200, { ok: true, status: row.status === "created" ? "pending" : row.status });
  let view;
  try { view = await provider.getPayment(row.provider_order_id); }
  catch { return reply(502, { ok: false, error: "provider_error", message: "The payment couldn't be checked. Try again." }); }
  const d = verifyDecision(row, view);
  if (d.action === "activate") {
    const { data: a, error: aErr } = await admin.rpc("hangtag_subscription_activate", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount });
    if (aErr) { console.error("subscription: activation refused:", aErr.code); return reply(409, { ok: false, error: "activation_failed", message: "The payment couldn't be matched to your plan. Contact Hangtag support." }); }
    return reply(200, { ok: true, status: "paid", state: a.state, plan_code: a.plan_code, period_end: a.period_end });
  }
  if (d.action === "fail") await admin.rpc("hangtag_subscription_fail", { p_payment: row.id, p_status: d.status });
  if (d.status === "mismatch") return reply(409, { ok: false, error: "amount_mismatch", message: "The amount paid isn't the plan's amount. Contact Hangtag support." });
  return reply(200, { ok: true, status: d.status });
});
