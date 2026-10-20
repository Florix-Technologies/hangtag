// Razorpay as the payment provider for Hangtag plans (Payment Links API). Plain JS: used by the subscription and
// subscription-webhook Edge Functions and unit-tested in Node with a fake fetch (tests/unit/subscription-function.test.mjs).
// These are Hangtag's OWN keys (SUBSCRIPTION_RAZORPAY_KEY_ID / SUBSCRIPTION_RAZORPAY_KEY_SECRET), never a shop's keys
// (the shops' keys belong to the payment-gateway function). Amounts go to Razorpay in paise.
const API = "https://api.razorpay.com/v1";
const str = (v) => (v == null ? "" : String(v));
export const toPaise = (rupees) => Math.round((+rupees || 0) * 100);

/* The link's state as Hangtag reads it: { state: "paid"|"pending"|"expired"|"cancelled"|"failed", paid (paise), paymentId }.
   Only a CAPTURED payment is money: a link Razorpay calls paid whose payment is only authorised waits (pending), so no
   plan is activated on an authorisation that may never be captured. */
export function linkState(link, now = Date.now()) {
  if (!link || typeof link !== "object" || !link.id) return { state: "failed", paid: 0, paymentId: null };
  const pays = Array.isArray(link.payments) ? link.payments.filter((p) => p && p.status === "captured") : [];
  const paid = pays.length ? (+link.amount_paid || pays.reduce((a, p) => a + (+p.amount || 0), 0)) : 0;
  const paymentId = pays[0] ? str(pays[0].payment_id || pays[0].id) : null;
  if (paid > 0 && link.status === "paid") return { state: "paid", paid, paymentId, currency: str(link.currency || "INR").toUpperCase() };
  if (link.status === "paid") return { state: "pending", paid: 0, paymentId: null };
  if (link.status === "cancelled") return { state: "cancelled", paid, paymentId };
  if (link.status === "expired" || (link.expire_by && link.expire_by * 1000 < now)) return { state: "expired", paid, paymentId };
  if (link.status === "created" || link.status === "issued" || link.status === "partially_paid") return { state: "pending", paid, paymentId };
  return { state: "failed", paid, paymentId };
}

/* An AutoPay subscription (Razorpay Subscriptions: the UPI / card mandate on Hangtag's plan) as Hangtag reads it: the event
   it amounts to now, or null while it only waits for the owner ("created") — and when the next charge is due */
const SUB_EVENTS = { authenticated: "authenticated", active: "activated", pending: "pending", halted: "halted", cancelled: "cancelled", completed: "completed", expired: "expired" };
export function autopayState(sub) {
  if (!sub || typeof sub !== "object" || !sub.id) return { status: "unknown", event: null, nextChargeAt: null, paidCount: 0 };
  return { status: str(sub.status), event: SUB_EVENTS[sub.status] || null, nextChargeAt: sub.charge_at ? new Date(sub.charge_at * 1000).toISOString() : null,
    paidCount: +sub.paid_count || 0 };
}
const SUB_ID = /^sub_[A-Za-z0-9]{6,40}$/;
const PAY_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const LINK_ID = /^plink_[A-Za-z0-9]{6,40}$/;
const isoOf = (sec) => (+sec > 0 ? new Date(+sec * 1000).toISOString() : null);
const notesOf = (o) => (o && o.notes && typeof o.notes === "object" && !Array.isArray(o.notes) ? o.notes : {});
/* A payment as the reconciler reads it: captured or not, in paise, and any refund (Razorpay keeps a partly refunded payment
   'captured' with refund_status 'partial') */
export function paymentState(p) {
  if (!p || typeof p !== "object" || !PAY_ID.test(str(p.id))) return null;
  return { id: str(p.id), status: str(p.status), captured: p.captured === true || p.status === "captured" || p.status === "refunded",
    amount: +p.amount || 0, currency: str(p.currency || "INR").toUpperCase(), refunded: !!p.refund_status || +p.amount_refunded > 0 || p.status === "refunded",
    amountRefunded: +p.amount_refunded || 0, invoiceId: str(p.invoice_id) || null, notes: notesOf(p), createdAt: isoOf(p.created_at) };
}

