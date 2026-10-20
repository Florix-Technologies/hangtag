// The subscription-webhook Edge Function's logic, in plain JS so it runs (and is tested) in Node as in Deno: index.ts only
// reads the request and the secrets, makes the client and sends the answer.
// What the provider is told decides whether it sends the notification again (Razorpay and Cashfree retry anything that
// isn't a 2xx; both deliver at least once), so the answer is a 2xx only once the notification is settled, or can never be:
// - a database or provider that can't be asked, or refuses for a reason that may pass: 5xx — sent again;
// - money that can't be matched (an amount or currency that isn't due, a payment that names another payment, an
//   activation refused for good, a refund or a dispute, money on a Hangtag link or AutoPay no payment recorded): 200, kept
//   for review (hangtag_billing_exceptions) — never activated, never time taken away by itself;
// - a notification of nothing Hangtag sells (another product on the same provider account, a dashboard test): 200, ignored;
// - a notification in another billing mode than the database's (test keys on the live project, or the reverse): 200,
//   never acted on, kept for review (a 5xx would only make the provider stop sending, while the setting is wrong);
// - the self-check's own objects (notes.hangtag_probe): noted, which proves the webhook; never acted on;
// - the same notification again, once settled: 200, nothing done twice (hangtag_billing_events).
// A notification is only a nudge where the provider allows it (Cashfree): the payment is read from the provider's API.
// Before the post-repair migration (or after its undo) the older database functions are used, live keys only.
import { cancelOrConfirm, missingRpc, verifyDecision, withBudget } from "../subscription/core.js";

const out = (status, body) => ({ status, body });
/* Money reported (by the notification, or by the provider's own figures) that its API doesn't show as a payment yet: not
   settled, so the provider sends it again. Only where the state was read from the API (Cashfree): a state taken from the
   notification itself (Razorpay) would come back the same every time. */
const settling = (target, view) => !target.view && !!view && view.state === "pending" && (view.paid > 0 || !!target.claimsPaid);
const TERMINAL = ["cancelled", "completed", "expired"];

/* req: { method, raw (the body as text), headers (lower-case names) }; provider: webhookProviderFor(env, headers) or null;
   admin(): the service-role client (made only after the signature is checked); log: console-like; cancelBudgetMs: how long
   an AutoPay cancel at the provider may take before the answer goes back (the reconciler finishes what doesn't) */
