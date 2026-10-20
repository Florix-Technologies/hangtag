// The subscription Edge Function's logic, in plain JS so it runs (and is tested) in Node as in Deno: index.ts only reads
// the request and the secrets, makes the clients and adds the CORS headers. See index.ts for what each action does.
// Money is counted only in the database's billing mode (hangtag_billing_mode, after the post-repair migration): a function
// whose keys are in the other mode refuses every action but config (which then says payment isn't available). Before the
// migration (or after its undo) the older database functions are used, and only live keys pass.
import { PHONE_NEEDED, autopayPlanMatches, autopayStartAt, billingModeAllows, callbackUrl, cancelOrConfirm, description, missingRpc, notifyUrl, payerPhone,
  rpcErrorReply, validateRequest, verifyDecision } from "./core.js";
import { checkMandate } from "./reconcile.js";

const out = (status, body) => ({ status, body });
const notConfigured = (message) => out(503, { ok: false, error: "not_configured", message });

/* req: { method, auth (the Authorization header or null), device (x-hangtag-device or null), json() → the body };
   deps: { env, provider (providerFor(env): new plan payments, or null), autopay (autopayProviderFor(env), or null), named(name)
   → the provider of that name when set up (a payment is checked with the provider that took it), planId (autopayPlanId(env)),
   userDb(auth, device) → a client AS the caller, admin() → the service-role client, now() → ms, log, newId() → a random id } */
