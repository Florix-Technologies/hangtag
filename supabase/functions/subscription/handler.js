// The subscription Edge Function's logic, in plain JS so it runs (and is tested) in Node as in Deno: index.ts only reads
// the request and the secrets, makes the clients and adds the CORS headers. See index.ts for what each action does.
import { autopayPlanMatches, autopayStartAt, callbackUrl, description, rpcErrorReply, validateRequest, verifyDecision } from "./core.js";

const out = (status, body) => ({ status, body });

/* req: { method, auth (the Authorization header or null), device (x-hangtag-device or null), json() → the body };
   deps: { env, provider (providerFor(env) or null), planId (autopayPlanId(env)), userDb(auth, device) → a client AS the
   caller, admin() → the service-role client, now() → ms, log } */
export async function handleSubscription(req, { env, provider, planId, userDb, admin, now = () => Date.now(), log = console }) {
  if (req.method !== "POST") return out(405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  if (!req.auth) return out(401, { ok: false, error: "unauthorized", message: "Sign in first." });
  const db = userDb(req.auth, req.device);
  const { data: who } = await db.auth.getUser();
  const user = who && who.user;
  if (!user) return out(401, { ok: false, error: "unauthorized", message: "Sign in again." });

  let body;
  try { body = await req.json(); } catch { return out(400, { ok: false, error: "bad_request", message: "Send the request as JSON." }); }
  const r = validateRequest(body);
  if (!r.ok) return out(r.status, { ok: false, error: r.error, message: r.message });
  if (r.action === "config") return out(200, { ok: true, available: !!provider, provider: provider ? provider.name : null, autopay: !!(provider && planId) });
  const sr = admin();
  const autopayRow = async () => (await sr.from("hangtag_subscriptions").select("autopay_provider, autopay_subscription_id, autopay_status").eq("owner_id", user.id).maybeSingle()).data;

  if (r.action === "autopay_start") {
    if (!provider || !planId) return out(503, { ok: false, error: "not_configured", message: "AutoPay isn't set up yet. Choose a plan instead." });
    const notReady = () => out(503, { ok: false, error: "not_configured", message: "AutoPay isn't available right now. Choose a plan instead." });
    // the terms first (the shop's owner only), then the provider's plan against them: no consent is recorded for a
    // mandate that couldn't be made
    const { data: q, error: qErr } = await db.rpc("hangtag_autopay_quote");
    if (qErr || !q) { const e = rpcErrorReply(qErr); return out(e.status, e.body); }
    let plan;
    try { plan = await provider.getPlan(planId); }
    catch (e) { log.error("subscription: the AutoPay plan couldn't be read:", e && e.status || ""); return out(502, { ok: false, error: "provider_error", message: "AutoPay couldn't be started. Try again." }); }
    if (!autopayPlanMatches(plan, q)) { log.error("subscription: the AutoPay plan at the provider is not the AutoPay plan's price"); return notReady(); }
    // the consent is recorded AS the owner (the database checks the owner, the terms' version and AutoPay's state)
    const { data: t, error: bErr } = await db.rpc("hangtag_autopay_begin", { p_consent: true, p_consent_version: r.consentVersion });
    if (bErr || !t) { const e = rpcErrorReply(bErr); return out(e.status, e.body); }
    if (t.previous && t.previous.subscription_id) { try { await provider.cancelAutopay(t.previous.subscription_id); } catch { /* never authorised: nothing more to stop */ } }
    if (!autopayPlanMatches(plan, t)) { log.error("subscription: the AutoPay terms changed while setting up"); return notReady(); }
    try {
      const made = await provider.createAutopay({ planId, startAt: autopayStartAt(t, now()), notes: { hangtag_owner: user.id }, expireBy: now() + 24 * 3600e3 });
      const { error: atErr } = await sr.rpc("hangtag_autopay_attach", { p_owner: user.id, p_provider: provider.name, p_subscription: made.subscriptionId, p_customer: made.customerId });
      if (atErr) { try { await provider.cancelAutopay(made.subscriptionId); } catch { /* reported below */ } throw new Error("attach"); }
      return out(200, { ok: true, auth_url: made.authUrl, first_charge_at: t.first_charge_at, today: Number(t.today), price: Number(t.price), currency: t.currency });
    } catch (e) {
      log.error("subscription: AutoPay set-up failed:", e && e.status || "");
      return out(502, { ok: false, error: "provider_error", message: "AutoPay couldn't be started. Try again." });
    }
  }
  if (r.action === "autopay_cancel") {
    const { data: c, error: cErr } = await db.rpc("hangtag_autopay_cancel_request");
    if (cErr || !c) { const e = rpcErrorReply(cErr); return out(e.status, e.body); }
    if (c.subscription_id) {
      if (!provider) return out(503, { ok: false, error: "not_configured", message: "AutoPay can't be reached right now. Try again." });
      let st = null;
      try { st = await provider.cancelAutopay(c.subscription_id); }
      catch { try { st = await provider.getAutopay(c.subscription_id); } catch { st = null; } }
      // turned off at the provider (or already off there) — only then recorded
      if (!st || !["cancelled", "completed", "expired"].includes(String(st.event))) return out(502, { ok: false, error: "provider_error", message: "AutoPay couldn't be turned off. Try again." });
      const { error: evErr } = await sr.rpc("hangtag_autopay_event", { p_provider: c.provider, p_subscription: c.subscription_id, p_event: "cancelled" });
      if (evErr) { log.error("subscription: AutoPay cancel not recorded:", evErr.code); return out(503, { ok: false, error: "server_error", message: "AutoPay was turned off; the app will show it shortly." }); }
    }
    return out(200, { ok: true, status: "cancelled" });
  }
  if (r.action === "autopay_verify") {
    const { error: qErr } = await db.rpc("hangtag_autopay_quote");   // the shop's owner only
    if (qErr) { const e = rpcErrorReply(qErr); return out(e.status, e.body); }
    const row = await autopayRow();
    if (!row || !row.autopay_subscription_id || !provider) return out(200, { ok: true, status: row ? row.autopay_status : "none" });
    let st;
    try { st = await provider.getAutopay(row.autopay_subscription_id); }
    catch { return out(502, { ok: false, error: "provider_error", message: "AutoPay couldn't be checked. Try again." }); }
    // the provider's word on the mandate; money is recorded only from its webhook, with the captured payment
    if (st.event) {
      const { error: evErr } = await sr.rpc("hangtag_autopay_event", { p_provider: row.autopay_provider, p_subscription: row.autopay_subscription_id, p_event: st.event, p_next_charge_at: st.nextChargeAt });
      if (evErr) log.error("subscription: AutoPay state not recorded:", evErr.code);
    }
    const nowRow = await autopayRow();
    return out(200, { ok: true, status: nowRow ? nowRow.autopay_status : "none" });
  }

  if (r.action === "checkout") {
    // the price first (owner only, promo checked): nothing is created when there is nothing that could take the payment
    const { data: q, error: qErr } = await db.rpc("hangtag_subscription_quote", { p_plan: r.plan, p_promo: r.promo });
    if (qErr) { const e = rpcErrorReply(qErr); return out(e.status, e.body); }
    if (q && q.promo && q.promo.valid === false) return out(400, { ok: false, error: "promo", reason: q.promo.reason, message: q.promo.message });
    if (!provider && Number(q && q.amount) > 0) return out(503, { ok: false, error: "not_configured", message: "Online payment isn't set up yet. Contact Hangtag support to renew." });
    const { data: c, error: cErr } = await db.rpc("hangtag_subscription_checkout", { p_plan: r.plan, p_promo: r.promo, p_provider: provider ? provider.name : "none" });
    if (cErr || !c) { const e = rpcErrorReply(cErr); return out(e.status, e.body); }
    if (Number(c.amount) === 0) {
      const { data: a, error: aErr } = await sr.rpc("hangtag_subscription_activate", { p_payment: c.payment_id, p_provider_payment: "free:" + c.payment_id, p_amount: 0 });
      if (aErr) { log.error("subscription: free activation failed:", aErr.code); return out(503, { ok: false, error: "server_error", message: "Couldn't start the plan. Try again." }); }
      // the code's limits are checked again under a lock: a burst of free checkouts gives one plan, not several
      if (a && a.ok === false) return out(409, { ok: false, error: "promo", reason: a.reason || "promo_limit", message: a.message || "This promo code has already been used." });
      return out(200, { ok: true, free: true, payment_id: c.payment_id, status: "paid", amount: 0, state: a.state, period_end: a.period_end });
    }
    try {
      const page = await provider.createPayment({ paymentId: c.payment_id, amount: Number(c.amount), currency: c.currency, description: description(c), email: user.email, callbackUrl: callbackUrl(env, c.payment_id) });
      const { error: atErr } = await sr.rpc("hangtag_subscription_attach", { p_payment: c.payment_id, p_provider: provider.name, p_order: page.orderId });
      if (atErr) throw new Error("attach");
      return out(200, { ok: true, payment_id: c.payment_id, amount: Number(c.amount), currency: c.currency, pay_url: page.payUrl, provider: provider.name });
    } catch (e) {
      log.error("subscription: provider checkout failed:", e && e.status || "");
      await sr.rpc("hangtag_subscription_fail", { p_payment: c.payment_id, p_status: "failed" });
      return out(502, { ok: false, error: "provider_error", message: "The payment page couldn't be opened. Try again." });
    }
  }

  // verify: the payment must be one of the caller's own (row security: the owner reads only the shop's payments)
  const { data: row, error: rowErr } = await db.from("hangtag_subscription_payments").select("id, owner_id, amount, status, provider, provider_order_id, period_end").eq("id", r.paymentId).maybeSingle();
  if (rowErr) { const e = rpcErrorReply(rowErr); return out(e.status, e.body); }
  if (!row || row.owner_id !== user.id) return out(404, { ok: false, error: "not_found", message: "Unknown payment." });
  if (row.status === "paid") return out(200, { ok: true, status: "paid", period_end: row.period_end });
  if (!provider || !row.provider_order_id) return out(200, { ok: true, status: row.status === "created" ? "pending" : row.status });
  let view;
  try { view = await provider.getPayment(row.provider_order_id); }
  catch { return out(502, { ok: false, error: "provider_error", message: "The payment couldn't be checked. Try again." }); }
  const d = verifyDecision(row, view);
  if (d.action === "activate") {
    const { data: a, error: aErr } = await sr.rpc("hangtag_subscription_activate", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount });
    if (aErr && aErr.code !== "P0001") { log.error("subscription: activation failed:", aErr.code); return out(503, { ok: false, error: "server_error", message: "The payment couldn't be recorded yet. Try again in a moment." }); }
    if (aErr) { log.error("subscription: activation refused:", aErr.code); return out(409, { ok: false, error: "activation_failed", message: "The payment couldn't be matched to your plan. Contact Hangtag support." }); }
    return out(200, { ok: true, status: "paid", state: a.state, plan_code: a.plan_code, period_end: a.period_end });
  }
  if (d.action === "fail") await sr.rpc("hangtag_subscription_fail", { p_payment: row.id, p_status: d.status });
  if (d.status === "mismatch") return out(409, { ok: false, error: "amount_mismatch", message: "The amount paid isn't the plan's amount. Contact Hangtag support." });
  return out(200, { ok: true, status: d.status });
}
