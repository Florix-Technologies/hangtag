// Cashfree Payment Gateway as the payment provider for Hangtag plans, through Cashfree's Payment Links: Cashfree's own
// payment page, so the app keeps doing what it does with any provider (open the page, then ask the server whether it was
// paid) and no Cashfree script runs inside the app. Plain JS: run by the subscription and subscription-webhook Edge
// Functions and tested in Node with a fake fetch (tests/unit/subscription-cashfree.test.mjs).
// - Hangtag's OWN keys (SUBSCRIPTION_CASHFREE_APP_ID / SUBSCRIPTION_CASHFREE_SECRET_KEY), never a shop's. The environment
//   (sandbox or production) is chosen in providers/index.js; sandbox keys only on a test project.
// - Amounts go to Cashfree in rupees (two decimals) and come back to Hangtag in paise.
// - Nothing a notification says is trusted: after its signature is checked it only names the link (or, for a refund,
//   the order), and the link, its PAID orders and their payments are read from Cashfree's API. Money counts only as a
//   PAID order with Cashfree's SUCCESS payment on it.
// Checked against Cashfree's documentation (API version 2026-01-01): POST /links (x-idempotency-key, a UUID), GET
// /links/{id}, GET /links/{id}/orders (PAID by default), GET /orders/{id}, GET /orders/{id}/payments; webhooks signed with
// x-webhook-signature = Base64(HMAC-SHA256(x-webhook-timestamp + raw body, the secret key)), delivered at least once.
import { PAGE_MINUTES } from "../core.js";

const BASE = Object.freeze({ sandbox: "https://sandbox.cashfree.com/pg", production: "https://api.cashfree.com/pg" });
export const API_VERSION = "2026-01-01";
const str = (v) => (v == null ? "" : String(v));
export const toPaise = (rupees) => Math.round((+rupees || 0) * 100);
/* One link per Hangtag plan payment, ever: "ht_" and the payment's id without its dashes (35 of the 50 characters allowed) */
export const LINK_ID = /^ht_[0-9a-f]{32}$/;
export const linkIdFor = (paymentId) => "ht_" + str(paymentId).toLowerCase().replace(/-/g, "");
const LINK_IN_TEXT = /ht_[0-9a-f]{32}(?![0-9a-f])/;
/* Marks a link as a Hangtag plan payment (link_notes), apart from anything else the same Cashfree account takes */
export const APP_NOTE = "hangtag-plan";

/* AutoPay (Cashfree Subscriptions, POST /subscriptions; checked against the 2026-01-01 documentation): one on-demand mandate
   per Hangtag AutoPay set-up, named by Hangtag — "htap_" and the set-up's id without its dashes — so it is read back and
   turned off by that name, never by anything a notification says. An on-demand mandate charges nothing by itself: Hangtag
   asks for each charge when it falls due (Cashfree's periodic plans must charge within 14 days of the approval, too soon
   for a 30-day trial), so a mandate turned off during the trial is never charged. */
export const AUTOPAY_ID = /^htap_[0-9a-z]{16,60}$/;
export const autopayIdFor = (ref) => "htap_" + str(ref).toLowerCase().replace(/[^0-9a-z]/g, "").slice(0, 60);
/* What UPI or a card takes to confirm a mandate, in rupees; Cashfree refunds it (authorization_amount_refund). An eNACH
   mandate takes nothing. Cashfree takes ₹1 with UPI even when asked for ₹0, so the app says so before the owner agrees. */
export const AUTOPAY_AUTH_AMOUNT = 1;
/* A charge is asked for this long before it is due: Cashfree takes one 2 to 14 days ahead (UPI's 25-hour pre-debit notice,
   a card's T+2), and the reconciler reads each live mandate at least once a day */
