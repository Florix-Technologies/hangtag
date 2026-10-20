// Billing reconciliation (REMEDIATION step 7), in plain JS so it runs (and is tested) in Node as in Deno. The provider is
// the record of money, the database of time: a run reads back what the provider holds and repairs through the same
// idempotent database functions as the notifications (activation locks the payment row and adds nothing twice; an AutoPay
// charge is keyed by the provider's payment id), so a run and the webhook can race safely. It never creates a charge,
// never refunds and never removes time; what it can't match is kept for review (hangtag_billing_exceptions).
//   A  plan payments whose page was made and that aren't paid (a missed notification): read back, activated, failed or
//      kept for review exactly as the webhook would (Razorpay and Cashfree);
//   B  AutoPay set-ups (Razorpay): cancels still owed retried; the state read back; captured charges no one recorded
//      found through the invoices and recorded once; a renewal overdue for 4 days kept for review;
//   C  the account's subscriptions since the last complete run (Razorpay): one carrying Hangtag's note that no shop has is
//      cancelled and kept for review; the self-check's leftovers are cancelled quietly;
//   D  the account's captured payments and refunds in the same window (Razorpay): Hangtag's money that nothing recorded
//      is recorded (an AutoPay charge) or kept for review; a refund of a recorded payment is kept for review.
// One run at a time and its times are the database's (hangtag_billing_reconcile_begin/_done). A 4xx on one item is kept
// against that item and the run goes on; a 5xx, 401, 429 or a network error stops the run (ok false: the window stays).
// Provider calls are capped per run; a capped run is ok but not complete (it resumes where it stopped).
// Entry: the subscription-webhook function, a POST with "x-hangtag-reconcile: 1" and "Authorization: Bearer
// <SUBSCRIPTION_RECONCILE_SECRET>" (32 characters or more), from a scheduler the owner sets up (hourly).
import { cancelOrConfirm, missingRpc, verifyDecision } from "./core.js";

const str = (v) => (v == null ? "" : String(v));
const TERMINAL = ["cancelled", "completed", "expired"];
const DAY = 86400e3;
/* An error that stops the run: the provider may be down or refusing everything (a 4xx on one item doesn't) */
export const stopsRun = (e) => { const c = e && e.status; return !c || c >= 500 || c === 401 || c === 429; };