export async function handleWebhook({ method, raw, headers }, { provider, admin, log = console, cancelBudgetMs = 2000 }) {
  if (method !== "POST") return out(405, { ok: false });
  // no provider's signature header at all: not a provider's notification (refused for good, not "send again")
  const h = headers || {};
  if (!provider && !h["x-webhook-signature"] && !h["x-razorpay-signature"]) return out(400, { ok: false, error: "bad_signature" });
  if (!provider || !provider.webhookReady) return out(503, { ok: false, error: "not_configured" });
  const body = typeof raw === "string" ? raw : "";
  if (body.length > 200_000 || !(await provider.verifyWebhook(body, h))) return out(400, { ok: false, error: "bad_signature" });
  let event = null;
  try { event = JSON.parse(body); }
  catch {
    // Cashfree may send a payment-link event as form data; its link is then read from the (signed) text itself
    if (provider.name !== "cashfree") return out(400, { ok: false, error: "bad_request" });
    try { event = Object.fromEntries(new URLSearchParams(body)); } catch { event = {}; }
  }
  const target = provider.readWebhook(event, body);
  if (!target) return out(200, { ok: true, ignored: true });
  const db = admin();
  const eventId = typeof provider.eventIdOf === "function" ? await provider.eventIdOf(body, h) : null;
  // the database's billing mode first, and whether this notification was settled before
  const seen = await ledgerSeen(db, provider, eventId);
  if (seen.error) { log.error("subscription-webhook: the ledger couldn't be read:", seen.error); return out(503, { ok: false }); }
  if (!seen.modeOk) {
    log.error("subscription-webhook: a notification in another billing mode, not acted on:", provider.name, provider.mode, "on", seen.billingMode || "an unmigrated database");
    await exception(db, log, provider, "mode_mismatch", eventId || target.entityId || "unknown", { amount: target.amount == null ? null : target.amount,
      detail: { type: target.type || target.kind, entity: target.entityId || target.orderId || target.subscriptionId || null, payment: target.paymentId || null,
        mode: provider.mode, billing_mode: seen.billingMode || null } });
    return out(200, { ok: true, ignored: true, mode_mismatch: true });
  }
  if (seen.duplicate) return out(200, { ok: true, duplicate: true });
  const r = target.probe ? out(200, { ok: true, probe: true })
    : target.kind === "autopay" ? await autopayEvent(db, provider, target, log, cancelBudgetMs)
    : target.kind === "refund" || target.kind === "dispute" ? await refundEvent(db, provider, target, log)
    : await planPayment(db, provider, target, log);
  if (r.status < 300 && eventId) {
    // noted only once settled: a notification that failed half-way is handled in full when it comes again
    const { error } = await db.rpc("hangtag_billing_event_record", { p_provider: provider.name, p_event_id: eventId, p_type: target.type || target.kind,
      p_ref: target.orderId || target.cfOrderId || target.subscriptionId || target.paymentId || null, p_mode: provider.mode,
      p_entity: target.entityId || target.orderId || target.subscriptionId || null, p_created_at: target.createdAt || null,
      p_outcome: String(r.body.status || (r.body.probe ? "probe" : r.body.ignored ? "ignored" : r.body.refund ? "review" : "settled")).slice(0, 40), p_probe: !!target.probe });
    if (error && !missingRpc(error)) log.error("subscription-webhook: notification not noted:", error.code);
  }
  return r;
}

/* { modeOk, duplicate, billingMode } — or { error } when the ledger can't be read. A database without the ledger yet takes
   only live keys and has nothing noted. */
async function ledgerSeen(db, provider, eventId) {
  const { data, error } = await db.rpc("hangtag_billing_event_seen", { p_provider: provider.name, p_event_id: eventId || "", p_mode: provider.mode });
  if (!error && data) return { modeOk: data.mode_ok === true, duplicate: !!eventId && data.duplicate === true, billingMode: data.billing_mode };
  if (error && !missingRpc(error)) return { error: error.code || "unknown" };
  return { modeOk: provider.mode === "live", duplicate: false, billingMode: null };
}

/* Money for review: { ok } — false when it couldn't be kept (the provider is then asked to send it again) */
async function exception(db, log, provider, kind, ref, fields = {}) {
  const { error } = await db.rpc("hangtag_billing_exception_open", { p_provider: provider.name, p_kind: kind, p_ref: String(ref).slice(0, 120),
    p_owner: fields.owner || null, p_payment: fields.payment || null, p_amount: fields.amount == null ? null : fields.amount, p_detail: fields.detail || {},
    p_provider_payment: fields.providerPayment || null });
  log.error(`subscription-webhook: ${kind} (review):`, provider.name, String(ref).slice(0, 120), fields.payment || "");
  if (error && !missingRpc(error)) return { ok: false };
  return { ok: true };
}

/* Activation in this database's billing mode, never for money refunded or disputed (the older activation before the
   post-repair migration — reached with live keys only) */
async function activate(db, provider, row, d) {
  const r = await db.rpc("hangtag_subscription_activate_checked", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount, p_mode: provider.mode });
  if (!r.error || !missingRpc(r.error)) return r;
  return db.rpc("hangtag_subscription_activate", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount });
}