export const CHARGE_LEAD_MS = 4 * 86400e3;
export const CHARGE_MIN_AHEAD_MS = 2 * 86400e3;
/* One charge per mandate and due date, ever: Cashfree refuses a payment_id it has seen, so asking twice can't charge twice */
export const chargeIdFor = (subscriptionId, dueAt) => `htc_${str(subscriptionId).replace(/^htap_/, "").slice(0, 40)}_${istTime(+dueAt || 0).slice(0, 10).replace(/-/g, "")}`;
const CHARGE_REF = /^htc_[0-9a-z_]{8,60}$/;
/* A mandate's state as Hangtag's AutoPay reads it: status (lower case; "created" while it waits for the owner or the bank,
   "cancelled" / "expired" / "completed" once it can never charge again), event (Hangtag's AutoPay event, or null),
   nextChargeAt null (Hangtag keeps its own: the end of the time paid for) */
const MANDATE_EVENTS = Object.freeze({ active: "authenticated", on_hold: "halted", paused: "halted", customer_paused: "halted", cancelled: "cancelled",
  customer_cancelled: "cancelled", expired: "expired", link_expired: "expired", card_expired: "expired", completed: "completed" });
const MANDATE_STATUS = Object.freeze({ initialized: "created", bank_approval_pending: "created", customer_cancelled: "cancelled", link_expired: "expired",
  card_expired: "expired" });
export function mandateView(sub) {
  if (!sub || typeof sub !== "object" || !AUTOPAY_ID.test(str(sub.subscription_id))) return { status: "unknown", event: null, nextChargeAt: null, paidCount: 0 };
  const s = str(sub.subscription_status).toLowerCase();
  return { status: MANDATE_STATUS[s] || s, event: MANDATE_EVENTS[s] || null, nextChargeAt: null, paidCount: 0 };
}
/* A mandate's payments as Cashfree lists them: [{ id: Cashfree's payment id, ref: Hangtag's payment_id, type ("AUTH",
   "CHARGE" …), status (lower case), amount (paise), currency, at }] */
export function paymentsOf(list) {
  return (Array.isArray(list) ? list : []).filter((p) => p && (str(p.cf_payment_id) || str(p.payment_id)))
    .map((p) => ({ id: str(p.cf_payment_id), ref: str(p.payment_id), type: str(p.payment_type).toUpperCase(), status: str(p.payment_status).toLowerCase(),
      amount: toPaise(p.payment_amount), currency: "INR", at: str(p.payment_initiated_date || p.payment_schedule_date) || null }));
}
/* …its charges: never its authorisation (payment_type AUTH: the ₹1, refunded) */
export const chargesOf = (list) => paymentsOf(list).filter((p) => p.type === "CHARGE").map(({ type, ...c }) => c);
/* A subscription notification → an AutoPay report for one of Hangtag's mandates, or null. A charge counts only when Cashfree
   reports it SUCCESS (and the registry checks it against the price agreed); the authorisation is never a charge. Fields as
   webhook version 2026-01-01 sends them (data.*), with 2025-01-01's data.subscription_details read too. */