/* "Authorization: Bearer <secret>" exactly, compared in constant time; never while the secret is unset or short */
export function reconcileAuthorized(header, secret) {
  const want = str(secret);
  if (want.length < 32) return false;
  const a = new TextEncoder().encode(str(header)), b = new TextEncoder().encode("Bearer " + want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

/* The request: { method, headers (lower-case) }; deps: { env, admin() (service role), provider (plan payments), autopay
   (Razorpay, or null), named(name), now, log, budget (provider calls), limit (items per sweep) } */
export async function handleReconcile({ method, headers }, { env, admin, provider = null, autopay = null, named = () => null, now = () => Date.now(), log = console, budget = 300, limit = 50 }) {
  if (method !== "POST") return { status: 405, body: { ok: false } };
  if (str(env && env.SUBSCRIPTION_RECONCILE_SECRET).length < 32) return { status: 503, body: { ok: false, error: "not_configured" } };
  if (!reconcileAuthorized(headers && headers.authorization, env.SUBSCRIPTION_RECONCILE_SECRET)) return { status: 401, body: { ok: false, error: "unauthorized" } };
  const main = provider || autopay;
  if (!main) return { status: 503, body: { ok: false, error: "not_configured" } };
  const sr = admin();
  const r = await reconcile({ sr, mode: main.mode, named, autopay, now, log, budget, limit });
  return { status: r.httpStatus || 200, body: r.body };
}

export async function reconcile({ sr, mode, named, autopay, now = () => Date.now(), log = console, budget = 300, limit = 50 }) {
  const { data: begun, error: bErr } = await sr.rpc("hangtag_billing_reconcile_begin", { p_limit: limit, p_mode: mode });
  if (bErr) {
    log.error("reconcile: couldn't begin:", bErr.code);
    return { httpStatus: missingRpc(bErr) ? 503 : 500, body: { ok: false, error: missingRpc(bErr) ? "not_migrated" : "server_error" } };
  }
  if (begun && begun.refused) return { body: { ok: false, error: begun.reason } };
  if (begun && begun.busy) return { body: { ok: true, busy: true } };
  const run = { ok: true, complete: true, checked: 0, repaired: 0, exceptions_opened: 0, checked_mandates: [], checked_payments: [], c_until: null, d_until: null,
    provider_totals: {}, error_code: null };
  const startedAt = Date.parse(begun.started_at) || now();
  let calls = 0;
  const spend = (n = 1) => { calls += n; if (calls > budget) { const e = new Error("budget"); e.budget = true; throw e; } };
  const ctx = { sr, mode, named, autopay, now, log, run, spend };
  try {
    await sweepA(ctx, begun.payments || []);
    if (autopay) {
      await sweepB(ctx, begun.mandates || []);
      run.c_until = await sweepC(ctx, Date.parse(begun.c_since) || startedAt - 7 * DAY, startedAt);
      run.d_until = await sweepD(ctx, Date.parse(begun.d_since) || startedAt - 7 * DAY, startedAt);
      if (run.c_until !== new Date(startedAt).toISOString() || run.d_until !== new Date(startedAt).toISOString()) run.complete = false;
    }
  } catch (e) {
    if (e && e.budget) run.complete = false;   // capped: ok, resumes next run
    else { run.ok = false; run.complete = false; run.error_code = String((e && (e.status || e.code)) || "error").slice(0, 60); log.error("reconcile: stopped:", run.error_code); }
  }
  const { error: dErr } = await sr.rpc("hangtag_billing_reconcile_done", { p_run_id: begun.run_id, p_result: run });
  if (dErr) log.error("reconcile: the run's end wasn't recorded:", dErr.code);
  return { body: { ok: run.ok, run_id: begun.run_id, complete: run.complete, checked: run.checked, repaired: run.repaired, exceptions_opened: run.exceptions_opened,
    error_code: run.error_code } };
}

/* Money for review, once per provider, kind and reference */
async function keep(ctx, provider, kind, ref, f = {}) {
  const { data, error } = await ctx.sr.rpc("hangtag_billing_exception_open", { p_provider: provider, p_kind: kind, p_ref: str(ref).slice(0, 120), p_owner: f.owner || null,
    p_payment: f.payment || null, p_amount: f.amount == null ? null : f.amount, p_detail: f.detail || {}, p_provider_payment: f.providerPayment || null });
  if (error) throw Object.assign(new Error("db"), { code: error.code });
  if (data && data.opened) ctx.run.exceptions_opened++;
}

/* An AutoPay report through the registry, in this run's billing mode */
export async function report(sr, mode, provider, subscriptionId, event, { payment = null, amount = null, currency = null, nextChargeAt = null, eventAt = null } = {}) {
  const { data, error } = await sr.rpc("hangtag_autopay_report", { p_provider: provider, p_subscription: subscriptionId, p_event: event, p_payment: payment,
    p_amount: amount, p_currency: currency, p_next_charge_at: nextChargeAt, p_event_at: eventAt, p_mode: mode });
  if (error) throw Object.assign(new Error("db"), { code: error.code });
  return data || {};
}

/* A: plan payments whose page was made and that aren't paid */
async function sweepA(ctx, rows) {
  for (const row of rows) {
    const provider = ctx.named(row.provider);
    if (!provider || provider.mode !== ctx.mode) continue;   // a provider not set up here (or in another mode): not read
    let view;
    try { ctx.spend(); view = await provider.getPayment(row.provider_order_id); }
    catch (e) {
      if (e && e.budget) throw e;
      if (stopsRun(e)) throw e;
      // this one link can't be read (another account's, gone): kept for review once, never read again
      await keep(ctx, row.provider, "reconcile_error", row.provider_order_id, { owner: row.owner_id, payment: row.id, detail: { status: e.status, reason: str(e.description || e.code).slice(0, 120) } });
      ctx.run.checked_payments.push({ id: row.id, final: true });
      continue;
    }
    ctx.run.checked++;
    const d = verifyDecision(row, view);
    if (d.action === "activate") {
      const { data: a, error } = await ctx.sr.rpc("hangtag_subscription_activate_checked", { p_payment: row.id, p_provider_payment: d.ref, p_amount: d.amount, p_mode: ctx.mode });
      if (error && (error.code === "P0001" || error.code === "23505")) {
        await keep(ctx, row.provider, "activation_refused", d.ref, { owner: row.owner_id, payment: row.id, amount: d.amount, providerPayment: d.ref, detail: { link: row.provider_order_id } });
      } else if (error) throw Object.assign(new Error("db"), { code: error.code });
      else if (!(a && a.ok === false)) ctx.run.repaired++;
      ctx.run.checked_payments.push({ id: row.id, final: true });
    } else if (d.status === "mismatch" || d.status === "currency_mismatch") {
      await keep(ctx, row.provider, d.status === "mismatch" ? "amount_mismatch" : "currency_mismatch", row.provider_order_id, { owner: row.owner_id, payment: row.id,
        amount: view && view.paid ? view.paid / 100 : null, providerPayment: view && view.paymentId || null,
        detail: { due: Number(row.amount), currency: row.currency, paid_currency: view && view.currency || null } });
      ctx.run.checked_payments.push({ id: row.id, final: true });
    } else {
      if (d.action === "fail") {
        const { error } = await ctx.sr.rpc("hangtag_subscription_fail", { p_payment: row.id, p_status: d.status });
        if (error) throw Object.assign(new Error("db"), { code: error.code });
      }
      // an ended link is read back until it is two days old (money taken late is still honoured), then no more
      const ended = ["expired", "cancelled", "failed"].includes(view && view.state);
      ctx.run.checked_payments.push({ id: row.id, final: ended && ctx.now() - Date.parse(row.created_at) > 2 * DAY });
    }
  }
}

/* B: AutoPay set-ups */
async function sweepB(ctx, mandates) {
  for (const m of mandates) {
    if (m.provider !== ctx.autopay.name) continue;
    await checkMandate(ctx, m);
    ctx.run.checked_mandates.push(m.id);
  }
}

/* One AutoPay set-up read back and repaired (also the owner's own check, autopay_verify): a cancel owed is retried; the
   state is reported as of the time of the read; captured charges no one recorded are recorded once; a refunded one kept for
   review; a renewal still unpaid 4 days after it was due kept for review */
export async function checkMandate(ctx, m) {
  const ap = ctx.autopay, sub = m.subscription_id;
  if (m.reason === "cancel") {
    ctx.spend(2);
    const c = await cancelOrConfirm(ap, sub);
    if (c.confirmed) { await report(ctx.sr, ctx.mode, ap.name, sub, "cancelled", { eventAt: new Date(ctx.now()).toISOString() }); ctx.run.repaired++; }
    else if (c.status !== "created") await keep(ctx, ap.name, "cancel_failed", sub, { owner: m.shop_owner_id, detail: { status: c.status } });
  }
  const readAt = new Date(ctx.now()).toISOString();
  ctx.spend();
  const st = await ap.getAutopay(sub);
  ctx.run.checked++;
  if (st.event && st.event !== "charged") await report(ctx.sr, ctx.mode, ap.name, sub, st.event, { nextChargeAt: st.nextChargeAt, eventAt: readAt });
  const recorded = new Set(m.recorded || []);
  let found = 0;
  if (st.paidCount > recorded.size || m.reason === "final" || m.reason === "charge_overdue") {
    ctx.spend();
    const invoices = await ap.listInvoices(sub);
    for (const inv of invoices.filter((i) => i.status === "paid" && i.paymentId && !recorded.has(i.paymentId))) {
      ctx.spend();
      const pay = await ap.getPaymentEntity(inv.paymentId);
      if (!pay || !pay.captured) continue;
      if (pay.refunded) {
        await keep(ctx, ap.name, "refund", `${pay.id}:refunded`, { owner: m.shop_owner_id, amount: pay.amountRefunded / 100, providerPayment: pay.id,
          detail: { subscription: sub, status: pay.status, currency: pay.currency } });
        continue;
      }
      const r = await report(ctx.sr, ctx.mode, ap.name, sub, "charged", { payment: pay.id, amount: pay.amount / 100, currency: pay.currency, eventAt: pay.createdAt });
      if (r.recorded && !r.already) { ctx.run.repaired++; found++; }
      recorded.add(pay.id);
    }
  }
  if (m.reason === "charge_overdue" && +m.overdue_days >= 4 && !found && TERMINAL.indexOf(st.status) < 0) {
    await keep(ctx, ap.name, "charge_overdue", `${sub}:${str(m.next_charge_at).slice(0, 10)}`, { owner: m.shop_owner_id,
      detail: { subscription: sub, due_at: m.next_charge_at, provider_status: st.status, paid_count: st.paidCount } });
  }
  return { status: st.status, recorded: found };
}

/* The account's lists, read in day-long slices from `from` to `to` (ms): { until (ISO, how far it was read) } */
async function walk(ctx, from, to, readSlice) {
  let at = Math.max(from, to - 400 * DAY);
  while (at < to) {
    const end = Math.min(at + DAY, to);
    try { await readSlice(at, end); }
    catch (e) { if (e && e.budget) return { until: new Date(at).toISOString(), capped: true }; throw e; }
    at = end;
  }
  return { until: new Date(to).toISOString(), capped: false };
}

/* C: subscriptions made on the account that carry Hangtag's note but that no shop has */
async function sweepC(ctx, from, to) {
  const ap = ctx.autopay;
  const r = await walk(ctx, from, to, async (a, b) => {
    ctx.spend(5);
    const { items, more } = await ap.listSubscriptions({ from: a, to: b, pages: 5 });
    if (more) ctx.run.complete = false;
    const ours = items.filter((s) => s.notes && (s.notes.hangtag_owner || s.notes.hangtag_mandate || s.notes.hangtag_probe));
    if (!ours.length) return;
    const { data: k, error } = await ctx.sr.rpc("hangtag_autopay_known", { p_provider: ap.name, p_subs: ours.map((s) => s.id) });
    if (error) throw Object.assign(new Error("db"), { code: error.code });
    const known = new Set((k && k.known) || []), probes = new Set((k && k.probes) || []);
    for (const s of ours) {
      if (known.has(s.id) || TERMINAL.includes(s.status)) continue;
      ctx.run.checked++;
      const isProbe = probes.has(s.id) || (!s.notes.hangtag_owner && !s.notes.hangtag_mandate);
      if (isProbe && ctx.now() - Date.parse(s.createdAt || 0) < 3600e3) continue;   // the self-check's own, still young
      ctx.spend(2);
      let c = { confirmed: false };
      try { c = await cancelOrConfirm(ap, s.id); } catch (e) { if (stopsRun(e)) throw e; }
      if (isProbe) continue;
      if (c.confirmed) ctx.run.repaired++;
      else {
        const { error: oErr } = await ctx.sr.rpc("hangtag_autopay_orphan", { p_provider: ap.name, p_subscription: s.id, p_mode: ctx.mode });
        if (oErr) throw Object.assign(new Error("db"), { code: oErr.code });
      }
      await keep(ctx, ap.name, "stale_mandate", s.id, { detail: { status: s.status, cancelled: c.confirmed, owner_note: str(s.notes.hangtag_owner) || null } });
    }
  });
  return r.until;
}

/* D: the account's captured payments and refunds in the window: Hangtag's money nothing holds */
async function sweepD(ctx, from, to) {
  const ap = ctx.autopay, invoiceSub = new Map(), totals = { captured: 0, payments: 0, refunds: 0 };
  const r = await walk(ctx, from, to, async (a, b) => {
    ctx.spend(5);
    const { items, more } = await ap.listPayments({ from: a, to: b, pages: 5 });
    if (more) ctx.run.complete = false;
    const captured = items.filter((p) => p.captured && ctx.now() - Date.parse(p.createdAt || 0) > 15 * 60e3);
    const candidates = [];
    for (const p of captured) {
      let sub = null;
      if (p.invoiceId) {
        if (!invoiceSub.has(p.invoiceId)) { ctx.spend(); const inv = await ap.getInvoice(p.invoiceId); invoiceSub.set(p.invoiceId, inv && inv.subscriptionId); }
        sub = invoiceSub.get(p.invoiceId);
      }
      const noted = !!(p.notes.hangtag_payment || p.notes.hangtag_owner || p.notes.hangtag_mandate);
      if (noted || sub) candidates.push({ p, sub });
    }
    if (candidates.length) {
      const subs = [...new Set(candidates.map((c) => c.sub).filter(Boolean))];
      const { data: k } = subs.length ? await ctx.sr.rpc("hangtag_autopay_known", { p_provider: ap.name, p_subs: subs }) : { data: null };
      const knownSubs = new Set((k && k.known) || []);
      const { data: held, error } = await ctx.sr.rpc("hangtag_billing_known_payments", { p_provider: ap.name, p_ids: candidates.map((c) => c.p.id) });
      if (error) throw Object.assign(new Error("db"), { code: error.code });
      const heldSet = new Set(held || []);
      for (const { p, sub } of candidates) {
        if (sub && !knownSubs.has(sub) && !(p.notes.hangtag_payment || p.notes.hangtag_owner || p.notes.hangtag_mandate)) continue;   // another product's subscription
        totals.captured += p.amount; totals.payments++;
        if (heldSet.has(p.id)) continue;
        ctx.run.checked++;
        if (sub && knownSubs.has(sub) && !p.refunded) {
          const rep = await report(ctx.sr, ctx.mode, ap.name, sub, "charged", { payment: p.id, amount: p.amount / 100, currency: p.currency, eventAt: p.createdAt });
          if (rep.recorded && !rep.already) ctx.run.repaired++;
        } else {
          await keep(ctx, ap.name, p.refunded ? "refund" : "unmatched_payment", p.refunded ? `${p.id}:refunded` : p.id, { amount: p.amount / 100, providerPayment: p.id,
            detail: { subscription: sub, currency: p.currency, refunded: p.refunded } });
        }
      }
    }
    ctx.spend(5);
    const refunds = await ap.listRefunds({ from: a, to: b, pages: 5 });
    if (refunds.more) ctx.run.complete = false;
    if (refunds.items.length) {
      const { data: held, error } = await ctx.sr.rpc("hangtag_billing_known_payments", { p_provider: ap.name, p_ids: refunds.items.map((f) => f.paymentId) });
      if (error) throw Object.assign(new Error("db"), { code: error.code });
      const heldSet = new Set(held || []);
      for (const f of refunds.items.filter((x) => heldSet.has(x.paymentId))) {
        totals.refunds++;
        await keep(ctx, ap.name, "refund", f.id, { amount: f.amount, providerPayment: f.paymentId, detail: { status: f.status, currency: f.currency } });
      }
    }
  });
  ctx.run.provider_totals = { ...ctx.run.provider_totals, [ap.name]: { captured_paise: totals.captured, payments: totals.payments, refunds: totals.refunds } };
  return r.until;
}