async function planPayment(db, provider, target, log) {
  const { data: row, error: rowErr } = await db.from("hangtag_subscription_payments").select("id, owner_id, amount, currency, status, provider_order_id")
    .eq("provider", provider.name).eq("provider_order_id", target.orderId).maybeSingle();
  if (rowErr) { log.error("subscription-webhook: payment lookup failed:", rowErr.code); return out(503, { ok: false }); }   // sent again
  if (!row) return unrecordedLink(db, provider, target, log);
  // the link's own note names its payment: another one means the link isn't this payment's — never activated
  if (target.paymentRef && target.paymentRef !== row.id) {
    const x = await exception(db, log, provider, "wrong_shop", target.orderId, { owner: row.owner_id, payment: row.id, detail: { named_payment: target.paymentRef } });
    return x.ok ? out(200, { ok: false, status: "wrong_payment" }) : out(500, { ok: false });
  }
  if (row.status === "paid") return out(200, { ok: true, status: "paid" });   // a repeated or late notification: nothing to do
  let view = target.view;
  if (!view) {
    try { view = await provider.getPayment(row.provider_order_id); }
    catch (e) { log.error("subscription-webhook: the provider couldn't be asked:", e && e.status || ""); return out(503, { ok: false }); }
  }
  if (settling(target, view)) { log.error("subscription-webhook: paid at the provider, not readable yet:", target.orderId); return out(503, { ok: false }); }
  const d = verifyDecision(row, view);
  if (d.action === "activate") {
    const { data: a, error } = await activate(db, provider, row, d);
    // refused for good: the amount or reference (P0001), or a provider payment that already paid another payment (23505)
    if (error && (error.code === "P0001" || error.code === "23505")) {
      const x = await exception(db, log, provider, "activation_refused", d.ref, { owner: row.owner_id, payment: row.id, amount: d.amount, providerPayment: d.ref,
        detail: { link: target.orderId } });
      return x.ok ? out(200, { ok: false, status: "refused" }) : out(500, { ok: false });
    }
    if (error) { log.error("subscription-webhook: activation failed:", error.code); return out(500, { ok: false }); }   // sent again
    if (a && a.ok === false && a.reason === "refunded") return out(200, { ok: false, status: "refunded" });   // its refund is already kept for review
    return out(200, { ok: true, status: "paid" });
  }
  if (d.status === "mismatch" || d.status === "currency_mismatch") {
    const x = await exception(db, log, provider, d.status === "mismatch" ? "amount_mismatch" : "currency_mismatch", target.orderId,
      { owner: row.owner_id, payment: row.id, amount: view && view.paid ? view.paid / 100 : null, providerPayment: view && view.paymentId || null,
        detail: { due: Number(row.amount), currency: row.currency, paid_currency: view && view.currency || null } });
    return x.ok ? out(200, { ok: true, status: d.status }) : out(500, { ok: false });
  }
  if (d.action === "fail") {
    const { error } = await db.rpc("hangtag_subscription_fail", { p_payment: row.id, p_status: d.status });
    if (error) { log.error("subscription-webhook: payment state not recorded:", error.code); return out(500, { ok: false }); }   // sent again
  }
  return out(200, { ok: true, status: d.status });
}

/* A link no Hangtag payment has recorded. Hangtag's when its note names a Hangtag payment (in the notification, or on the
   link as the provider keeps it) or carries Hangtag's mark: a link made for a payment whose recording failed, or made by
   hand on the account. Money taken on it is kept for review — never activated, since nothing ties it to a shop's
   checkout. Anything else is someone else's: ignored. */