function mandateTarget(type, d, createdAt) {
  const sd = d.subscription_details && typeof d.subscription_details === "object" ? d.subscription_details : {};
  const subscriptionId = [d.subscription_id, sd.subscription_id].map(str).find((v) => AUTOPAY_ID.test(v)) || "";
  if (!subscriptionId) return null;
  const tags = [d.subscription_tags, sd.subscription_tags].find((t) => t && typeof t === "object") || {};
  const base = { kind: "autopay", subscriptionId, event: null, paymentId: null, amount: null, currency: null, nextChargeAt: null,
    owner: str(tags.hangtag_owner) || null, mandate: str(tags.hangtag_mandate) || null, type, entityId: subscriptionId, createdAt };
  if (type === "SUBSCRIPTION_STATUS_CHANGED") {
    const event = MANDATE_EVENTS[str(sd.subscription_status || d.subscription_status).toLowerCase()];
    return event ? { ...base, event } : null;
  }
  if (type === "SUBSCRIPTION_AUTH_STATUS") {
    const a = [d.authorization_details, d.authorisation_details, sd.authorization_details, sd.authorisation_details].find((x) => x && typeof x === "object") || {};
    const st = str(a.authorization_status || a.authorisation_status).toUpperCase();
    return st === "ACTIVE" || st === "SUCCESS" ? { ...base, event: "authenticated" } : null;
  }
  if (type === "SUBSCRIPTION_REFUND_STATUS") {
    // the authorisation's own ₹1, refunded as agreed, is nothing to review; money back on a charge is
    const amount = +d.refund_amount || 0;
    if (str(d.refund_status).toUpperCase() !== "SUCCESS" || amount <= AUTOPAY_AUTH_AMOUNT) return null;
    return { ...base, kind: "mandate_refund", amount, paymentId: str(d.cf_payment_id || d.payment_id) || null, refundId: str(d.cf_refund_id || d.refund_id) || null };
  }
  const pt = str(d.payment_type).toUpperCase(), paymentId = str(d.cf_payment_id), chargeRef = str(d.payment_id);
  // the pre-debit notice: the payer was told of a charge (UPI AutoPay: about a day before it is taken). Nothing changes
  // hands; the webhook notes it and holds it against the charge Hangtag asked for (ours: one of Hangtag's charge refs)
  if (type === "SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED") {
    if (pt === "AUTH" || (!paymentId && !chargeRef)) return null;
    return { ...base, kind: "autopay_notice", paymentId: paymentId || null, chargeRef: chargeRef || null, ours: CHARGE_REF.test(chargeRef),
      amount: d.payment_amount == null || d.payment_amount === "" ? null : +d.payment_amount, currency: str(d.payment_currency) || "INR",
      scheduledAt: str(d.payment_schedule_date) || null, entityId: chargeRef || paymentId };
  }
  // a payment on the mandate is only named here (confirm): whether it is a charge, what became of it and its amount are read
  // from Cashfree's API by the webhook (Cashfree's own examples of these notifications differ on payment_type, and its
  // advice is to fetch the charge). The ₹1 authorisation (AUTH) is never a charge, so it isn't even looked up.
  if (type !== "SUBSCRIPTION_PAYMENT_SUCCESS" && type !== "SUBSCRIPTION_PAYMENT_FAILED" && type !== "SUBSCRIPTION_PAYMENT_CANCELLED") return null;
  if (pt === "AUTH" || (!paymentId && !chargeRef)) return null;
  // reported paid → charged once the API shows it SUCCESS; reported failed or cancelled → shown (pending) once the API shows
  // it ended untaken (a cancelled one only while the mandate is still on: the payer declined it)
  return { ...base, event: type === "SUBSCRIPTION_PAYMENT_SUCCESS" ? "charged" : "pending", paymentId: paymentId || null, chargeRef: chargeRef || null,
    claimsCharge: pt === "CHARGE", confirm: true };
}

/* A time as Cashfree's examples write it: India time with its offset, whole seconds ("2026-10-13T16:30:00+05:30") */
export function istTime(ms) {
  return new Date(ms + 330 * 60e3).toISOString().slice(0, 19) + "+05:30";
}

/* A link past its expiry may still be finishing a payment begun before it (a UPI collect, a bank's page), and Cashfree
   lists a PAID order a moment after the money is taken: for this long after the expiry an unpaid link reads as pending
   (wait), and only then as expired — so neither the app nor a notification gives up on money that is still landing. */
export const EXPIRY_GRACE_MS = 15 * 60e3;

/* The link as Hangtag reads it: { state: "paid"|"pending"|"expired"|"cancelled"|"failed", paid (paise), paymentId,
   currency }. paid = the PAID orders Cashfree lists for the link (money taken is honoured whatever the link's own status
   says); paymentId = Cashfree's id of the SUCCESS payment on one of them. Paid with no readable payment yet → pending. */