export async function handleSubscription(req, { env, provider, autopay = null, named = () => null, planId, userDb, admin, now = () => Date.now(), log = console,
  newId = () => crypto.randomUUID() }) {
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
  const sr = admin();
  if (r.action === "config") {
    // payment and AutoPay offered only in the database's billing mode; AutoPay only when the database offers it to this
    // owner (its terms: switched on and its notifications proven) — any refusal (a team member, an older database) is "no"
    const payOk = !!provider && await billingModeAllows(sr, provider);
    let autopayOk = false;
    if (autopay && planId && await billingModeAllows(sr, autopay)) {
      const { data: q, error } = await db.rpc("hangtag_autopay_quote");
      autopayOk = !error && !!q && q.available === true;
    }
    return out(200, { ok: true, available: payOk, provider: payOk ? provider.name : null, autopay: autopayOk });
  }
  const autopayRow = async () => (await sr.from("hangtag_subscriptions").select("autopay_provider, autopay_subscription_id, autopay_status").eq("owner_id", user.id).maybeSingle()).data;
  /* An AutoPay report through the registry (the older function before the post-repair migration) */
  const report = async (ap, subscriptionId, event, extra = {}) => {
    const r1 = await sr.rpc("hangtag_autopay_report", { p_provider: ap.name, p_subscription: subscriptionId, p_event: event, p_payment: extra.payment || null,
      p_amount: extra.amount == null ? null : extra.amount, p_currency: extra.currency || null, p_next_charge_at: extra.nextChargeAt || null,
      p_event_at: extra.eventAt || null, p_mode: ap.mode });
    if (!r1.error || !missingRpc(r1.error)) return r1;
    return sr.rpc("hangtag_autopay_event", { p_provider: ap.name, p_subscription: subscriptionId, p_event: event, p_next_charge_at: extra.nextChargeAt || null });
  };
  /* The provider asked a limited number of times per account (REMEDIATION step 11; the database counts by the minute and
     the hour): { ok }, or { ok: false, retryAfter } over the limit, { ok: false } when the count can't be read. Before the
     post-repair migration there is no limit, as before. */
  const callAllowed = async (kind) => {
    const { data, error } = await sr.rpc("hangtag_billing_call_claim", { p_owner: user.id, p_kind: kind });
    if (error) return { ok: missingRpc(error) };
    return data && data.ok === false ? { ok: false, retryAfter: Math.max(1, Number(data.retry_after) || 60) } : { ok: true };
  };

  if (r.action === "autopay_start") {
    if (!autopay || !planId) return notConfigured("AutoPay isn't set up yet. Choose a plan instead.");
    if (!(await billingModeAllows(sr, autopay))) return notConfigured("AutoPay isn't available right now. Choose a plan instead.");
    const notReady = () => notConfigured("AutoPay isn't available right now. Choose a plan instead.");
    // the terms first (the shop's owner only), then the provider's plan against them: no consent is recorded for a
    // mandate that couldn't be made
    const { data: q, error: qErr } = await db.rpc("hangtag_autopay_quote");
    if (qErr || !q) { const e = rpcErrorReply(qErr); return out(e.status, e.body); }
    const lim = await callAllowed("autopay_start");
    if (!lim.ok) return lim.retryAfter ? out(429, { ok: false, error: "too_many", message: "Too many tries in a short time. Wait a minute and try again.", retry_after: lim.retryAfter })
      : out(503, { ok: false, error: "server_error", message: "AutoPay couldn't be started. Try again." });
    let plan;
    try { plan = await autopay.getPlan(planId); }
    catch (e) { log.error("subscription: the AutoPay plan couldn't be read:", e && e.status || ""); return out(502, { ok: false, error: "provider_error", message: "AutoPay couldn't be started. Try again." }); }
    if (!autopayPlanMatches(plan, q)) { log.error("subscription: the AutoPay plan at the provider is not the AutoPay plan's price"); return notReady(); }
    // the consent is recorded AS the owner (the database checks the owner, the terms' version and AutoPay's state)
    const { data: t, error: bErr } = await db.rpc("hangtag_autopay_begin", { p_consent: true, p_consent_version: r.consentVersion });
    if (bErr || !t) { const e = rpcErrorReply(bErr); return out(e.status, e.body); }
    // the shop's earlier set-ups, handed back to be cancelled (a waiting or halted one included); one that can't be now
    // stays requested in the registry, for the reconciler — it never stops the new one
    const toCancel = [...(Array.isArray(t.to_cancel) ? t.to_cancel : []), ...(t.previous && t.previous.subscription_id ? [t.previous] : [])];
    for (const old of toCancel.filter((x, i, a) => x && x.subscription_id && a.findIndex((y) => y && y.subscription_id === x.subscription_id) === i)) {
      try {
        const c = await cancelOrConfirm(autopay, old.subscription_id);
        if (c.confirmed) await report(autopay, old.subscription_id, "cancelled");
      } catch { /* the reconciler retries it */ }
    }
    if (!autopayPlanMatches(plan, t)) { log.error("subscription: the AutoPay terms changed while setting up"); return notReady(); }
    try {
      const made = await autopay.createAutopay({ planId, startAt: autopayStartAt(t, now()), expireBy: now() + 24 * 3600e3,
        notes: { hangtag_owner: user.id, ...(t.mandate_id ? { hangtag_mandate: t.mandate_id } : {}) } });
      let current = true, atErr = null;
      if (t.mandate_id) {
        const a = await sr.rpc("hangtag_autopay_attach_mandate", { p_mandate: t.mandate_id, p_provider: autopay.name, p_subscription: made.subscriptionId,
          p_customer: made.customerId, p_mode: autopay.mode });
        if (a.error && missingRpc(a.error)) ({ error: atErr } = await sr.rpc("hangtag_autopay_attach", { p_owner: user.id, p_provider: autopay.name, p_subscription: made.subscriptionId, p_customer: made.customerId }));
        else { atErr = a.error; current = !a.error && !!(a.data && a.data.current); }
      } else {
        ({ error: atErr } = await sr.rpc("hangtag_autopay_attach", { p_owner: user.id, p_provider: autopay.name, p_subscription: made.subscriptionId, p_customer: made.customerId }));
      }
      if (atErr || !current) {
        // not recorded, or turned off (set up again) meanwhile: this mandate is cancelled at once (the registry keeps it to
        // be cancelled if that fails)
        try { const c = await cancelOrConfirm(autopay, made.subscriptionId); if (c.confirmed && !atErr) await report(autopay, made.subscriptionId, "cancelled"); } catch { /* reported below */ }
        if (!atErr) return out(409, { ok: false, error: "changed", message: "AutoPay was changed meanwhile. Try again." });
        throw new Error("attach");
      }
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
      // turned off where it was made
      const ap = named(c.provider || "razorpay");
      if (!ap || typeof ap.cancelAutopay !== "function") return out(503, { ok: false, error: "not_configured", message: "AutoPay can't be reached right now. Try again." });
      if (!(await billingModeAllows(sr, ap))) return notConfigured("AutoPay can't be reached right now. Try again.");
      let st = null;
      try { st = await cancelOrConfirm(ap, c.subscription_id); } catch { st = null; }
      // turned off at the provider (or already off there) — only then recorded
      if (!st || !st.confirmed) return out(502, { ok: false, error: "provider_error", message: "AutoPay couldn't be turned off. Try again." });
      const { error: evErr } = await report(ap, c.subscription_id, "cancelled");
      if (evErr) { log.error("subscription: AutoPay cancel not recorded:", evErr.code); return out(503, { ok: false, error: "server_error", message: "AutoPay was turned off; the app will show it shortly." }); }
    }
    return out(200, { ok: true, status: "cancelled" });
  }
  if (r.action === "autopay_verify") {
    const { error: qErr } = await db.rpc("hangtag_autopay_quote");   // the shop's owner only
    if (qErr) { const e = rpcErrorReply(qErr); return out(e.status, e.body); }
    const row = await autopayRow();
    const ap = row && row.autopay_subscription_id ? named(row.autopay_provider || "razorpay") : null;
    if (!row || !row.autopay_subscription_id || !ap || typeof ap.getAutopay !== "function") return out(200, { ok: true, status: row ? row.autopay_status : "none" });
    if (!(await billingModeAllows(sr, ap))) return out(200, { ok: true, status: row.autopay_status });
    // read from the provider at most every 5 minutes (the registry stamps it); the owner's own set-up only
    const { data: claim, error: clErr } = await sr.rpc("hangtag_autopay_check_claim", { p_owner: user.id });
    if (clErr && !missingRpc(clErr)) return out(503, { ok: false, error: "server_error", message: "AutoPay couldn't be checked. Try again." });
    if (!clErr && !claim) return out(200, { ok: true, status: row.autopay_status });
    try {
      if (claim) {
        // the reconciler's own check of one set-up: its state, and any captured charge no notification recorded
        await checkMandate({ sr, mode: ap.mode, autopay: ap, now, log, run: { checked: 0, repaired: 0, exceptions_opened: 0 }, spend: () => {} },
          { ...claim, reason: "check" });
      } else {
        // before the post-repair migration: the provider's word on the mandate only; money only from its webhook
        const st = await ap.getAutopay(row.autopay_subscription_id);
        if (st.event) {
          const { error: evErr } = await report(ap, row.autopay_subscription_id, st.event, { nextChargeAt: st.nextChargeAt });
          if (evErr) log.error("subscription: AutoPay state not recorded:", evErr.code);
        }
      }
    } catch (e) {
      if (e && e.code) log.error("subscription: AutoPay check not recorded:", e.code);
      else return out(502, { ok: false, error: "provider_error", message: "AutoPay couldn't be checked. Try again." });
    }
    const nowRow = await autopayRow();
    return out(200, { ok: true, status: nowRow ? nowRow.autopay_status : "none" });
  }
  if (r.action === "billing_selfcheck") {
    // console staff who manage settings (the database checks it, once in 10 minutes, and logs it before anything is made)
    const { error: allowErr } = await db.rpc("hangtag_billing_selfcheck_allowed");
    if (allowErr) return out(403, { ok: false, error: "forbidden", message: allowErr.code === "P0001" ? String(allowErr.message || "").slice(0, 160) : "Only console staff who manage settings can run this." });
    if (!autopay || !planId || typeof autopay.createProbeLink !== "function") return notConfigured("AutoPay's provider isn't set up here.");
    if (!(await billingModeAllows(sr, autopay))) return notConfigured("This database counts money in another mode than the provider's keys.");
    const ref = newId(), steps = {};
    const step = async (name, fn) => { try { await fn(); steps[name] = "ok"; } catch (e) { steps[name] = "failed"; log.error(`subscription: self-check ${name} failed:`, e && (e.status || e.code) || ""); } };
    let link = null, sub = null;
    await step("link_made", async () => {
      link = await autopay.createProbeLink(ref);
      const { error } = await sr.rpc("hangtag_billing_probe_record", { p_provider: autopay.name, p_kind: "payment_link", p_entity: link, p_mode: autopay.mode });
      if (error) throw Object.assign(new Error("db"), { code: error.code });
    });
    if (link) await step("link_cancelled", () => autopay.cancelPayment(link));
    await step("subscription_made", async () => {
      sub = await autopay.createProbeAutopay({ planId, ref });
      const { error } = await sr.rpc("hangtag_billing_probe_record", { p_provider: autopay.name, p_kind: "subscription", p_entity: sub, p_mode: autopay.mode });
      if (error) throw Object.assign(new Error("db"), { code: error.code });
    });
    if (sub) await step("subscription_cancelled", async () => { const c = await cancelOrConfirm(autopay, sub); if (!c.confirmed && c.status !== "created") throw new Error("cancel"); });
    return out(200, { ok: Object.values(steps).every((v) => v === "ok"), steps,
      next: "Within a few minutes the webhook's payment_link.cancelled and subscription.cancelled notifications appear in billing health." });
  }

  if (r.action === "checkout") {
    // the price first (owner only, promo checked): nothing is created when there is nothing that could take the payment
    const { data: q, error: qErr } = await db.rpc("hangtag_subscription_quote", { p_plan: r.plan, p_promo: r.promo });
    if (qErr) { const e = rpcErrorReply(qErr); return out(e.status, e.body); }
    if (q && q.promo && q.promo.valid === false) return out(400, { ok: false, error: "promo", reason: q.promo.reason, message: q.promo.message });
    if (!provider && Number(q && q.amount) > 0) return notConfigured("Online payment isn't set up yet. Contact Hangtag support to renew.");
    if (provider && Number(q && q.amount) > 0 && !(await billingModeAllows(sr, provider))) return notConfigured("Online payment isn't available right now. Contact Hangtag support to renew.");
    // a provider that needs the payer's mobile number (Cashfree) gets the shop's — asked for before any payment is made
    let phone = "";
    if (provider && provider.needsPhone && Number(q && q.amount) > 0) {
      const { data: prof } = await db.from("hangtag_profiles").select("phone").eq("id", user.id).maybeSingle();
      phone = payerPhone((prof && prof.phone) || user.phone || "");
      if (!phone) return out(400, { ok: false, error: "phone_required", message: PHONE_NEEDED });
    }
    const { data: c, error: cErr } = await db.rpc("hangtag_subscription_checkout", { p_plan: r.plan, p_promo: r.promo, p_provider: provider ? provider.name : "none" });
    if (cErr || !c) { const e = rpcErrorReply(cErr); return out(e.status, e.body); }
    if (Number(c.amount) === 0) {
      const { data: a, error: aErr } = await sr.rpc("hangtag_subscription_activate", { p_payment: c.payment_id, p_provider_payment: "free:" + c.payment_id, p_amount: 0 });
      if (aErr) { log.error("subscription: free activation failed:", aErr.code); return out(503, { ok: false, error: "server_error", message: "Couldn't start the plan. Try again." }); }
      // the code's limits are checked again under a lock: a burst of free checkouts gives one plan, not several
      if (a && a.ok === false) return out(409, { ok: false, error: "promo", reason: a.reason || "promo_limit", message: a.message || "This promo code has already been used." });
      return out(200, { ok: true, free: true, payment_id: c.payment_id, status: "paid", amount: 0, state: a.state, period_end: a.period_end });
    }
    if (c.cancel_mandate && c.cancel_mandate.subscription_id) {
      // an AutoPay the provider halted: turned off first, so it can't charge as well — or no payment by hand
      const ap = named(c.cancel_mandate.provider || "razorpay");
      let done = false;
      try { done = !!ap && (await cancelOrConfirm(ap, c.cancel_mandate.subscription_id)).confirmed; } catch { done = false; }
      if (done) {
        const { error } = await report(ap, c.cancel_mandate.subscription_id, "cancelled");
        if (error) log.error("subscription: the halted AutoPay's cancel wasn't recorded:", error.code);
      } else {
        await sr.rpc("hangtag_subscription_fail", { p_payment: c.payment_id, p_status: "failed" });
        return out(502, { ok: false, error: "provider_error", message: "Your stopped AutoPay couldn't be turned off first. Try again." });
      }
    }
    let page;
    try {
      page = await provider.createPayment({ paymentId: c.payment_id, amount: Number(c.amount), currency: c.currency, description: description(c), email: user.email,
        phone, callbackUrl: callbackUrl(env, c.payment_id), notifyUrl: notifyUrl(env) });
    } catch (e) {
      log.error("subscription: provider checkout failed:", e && e.status || "");
      await sr.rpc("hangtag_subscription_fail", { p_payment: c.payment_id, p_status: "failed" });
      return out(502, { ok: false, error: "provider_error", message: "The payment page couldn't be opened. Try again." });
    }
    const { error: atErr } = await sr.rpc("hangtag_subscription_attach", { p_payment: c.payment_id, p_provider: provider.name, p_order: page.orderId });
    if (atErr) {
      // the page can't be recorded against its payment: withdrawn, so nobody pays a page no payment holds
      try { if (typeof provider.cancelPayment === "function") await provider.cancelPayment(page.orderId); } catch { log.error("subscription: an unrecorded payment page couldn't be withdrawn:", page.orderId); }
      if (atErr.code === "P0001") return out(409, { ok: false, error: "changed", message: "This payment changed meanwhile. Choose Pay again." });
      log.error("subscription: the payment page wasn't recorded:", atErr.code);
      await sr.rpc("hangtag_subscription_fail", { p_payment: c.payment_id, p_status: "failed" });
      return out(502, { ok: false, error: "provider_error", message: "The payment page couldn't be opened. Try again." });
    }
    return out(200, { ok: true, payment_id: c.payment_id, amount: Number(c.amount), currency: c.currency, pay_url: page.payUrl, provider: provider.name });
  }

  // verify: the payment must be one of the caller's own (row security: the owner reads only the shop's payments)
  const { data: row, error: rowErr } = await db.from("hangtag_subscription_payments").select("id, owner_id, amount, currency, status, provider, provider_order_id, period_end").eq("id", r.paymentId).maybeSingle();
  if (rowErr) { const e = rpcErrorReply(rowErr); return out(e.status, e.body); }
  if (!row || row.owner_id !== user.id) return out(404, { ok: false, error: "not_found", message: "Unknown payment." });
  if (row.status === "paid") return out(200, { ok: true, status: "paid", period_end: row.period_end });
  // asked of the provider that took it (still answered after the provider for new payments changed)
  const taker = named(row.provider) || (provider && provider.name === row.provider ? provider : null);
  if (!taker || !row.provider_order_id) return out(200, { ok: true, status: row.status === "created" ? "pending" : row.status });
  if (!(await billingModeAllows(sr, taker))) return out(200, { ok: true, status: row.status === "created" ? "pending" : row.status });
  // over the account's limit (or when it can't be counted): the database's own answer, without asking the provider — the
  // notification and the reconciler still settle the payment
  const lim = await callAllowed("verify");
  if (!lim.ok) return out(200, { ok: true, status: row.status === "created" ? "pending" : row.status, ...(lim.retryAfter ? { retry_after: lim.retryAfter } : {}) });
  let view;
  try { view = await taker.getPayment(row.provider_order_id); }
  catch { return out(502, { ok: false, error: "provider_error", message: "The payment couldn't be checked. Try again." }); }
  const d = verifyDecision(row, view);
  if (d.action === "activate") {
    let { data: a, error: aErr } = await sr.rpc("hangtag_subscription_activate_checked", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount, p_mode: taker.mode });
    if (aErr && missingRpc(aErr)) ({ data: a, error: aErr } = await sr.rpc("hangtag_subscription_activate", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount }));
    if (aErr && aErr.code !== "P0001") { log.error("subscription: activation failed:", aErr.code); return out(503, { ok: false, error: "server_error", message: "The payment couldn't be recorded yet. Try again in a moment." }); }
    if (aErr || (a && a.ok === false && a.reason === "refunded")) { log.error("subscription: activation refused:", aErr ? aErr.code : "refunded"); return out(409, { ok: false, error: "activation_failed", message: "The payment couldn't be matched to your plan. Contact Hangtag support." }); }
    return out(200, { ok: true, status: "paid", state: a.state, plan_code: a.plan_code, period_end: a.period_end });
  }
  if (d.action === "fail") await sr.rpc("hangtag_subscription_fail", { p_payment: row.id, p_status: d.status });
  if (d.status === "mismatch" || d.status === "currency_mismatch") return out(409, { ok: false, error: "amount_mismatch", message: "The amount paid isn't the plan's amount. Contact Hangtag support." });
  return out(200, { ok: true, status: d.status });
}