async function unrecordedLink(db, provider, target, log) {
  if (!target.paymentRef && !target.ours) return out(200, { ok: true, ignored: true });   // not a Hangtag plan payment
  let view = target.view;
  if (!view) {
    try { view = await provider.getPayment(target.orderId); }
    catch (e) {
      if (e && e.status === 404) return out(200, { ok: true, ignored: true });   // no such link on the account: nothing to settle
      log.error("subscription-webhook: the provider couldn't be asked:", e && e.status || ""); return out(503, { ok: false });
    }
  }
  const named = String(target.paymentRef || (view && view.ref) || "").slice(0, 64);
  if (!named && !(view && view.hangtag)) return out(200, { ok: true, ignored: true });
  if (settling(target, view)) { log.error("subscription-webhook: paid at the provider, not readable yet:", target.orderId); return out(503, { ok: false }); }
  if (!view || view.state !== "paid") return out(200, { ok: true, ignored: true });
  const x = await exception(db, log, provider, "unknown_order", target.orderId, { amount: view.paid ? view.paid / 100 : null, providerPayment: view.paymentId || null,
    detail: { named_payment: named || null, provider_payment: view.paymentId || null, paid_currency: view.currency || null } });
  return x.ok ? out(200, { ok: false, status: "unmatched" }) : out(500, { ok: false });
}

/* A refund or a dispute: kept for review (never a change to the shop's time by itself), against its Hangtag payment —
   found by the provider's payment (Razorpay), or traced from the order to its link (Cashfree). One that comes before the
   payment is recorded is kept too, when it is Hangtag's money (its notes, its link, its AutoPay): the payment then adds
   no time when it arrives. Anything else on the account (another product, an AutoPay authorisation refunded by itself): ignored. */
async function refundEvent(db, provider, target, log) {
  const kind = target.kind, ref = target.kind === "dispute" ? target.disputeId : target.refundId;
  let row = null, linkId = null, hangtag = false;
  if (target.paymentId) {
    const { data, error } = await db.from("hangtag_subscription_payments").select("id, owner_id, status, provider_order_id")
      .eq("provider", provider.name).eq("provider_payment_id", target.paymentId).maybeSingle();
    if (error) { log.error("subscription-webhook: payment lookup failed:", error.code); return out(503, { ok: false }); }
    row = data;
    hangtag = !!row || !!(target.notes && (target.notes.hangtag_payment || target.notes.hangtag_owner || target.notes.hangtag_mandate));
    if (!hangtag && target.invoiceId && typeof provider.getInvoice === "function") {
      try {
        const inv = await provider.getInvoice(target.invoiceId);
        if (inv && inv.subscriptionId) {
          const { data: k } = await db.rpc("hangtag_autopay_known", { p_provider: provider.name, p_subs: [inv.subscriptionId] });
          hangtag = !!(k && Array.isArray(k.known) && k.known.includes(inv.subscriptionId));
        }
      } catch (e) { log.error("subscription-webhook: the refund's invoice couldn't be read:", e && e.status || ""); return out(503, { ok: false }); }
    }
  } else {
    try { linkId = typeof provider.linkOfOrder === "function" ? await provider.linkOfOrder(target.cfOrderId) : null; }
    catch (e) { log.error(`subscription-webhook: the ${kind}'s order couldn't be read:`, e && e.status || ""); return out(503, { ok: false }); }
    if (linkId) {
      const { data, error } = await db.from("hangtag_subscription_payments").select("id, owner_id, status, provider_order_id")
        .eq("provider", provider.name).eq("provider_order_id", linkId).maybeSingle();
      if (error) { log.error("subscription-webhook: payment lookup failed:", error.code); return out(503, { ok: false }); }
      row = data;
    }
    hangtag = !!linkId;   // a link of Hangtag's form (ht_…)
  }
  if (!hangtag) return out(200, { ok: true, ignored: true });   // not Hangtag's money
  const x = await exception(db, log, provider, kind, ref || `${target.cfOrderId || target.paymentId}:${kind}`, { owner: row && row.owner_id, payment: row && row.id,
    amount: target.amount, providerPayment: target.paymentId || target.cfPaymentId || null,
    detail: { status: target.status, currency: target.currency, provider_payment: target.paymentId || target.cfPaymentId || null, link: linkId || (row && row.provider_order_id) || null,
      recorded: !!row } });
  return x.ok ? out(200, { ok: true, refund: "noted", kind }) : out(500, { ok: false });
}