export function linkView(link, money, now = Date.now()) {
  if (!link || typeof link !== "object" || !LINK_ID.test(str(link.link_id))) return { state: "failed", paid: 0, paymentId: null };
  const currency = str((money && money.currency) || link.link_currency || "INR").toUpperCase();
  const paid = money && money.paid > 0 ? money.paid : 0, paymentId = money && money.paymentId ? str(money.paymentId) : null;
  if (paid > 0) return paymentId ? { state: "paid", paid, paymentId, currency } : { state: "pending", paid, paymentId: null, currency };
  const st = str(link.link_status).toUpperCase();
  if (st === "CANCELLED") return { state: "cancelled", paid: 0, paymentId: null, currency };
  const ends = Date.parse(str(link.link_expiry_time)), past = Number.isFinite(ends) && ends < now;
  const settled = !Number.isFinite(ends) || now > ends + EXPIRY_GRACE_MS;
  if (st === "EXPIRED" || (st === "ACTIVE" && past)) return settled ? { state: "expired", paid: 0, paymentId: null, currency } : { state: "pending", paid: 0, paymentId: null, currency };
  // ACTIVE (a failed or abandoned attempt leaves the link open for another try), PAID with no PAID order listed yet,
  // PARTIALLY_PAID (never made: partial payments are off) or anything new: wait, change nothing
  return { state: "pending", paid: 0, paymentId: null, currency };
}

/* The webhook's signature: Base64 of HMAC-SHA256 over the x-webhook-timestamp header followed directly by the raw body,
   with the secret key; compared in constant time */
