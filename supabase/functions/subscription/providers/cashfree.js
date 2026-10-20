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

/* A time as Cashfree's examples write it: India time with its offset, whole seconds ("2026-10-13T16:30:00+05:30") */
export function istTime(ms) {
  return new Date(ms + 330 * 60e3).toISOString().slice(0, 19) + "+05:30";
}

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
  if (st === "EXPIRED") return { state: "expired", paid: 0, paymentId: null, currency };
  const ends = Date.parse(str(link.link_expiry_time));
  if (st === "ACTIVE" && Number.isFinite(ends) && ends < now) return { state: "expired", paid: 0, paymentId: null, currency };
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
    const orders = await call("/links/" + encodeURIComponent(linkId) + "/orders?status=PAID");
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
        link_partial_payments: false, link_expiry_time: istTime(now() + 60 * 60e3), link_auto_reminders: false,
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