/* An AutoPay report, through the registry (hangtag_autopay_report; hangtag_autopay_event before the post-repair migration).
   A set-up that was replaced, or that no shop recorded but carries Hangtag's note, is cancelled at the provider within a
   short budget; what doesn't finish stays requested, for the reconciler. */
async function autopayEvent(db, provider, target, log, budgetMs) {
  let { data: a, error: aErr } = await db.rpc("hangtag_autopay_report", { p_provider: provider.name, p_subscription: target.subscriptionId, p_event: target.event,
    p_payment: target.paymentId, p_amount: target.amount, p_currency: target.currency || null, p_next_charge_at: target.nextChargeAt,
    p_event_at: target.createdAt || null, p_mode: provider.mode });
  if (aErr && missingRpc(aErr)) {
    ({ data: a, error: aErr } = await db.rpc("hangtag_autopay_event", { p_provider: provider.name, p_subscription: target.subscriptionId, p_event: target.event,
      p_payment: target.paymentId, p_amount: target.amount, p_next_charge_at: target.nextChargeAt }));
  }
  if (aErr && aErr.code === "P0001") {
    const x = await exception(db, log, provider, "activation_refused", target.paymentId || target.subscriptionId, { amount: target.amount, providerPayment: target.paymentId || null,
      detail: { subscription: target.subscriptionId, event: target.event } });
    return x.ok ? out(200, { ok: false, status: "refused" }) : out(500, { ok: false });
  }
  if (aErr) { log.error("subscription-webhook: AutoPay report refused:", aErr.code); return out(500, { ok: false }); }   // sent again
  const live = !TERMINAL.includes(target.event);
  if (a && a.known === false && !a.orphan && (target.owner || target.mandate) && live) {
    // carries Hangtag's note, yet no shop's set-up: cancel it; when that can't be done now, keep it for the reconciler
    const done = await tryCancel(provider, target.subscriptionId, budgetMs);
    if (!done) {
      const { error } = await db.rpc("hangtag_autopay_orphan", { p_provider: provider.name, p_subscription: target.subscriptionId, p_mode: provider.mode });
      if (error && !missingRpc(error)) { log.error("subscription-webhook: an untracked AutoPay couldn't be kept for cancelling:", error.code); return out(500, { ok: false }); }
    }
    if (target.event === "charged") {
      const x = await exception(db, log, provider, "unknown_mandate_charge", target.paymentId, { amount: target.amount, providerPayment: target.paymentId,
        detail: { subscription: target.subscriptionId, currency: target.currency || null, note: "refund it in the provider's dashboard" } });
      if (!x.ok) return out(500, { ok: false });
    }
  } else if (a && a.cancel && live) {
    // a replaced set-up (or one kept to be cancelled) is still on at the provider: off now if it can be, else by the reconciler
    if (await tryCancel(provider, target.subscriptionId, budgetMs)) {
      const { error } = await db.rpc("hangtag_autopay_report", { p_provider: provider.name, p_subscription: target.subscriptionId, p_event: "cancelled",
        p_payment: null, p_amount: null, p_currency: null, p_next_charge_at: null, p_event_at: null, p_mode: provider.mode });
      if (error) log.error("subscription-webhook: an AutoPay cancel wasn't recorded (the reconciler will):", error.code);
    }
  }
  return out(200, { ok: true, autopay: target.event, known: !!(a && a.known), recorded: !!(a && a.recorded) });
}

/* An AutoPay cancelled (or found already ended) at the provider within the budget: true; false when it can't be said now */
async function tryCancel(provider, subscriptionId, budgetMs) {
  try {
    const r = await withBudget(cancelOrConfirm(provider, subscriptionId), budgetMs);
    return !!(r && r.confirmed);
  } catch { return false; }
}