export async function verifySignature(rawBody, timestamp, signature, secret) {
  if (!secret || !signature || !timestamp) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(str(timestamp) + str(rawBody))));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  const want = btoa(bin), sig = str(signature).trim();
  if (sig.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/* A signed notification → what it is about, or null when it names nothing of Hangtag's plans (a dashboard test, another
   product on the same account):
   - payment and payment-link events → { kind: "payment", orderId: the link's id, paymentRef, view: null } (the link is
     read from Cashfree before anything is decided; payment events for a link's order carry the link in its tags; a
     payment-link event may come as form data, so the id is also looked for in the raw text, which is already signed);
   - refunds → { kind: "refund", cfOrderId, cfPaymentId, refundId, amount (rupees), currency, status } (the order is
     then traced to its link through Cashfree's API);
   - disputes (DISPUTE_CREATED / _UPDATED / _CLOSED) → { kind: "dispute", cfOrderId, cfPaymentId, disputeId, amount, currency,
     status }, traced the same way.
   Each carries createdAt: the notification's own time (event_time, signed with it). */
export function readCashfreeWebhook(event, raw) {
  const e = event && typeof event === "object" ? event : {};
  const type = str(e.type).toUpperCase(), d = e.data && typeof e.data === "object" ? e.data : e;
  const t = Date.parse(str(e.event_time)), createdAt = Number.isFinite(t) ? new Date(t).toISOString() : null;
  if (/^SUBSCRIPTION_/.test(type)) return mandateTarget(type, d, createdAt);
  if (/^DISPUTE_(CREATED|UPDATED|CLOSED)$/.test(type)) {
    const x = d.dispute && typeof d.dispute === "object" ? d.dispute : {}, od = d.order_details && typeof d.order_details === "object" ? d.order_details : {};
    if (!str(od.order_id) || !str(x.dispute_id)) return null;
    return { kind: "dispute", cfOrderId: str(od.order_id), cfPaymentId: str(od.cf_payment_id), disputeId: str(x.dispute_id), amount: +x.dispute_amount || 0,
      currency: str(x.dispute_currency || od.order_currency || "INR").toUpperCase(), status: str(x.dispute_status).toUpperCase(), type, entityId: str(x.dispute_id), createdAt };
  }
  if (type === "REFUND_STATUS_WEBHOOK" || type === "AUTO_REFUND_STATUS_WEBHOOK") {
    const r = (d.refund && typeof d.refund === "object" ? d.refund : d.auto_refund && typeof d.auto_refund === "object" ? d.auto_refund : null);
    if (!r || !str(r.order_id)) return null;
    return { kind: "refund", cfOrderId: str(r.order_id), cfPaymentId: str(r.cf_payment_id), refundId: str(r.cf_refund_id || r.refund_id),
      amount: +r.refund_amount || 0, currency: str(r.refund_currency || "INR").toUpperCase(), status: str(r.refund_status).toUpperCase(),
      type, entityId: str(r.cf_refund_id || r.refund_id), createdAt };
  }
  const order = d.order && typeof d.order === "object" ? d.order : {};
  const tags = order.order_tags && typeof order.order_tags === "object" ? order.order_tags : {};
  let linkId = [d.link_id, tags.link_id, order.order_id].map(str).find((v) => LINK_ID.test(v)) || "";
  if (!linkId) { const m = LINK_IN_TEXT.exec(str(raw)); linkId = m ? m[0] : ""; }
  if (!linkId) return null;
  const notes = d.link_notes && typeof d.link_notes === "object" ? d.link_notes : {};
  // ours: the link id has Hangtag's form; whether Hangtag made it is the link's own business (its notes, read from the API).
  // claimsPaid: the notification reports money taken — until the API shows it too, the notification isn't settled
  const claimsPaid = type === "PAYMENT_SUCCESS_WEBHOOK" || str(d.link_status).toUpperCase() === "PAID";
  return { kind: "payment", orderId: linkId, paymentRef: str(notes.hangtag_payment), ours: true, claimsPaid, view: null, type: type || "PAYMENT_LINK_EVENT",
    entityId: linkId, createdAt };
}

export function cashfree({ appId, secretKey, env = "sandbox" }, fetchImpl = fetch, now = () => Date.now()) {
  const base = BASE[env];
  if (!base) throw new Error("cashfree: unknown environment");
  async function call(path, init = {}) {
    const res = await fetchImpl(base + path, { ...init, headers: { "x-client-id": appId, "x-client-secret": secretKey, "x-api-version": API_VERSION,
      Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) } });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error("provider_error");
      err.status = res.status;
      err.code = json && (json.code || json.type);
      throw err;
    }
    return json;
  }
  /* The money taken on a link: its PAID orders (in paise), their currency, and the SUCCESS payment on the first of them */
  async function moneyOn(linkId) {
    // all of the link's orders (Cashfree's sandbox takes only status=ALL here: "should be ALL"), the PAID ones kept below
    const orders = await call("/links/" + encodeURIComponent(linkId) + "/orders?status=ALL");
    const paidOrders = (Array.isArray(orders) ? orders : []).filter((o) => o && str(o.order_status).toUpperCase() === "PAID" && str(o.order_id));
    let paid = 0, paymentId = null, currency = "";
    for (const o of paidOrders) {
      paid += toPaise(o.order_amount);
      if (!currency) currency = str(o.order_currency).toUpperCase();
      if (paymentId) continue;
      const pays = await call("/orders/" + encodeURIComponent(o.order_id) + "/payments");
      const ok = (Array.isArray(pays) ? pays : []).find((p) => p && str(p.payment_status).toUpperCase() === "SUCCESS" && str(p.cf_payment_id));
      if (ok) paymentId = str(ok.cf_payment_id);
    }
    return { paid, paymentId, currency };
  }
  const listMandatePayments = async (subscriptionId) => (AUTOPAY_ID.test(str(subscriptionId))
    ? paymentsOf(await call("/subscriptions/" + encodeURIComponent(subscriptionId) + "/payments")) : []);
  const listCharges = async (subscriptionId) => (await listMandatePayments(subscriptionId)).filter((p) => p.type === "CHARGE").map(({ type, ...c }) => c);
  /* Every charge asked for on a mandate that hasn't begun (INITIALIZED) withdrawn: → how many were */
  async function withdrawPending(subscriptionId) {
    const path = "/subscriptions/" + encodeURIComponent(subscriptionId);
    let n = 0;
    for (const c of (await listCharges(subscriptionId).catch(() => [])).filter((x) => x.status === "initialized" && x.ref)) {
      const done = await call(path + "/payments/" + encodeURIComponent(c.ref) + "/manage", { method: "POST",
        body: JSON.stringify({ subscription_id: subscriptionId, payment_id: c.ref, action: "CANCEL" }) }).then(() => true, () => false);
      if (done) n++;
    }
    return n;
  }
  const bad = (code = "provider_error") => { const err = new Error(code); err.status = 400; return err; };
  return {
    name: "cashfree",
    mode: env === "production" ? "live" : "test",
    needsPhone: true,       // Cashfree asks for the payer's mobile number
    webhookReady: true,     // its notifications are signed with the secret key itself
    /* A payment page for one plan payment; the owner pays there. Returns { orderId: the link's id, payUrl }. */
    async createPayment({ paymentId, amount, currency = "INR", description, email, phone, callbackUrl, notifyUrl }) {
      if (!/^[6-9][0-9]{9}$/.test(str(phone))) { const err = new Error("phone_required"); err.status = 400; throw err; }
      const linkId = linkIdFor(paymentId);
      if (!LINK_ID.test(linkId)) { const err = new Error("provider_error"); err.status = 400; throw err; }
      const body = {
        link_id: linkId, link_amount: Math.round((+amount || 0) * 100) / 100, link_currency: str(currency) || "INR",
        link_purpose: str(description).slice(0, 120) || "Hangtag plan",
        customer_details: { customer_phone: str(phone), ...(email ? { customer_email: str(email).slice(0, 100) } : {}) },
        link_partial_payments: false, link_expiry_time: istTime(now() + PAGE_MINUTES * 60e3), link_auto_reminders: false,
        link_notify: { send_sms: false, send_email: false }, link_notes: { hangtag_payment: str(paymentId), hangtag_app: APP_NOTE },
        link_meta: { ...(callbackUrl ? { return_url: callbackUrl } : {}), ...(notifyUrl ? { notify_url: notifyUrl } : {}) },
      };
      // the payment's own id makes a retried request the same request at Cashfree
      const link = await call("/links", { method: "POST", body: JSON.stringify(body), headers: { "x-idempotency-key": str(paymentId) } });
      if (!link || str(link.link_id) !== linkId || !/^https:\/\//.test(str(link.link_url))) throw new Error("provider_error");
      return { orderId: linkId, payUrl: str(link.link_url) };
    },
    /* What Cashfree says about a payment page now (its link, then the money taken on it) */
    async getPayment(linkId) {
      if (!LINK_ID.test(str(linkId))) return { state: "failed", paid: 0, paymentId: null };
      const link = await call("/links/" + encodeURIComponent(linkId));
      const notes = link && link.link_notes && typeof link.link_notes === "object" ? link.link_notes : {};
      return { ...linkView(link, await moneyOn(linkId), now()), hangtag: str(notes.hangtag_app) === APP_NOTE, ref: str(notes.hangtag_payment) };
    },
    /* Withdraw a payment page (when it couldn't be recorded against its payment) */
    async cancelPayment(linkId) {
      if (!LINK_ID.test(str(linkId))) { const err = new Error("provider_error"); err.status = 400; throw err; }
      await call("/links/" + encodeURIComponent(linkId) + "/cancel", { method: "POST", body: "{}" });
      return true;
    },
    /* The Hangtag link an order of Cashfree's belongs to (a refund or a dispute names the order), or null */
    async linkOfOrder(orderId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(str(orderId))) return null;
      const o = await call("/orders/" + encodeURIComponent(orderId));
      const tags = o && o.order_tags && typeof o.order_tags === "object" ? o.order_tags : {};
      return [tags.link_id, o && o.link_id, o && o.order_id].map(str).find((v) => LINK_ID.test(v)) || null;
    },
    /* AutoPay. Its terms come from Hangtag's AutoPay plan, so there is no plan at Cashfree to check first (autopayInline);
       autopayAuthAmount is what the owner's bank or UPI app may take to confirm the mandate, refunded. */
    autopayInline: true,
    autopayAuthAmount: AUTOPAY_AUTH_AMOUNT,
    /* The set-up: an on-demand mandate for up to the AutoPay plan's price, approved by the owner on Cashfree's page — opened
       from the app's own autopay.html, the only page that loads Cashfree's script (the session id rides in its #part).
       Returns { subscriptionId, authUrl, customerId: null }. */
    async createAutopay({ ref, terms, phone, email, appUrl, returnUrl, notes, expireAt }) {
      const subscriptionId = autopayIdFor(ref), price = Math.round((+(terms && terms.price) || 0) * 100) / 100;
      const app = str(appUrl).trim().replace(/\/+$/, ""), plan = (terms && terms.plan) || {};
      if (!AUTOPAY_ID.test(subscriptionId) || !(price > 0) || !/^https:\/\//.test(app)) throw bad();
      if (!/^[6-9][0-9]{9}$/.test(str(phone))) throw bad("phone_required");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(email))) throw bad("email_required");
      const tags = Object.fromEntries(Object.entries(notes || {}).filter(([, v]) => v != null && v !== "").slice(0, 10).map(([k, v]) => [k, str(v).slice(0, 255)]));
      const body = {
        subscription_id: subscriptionId,
        customer_details: { customer_phone: str(phone), customer_email: str(email).slice(0, 100) },
        plan_details: { plan_name: ("Hangtag " + (str(plan.label) || "AutoPay")).slice(0, 40), plan_type: "ON_DEMAND", plan_max_amount: price,
          plan_currency: str((terms && terms.currency) || "INR").toUpperCase(), plan_note: `Hangtag AutoPay: up to ${price} every ${+plan.months > 1 ? plan.months + " months" : "month"}` },
        authorization_details: { authorization_amount: AUTOPAY_AUTH_AMOUNT, authorization_amount_refund: true },
        subscription_meta: returnUrl ? { return_url: str(returnUrl) } : {},
        subscription_expiry_time: istTime(+expireAt || now() + 10 * 365 * 86400e3),
        subscription_tags: tags,
      };
      // a set-up's id (a UUID) makes a retried request the same request at Cashfree
      const key = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(ref)) ? { "x-idempotency-key": str(ref) } : {};
      const s = await call("/subscriptions", { method: "POST", body: JSON.stringify(body), headers: key });
      const session = str(s && s.subscription_session_id);
      if (!s || str(s.subscription_id) !== subscriptionId || !/^[A-Za-z0-9_.-]{10,500}$/.test(session)) throw new Error("provider_error");
      return { subscriptionId, authUrl: `${app}/autopay.html#cf=${encodeURIComponent(session)}&env=${env}`, customerId: null };
    },
    /* What Cashfree says about a mandate now */
    async getAutopay(subscriptionId) {
      if (!AUTOPAY_ID.test(str(subscriptionId))) return { status: "unknown", event: null, nextChargeAt: null, paidCount: 0 };
      return mandateView(await call("/subscriptions/" + encodeURIComponent(subscriptionId)));
    },
    /* Turn a mandate off at once: no further charge can be made on it, and a charge already asked for that hasn't begun is
       withdrawn too — whatever the cancel itself answered (Cashfree refuses to cancel twice, so a retried cancel errors
       although the mandate is off). The cancel's own error is then passed on; cancelOrConfirm reads the mandate back. */
    async cancelAutopay(subscriptionId) {
      if (!AUTOPAY_ID.test(str(subscriptionId))) throw bad();
      const path = "/subscriptions/" + encodeURIComponent(subscriptionId);
      let s = null, failed = null;
      try { s = await call(path + "/manage", { method: "POST", body: JSON.stringify({ subscription_id: subscriptionId, action: "CANCEL" }) }); }
      catch (e) { failed = e; }
      await withdrawPending(subscriptionId);
      if (failed) throw failed;
      const st = mandateView(s);
      return st.status === "unknown" ? mandateView(await call(path)) : st;
    },
    listCharges,
    listMandatePayments,
    withdrawPending,
    // when the reconciler asks for a charge (chargeWhenDue): from chargeLeadMs before it is due, never sooner than
    // chargeMinAheadMs ahead of the day it is taken, named once per due date
    chargeLeadMs: CHARGE_LEAD_MS,
    chargeMinAheadMs: CHARGE_MIN_AHEAD_MS,
    chargeRef: chargeIdFor,
    /* Ask for one charge on a mandate (ref: chargeIdFor its due date), taken on scheduleAt's India date. Asked twice, Cashfree
       refuses the payment_id; the charge already there is then returned. → { id, ref, status, already? } */
    async raiseCharge({ subscriptionId, ref, amount, scheduleAt }) {
      const rupees = Math.round((+amount || 0) * 100) / 100;
      if (!AUTOPAY_ID.test(str(subscriptionId)) || !/^htc_[0-9a-z_]{8,60}$/.test(str(ref)) || !(rupees > 0) || !(+scheduleAt > 0)) throw bad();
      try {
        const p = await call("/subscriptions/pay", { method: "POST", body: JSON.stringify({ subscription_id: subscriptionId, payment_id: ref, payment_type: "CHARGE",
          payment_amount: rupees, payment_schedule_date: istTime(+scheduleAt), payment_remarks: "Hangtag AutoPay" }) });
        return { id: str(p && p.cf_payment_id), ref, status: str(p && p.payment_status).toLowerCase() };
      } catch (e) {
        if (e && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) {
          const there = (await listCharges(subscriptionId)).find((c) => c.ref === ref);
          if (there) return { ...there, already: true };
        }
        throw e;
      }
    },
    /* The webhook self-check (console, billing_selfcheck): a ₹1 Hangtag link and a ₹1 on-demand mandate, each withdrawn at
       once by the self-check, so their notifications prove Cashfree's reach this database (billing readiness). Nobody is
       asked to pay: Cashfree sends no SMS or email, and the contact on them is a placeholder. Returns their ids. */
    async createProbeLink(ref, { notifyUrl = null } = {}) {
      const page = await this.createPayment({ paymentId: ref, amount: 1, description: "Hangtag webhook self-check (not for payment)", phone: "9999999999", notifyUrl });
      return page.orderId;
    },
    async createProbeAutopay({ ref }) {
      // its own id (and so no idempotency key): Cashfree refuses an idempotency key it has seen on another request (422), and
      // the probe link already used the self-check's id as its key
      const made = await this.createAutopay({ ref: "p" + str(ref).toLowerCase().replace(/[^0-9a-z]/g, ""), terms: { price: 1, currency: "INR", plan: { label: "Self-check", months: 1 } }, phone: "9999999999",
        email: "selfcheck@example.com", appUrl: "https://example.com", notes: { hangtag_probe: str(ref) }, expireAt: now() + 86400e3 });
      return made.subscriptionId;
    },
    verifyWebhook: (rawBody, headers) => verifySignature(rawBody, headers["x-webhook-timestamp"] || "", headers["x-webhook-signature"] || "", secretKey),
    readWebhook: (event, raw) => readCashfreeWebhook(event, raw),
    /* The notification's own id, for noting it once: Cashfree's x-idempotency-key (webhook version 2025-01-01 on), else
       a digest of the signed body */
    async eventIdOf(raw, headers) {
      const k = str(headers && headers["x-idempotency-key"]).trim();
      if (k) return k.slice(0, 200);
      const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str(raw))));
      return "sha256:" + Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
    },
  };
}