/* The webhook's signature: HMAC-SHA256 (hex) of the raw body with the webhook secret, compared in constant time */
export async function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const sig = str(signature).trim().toLowerCase();
  if (sig.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function razorpay({ keyId, keySecret, webhookSecret }, fetchImpl = fetch, now = () => Date.now()) {
  const auth = "Basic " + btoa(keyId + ":" + keySecret);
  async function call(path, init = {}) {
    const res = await fetchImpl(API + path, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers || {}) } });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error("provider_error");
      err.status = res.status;
      err.code = json && json.error && json.error.code;
      err.description = str(json && json.error && json.error.description).slice(0, 200);   // Razorpay's reason: a 400 covers "not found" and "already cancelled"
      throw err;
    }
    return json;
  }
  /* A list read in pages of 100 between two times (seconds), oldest pages Razorpay gives: { items, more } (more: the page
     cap was reached before a short page) */
  async function list(path, { from, to, skip = 0, pages = 5, query = "" } = {}) {
    const items = [];
    for (let k = 0; k < pages; k++) {
      const q = `count=100&skip=${skip + k * 100}${from ? `&from=${Math.floor(from)}` : ""}${to ? `&to=${Math.floor(to)}` : ""}${query}`;
      const page = await call(`${path}?${q}`);
      const got = Array.isArray(page && page.items) ? page.items : [];
      items.push(...got);
      if (got.length < 100) return { items, more: false };
    }
    return { items, more: true };
  }
  return {
    name: "razorpay",
    /* A payment page for one plan payment; the customer pays there. Returns { orderId, payUrl }. */
    async createPayment({ paymentId, amount, currency = "INR", description, email, callbackUrl }) {
      const body = {
        amount: toPaise(amount), currency, accept_partial: false, description: str(description).slice(0, 120) || "Hangtag plan",
        reference_id: str(paymentId).replace(/-/g, "").slice(0, 40), expire_by: Math.floor(now() / 1000) + 60 * 60,
        reminder_enable: false, notify: { sms: false, email: false }, notes: { hangtag_payment: str(paymentId) },
        ...(email ? { customer: { email: str(email).slice(0, 120) } } : {}),
        ...(callbackUrl ? { callback_url: callbackUrl, callback_method: "get" } : {}),
      };
      const link = await call("/payment_links", { method: "POST", body: JSON.stringify(body) });
      if (!link || !link.id || !link.short_url) throw new Error("provider_error");
      return { orderId: str(link.id), payUrl: str(link.short_url) };
    },
    /* What the provider says about a payment page now */
    async getPayment(orderId) {
      if (!/^plink_[A-Za-z0-9]{6,40}$/.test(str(orderId))) return { state: "failed", paid: 0, paymentId: null };
      return linkState(await call("/payment_links/" + encodeURIComponent(orderId)), now());
    },
    /* AutoPay: Hangtag's plan at the provider → { amount (paise), currency, period, interval } (checked against the
       AutoPay plan's price before any mandate is made) */
    async getPlan(planId) {
      if (!/^plan_[A-Za-z0-9]{6,40}$/.test(str(planId))) { const err = new Error("provider_error"); err.status = 400; throw err; }
      const p = await call("/plans/" + encodeURIComponent(planId));
      return { amount: +(p && p.item && p.item.amount) || 0, currency: str(p && p.item && p.item.currency), period: str(p && p.period), interval: +(p && p.interval) || 0 };
    },
    /* AutoPay set-up: a subscription on the plan that the owner authorises on its page; nothing is charged before startAt
       (ms; none = at once). Returns { subscriptionId, authUrl, customerId }. */
    async createAutopay({ planId, startAt, totalCount = 120, notes, expireBy }) {
      const body = { plan_id: str(planId), total_count: totalCount, quantity: 1, customer_notify: 1, notes: notes || {},
        ...(startAt ? { start_at: Math.floor(startAt / 1000) } : {}), ...(expireBy ? { expire_by: Math.floor(expireBy / 1000) } : {}) };
      const s = await call("/subscriptions", { method: "POST", body: JSON.stringify(body) });
      if (!s || !SUB_ID.test(str(s.id)) || !/^https:\/\//.test(str(s.short_url))) throw new Error("provider_error");
      return { subscriptionId: str(s.id), authUrl: str(s.short_url), customerId: s.customer_id ? str(s.customer_id) : null };
    },
    /* What the provider says about an AutoPay subscription now */
    async getAutopay(subscriptionId) {
      if (!SUB_ID.test(str(subscriptionId))) return { status: "unknown", event: null, nextChargeAt: null };
      return autopayState(await call("/subscriptions/" + encodeURIComponent(subscriptionId)));
    },
    /* Turn an AutoPay subscription off at once (no further charge) */
    async cancelAutopay(subscriptionId) {
      if (!SUB_ID.test(str(subscriptionId))) { const err = new Error("provider_error"); err.status = 400; throw err; }
      return autopayState(await call("/subscriptions/" + encodeURIComponent(subscriptionId) + "/cancel", { method: "POST", body: JSON.stringify({ cancel_at_cycle_end: 0 }) }));
    },
    /* Withdraw a payment page (when it couldn't be recorded against its payment) */
    async cancelPayment(orderId) {
      if (!LINK_ID.test(str(orderId))) { const err = new Error("provider_error"); err.status = 400; throw err; }
      await call("/payment_links/" + encodeURIComponent(orderId) + "/cancel", { method: "POST", body: "{}" });
      return true;
    },
    /* The reconciler's reads. A subscription's invoices (all pages): [{ id, status, paymentId, amount (paise) }] */
    async listInvoices(subscriptionId) {
      if (!SUB_ID.test(str(subscriptionId))) return [];
      const { items } = await list("/invoices", { pages: 10, query: "&subscription_id=" + encodeURIComponent(subscriptionId) });
      return items.filter((i) => i && i.id).map((i) => ({ id: str(i.id), status: str(i.status), paymentId: str(i.payment_id) || null, amount: +i.amount || 0 }));
    },
    async getInvoice(invoiceId) {
      if (!/^inv_[A-Za-z0-9]{6,40}$/.test(str(invoiceId))) return null;
      const i = await call("/invoices/" + encodeURIComponent(invoiceId));
      return i && i.id ? { id: str(i.id), subscriptionId: str(i.subscription_id) || null, paymentId: str(i.payment_id) || null } : null;
    },
    async getPaymentEntity(paymentId) {
      if (!PAY_ID.test(str(paymentId))) return null;
      return paymentState(await call("/payments/" + encodeURIComponent(paymentId)));
    },
    /* The account's subscriptions, payments and refunds created between two times (ms): { items, more } */
    async listSubscriptions({ from, to, pages } = {}) {
      const r = await list("/subscriptions", { from: from / 1000, to: to / 1000, pages });
      return { more: r.more, items: r.items.filter((s) => s && SUB_ID.test(str(s.id))).map((s) => ({ id: str(s.id), status: str(s.status), notes: notesOf(s), createdAt: isoOf(s.created_at) })) };
    },
    async listPayments({ from, to, pages } = {}) {
      const r = await list("/payments", { from: from / 1000, to: to / 1000, pages });
      return { more: r.more, items: r.items.map(paymentState).filter(Boolean) };
    },
    async listRefunds({ from, to, pages } = {}) {
      const r = await list("/refunds", { from: from / 1000, to: to / 1000, pages });
      return { more: r.more, items: r.items.filter((f) => f && f.id && PAY_ID.test(str(f.payment_id)))
        .map((f) => ({ id: str(f.id), paymentId: str(f.payment_id), amount: (+f.amount || 0) / 100, currency: str(f.currency || "INR").toUpperCase(), status: str(f.status) })) };
    },
    /* The webhook self-check: a ₹1 link and a subscription starting in a year, made and cancelled at once; each also ends by
       itself within minutes (expire_by) if its cancel fails. No money moves. Returns their ids. */
    async createProbeLink(ref) {
      const link = await call("/payment_links", { method: "POST", body: JSON.stringify({ amount: 100, currency: "INR", accept_partial: false,
        description: "Hangtag webhook self-check (not for payment)", expire_by: Math.floor(now() / 1000) + 20 * 60, reminder_enable: false,
        notify: { sms: false, email: false }, notes: { hangtag_probe: str(ref) } }) });
      if (!link || !LINK_ID.test(str(link.id))) throw new Error("provider_error");
      return str(link.id);
    },
    async createProbeAutopay({ planId, ref }) {
      const s = await call("/subscriptions", { method: "POST", body: JSON.stringify({ plan_id: str(planId), total_count: 1, quantity: 1, customer_notify: 0,
        start_at: Math.floor(now() / 1000) + 365 * 86400, expire_by: Math.floor(now() / 1000) + 15 * 60, notes: { hangtag_probe: str(ref) } }) });
      if (!s || !SUB_ID.test(str(s.id))) throw new Error("provider_error");
      return str(s.id);
    },
    webhookReady: !!webhookSecret,   // its notifications are signed with the webhook secret
    verifyWebhook: (rawBody, headers) => verifySignature(rawBody, headers["x-razorpay-signature"] || "", webhookSecret),
    /* The notification's own id, for noting it once: X-Razorpay-Event-Id (the same on every retry), else a digest of the
       signed body */
    async eventIdOf(raw, headers) {
      const k = str(headers && headers["x-razorpay-event-id"]).trim();
      if (k) return k.slice(0, 200);
      const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str(raw))));
      return "sha256:" + Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
    },
    /* A webhook event → { kind: "payment", orderId, paymentRef, view } for a plan payment, { kind: "autopay", subscriptionId,
       event, paymentId, amount (rupees), nextChargeAt, owner } for AutoPay — a charge only when the payment was CAPTURED —
       or null */
    readWebhook(event) {
      const e = event && event.event, p = event && event.payload;
      // the event's own time (the top-level created_at, the same on every retry) — not its subscription's creation time
      const createdAt = isoOf(event && event.created_at);
      if (typeof e === "string" && e.startsWith("subscription.") && p && p.subscription && p.subscription.entity) {
        const s = p.subscription.entity, pay = p.payment && p.payment.entity, notes = notesOf(s);
        const ev = { authenticated: "authenticated", activated: "activated", charged: "charged", pending: "pending", halted: "halted",
          cancelled: "cancelled", completed: "completed", resumed: "resumed" }[e.slice("subscription.".length)];
        if (!ev || !SUB_ID.test(str(s.id))) return null;
        if (ev === "charged" && !(pay && pay.status === "captured" && +pay.amount > 0 && str(pay.id))) return null;
        return { kind: "autopay", subscriptionId: str(s.id), event: ev, paymentId: ev === "charged" ? str(pay.id) : null, amount: ev === "charged" ? +pay.amount / 100 : null,
          currency: ev === "charged" ? str(pay.currency || "INR").toUpperCase() : null,
          nextChargeAt: s.charge_at ? new Date(s.charge_at * 1000).toISOString() : null, owner: str(notes.hangtag_owner) || null,
          mandate: str(notes.hangtag_mandate) || null, probe: !!notes.hangtag_probe, type: e, entityId: str(s.id), createdAt };
      }
      if (e === "refund.processed" && p && p.refund && p.refund.entity) {
        const f = p.refund.entity, pay = p.payment && p.payment.entity;
        if (!PAY_ID.test(str(f.payment_id))) return null;
        return { kind: "refund", paymentId: str(f.payment_id), refundId: str(f.id), amount: (+f.amount || 0) / 100, currency: str(f.currency || "INR").toUpperCase(),
          status: str(f.status), notes: notesOf(pay), invoiceId: str(pay && pay.invoice_id) || null, type: e, entityId: str(f.id), createdAt };
      }
      if (e === "payment.dispute.created" && p && p.dispute && p.dispute.entity) {
        const d = p.dispute.entity, pay = p.payment && p.payment.entity;
        if (!PAY_ID.test(str(d.payment_id))) return null;
        return { kind: "dispute", paymentId: str(d.payment_id), disputeId: str(d.id), amount: (+d.amount || 0) / 100, currency: str(d.currency || "INR").toUpperCase(),
          status: str(d.status), notes: notesOf(pay), invoiceId: str(pay && pay.invoice_id) || null, type: e, entityId: str(d.id), createdAt };
      }
      if (!p || !p.payment_link || !p.payment_link.entity) return null;
      if (!["payment_link.paid", "payment_link.expired", "payment_link.cancelled"].includes(e)) return null;
      const link = { ...p.payment_link.entity }, pay = p.payment && p.payment.entity;
      if (pay && !Array.isArray(link.payments)) link.payments = [{ payment_id: pay.id, amount: pay.amount, status: pay.status }];
      return { kind: "payment", orderId: str(link.id), paymentRef: str(notesOf(link).hangtag_payment || ""), view: linkState(link, now()),
        currency: pay ? str(pay.currency || "INR").toUpperCase() : null, probe: !!notesOf(link).hangtag_probe, type: e, entityId: str(link.id), createdAt };
    },
  };
}
