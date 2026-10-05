// Razorpay as the payment provider for Hangtag plans (Payment Links API). Plain JS: used by the subscription and
// subscription-webhook Edge Functions and unit-tested in Node with a fake fetch (tests/unit/subscription-function.test.mjs).
// These are Hangtag's OWN keys (SUBSCRIPTION_RAZORPAY_KEY_ID / SUBSCRIPTION_RAZORPAY_KEY_SECRET), never a shop's keys
// (the shops' keys belong to the payment-gateway function). Amounts go to Razorpay in paise.
const API = "https://api.razorpay.com/v1";
const str = (v) => (v == null ? "" : String(v));
export const toPaise = (rupees) => Math.round((+rupees || 0) * 100);

/* The link's state as Hangtag reads it: { state: "paid"|"pending"|"expired"|"cancelled"|"failed", paid (paise), paymentId } */
export function linkState(link, now = Date.now()) {
  if (!link || typeof link !== "object" || !link.id) return { state: "failed", paid: 0, paymentId: null };
  const pays = Array.isArray(link.payments) ? link.payments.filter((p) => p && (p.status === "captured" || p.status === "authorized")) : [];
  const paid = +link.amount_paid || pays.reduce((a, p) => a + (+p.amount || 0), 0);
  const paymentId = pays[0] ? str(pays[0].payment_id || pays[0].id) : null;
  if (paid > 0 && link.status === "paid") return { state: "paid", paid, paymentId };
  if (link.status === "cancelled") return { state: "cancelled", paid, paymentId };
  if (link.status === "expired" || (link.expire_by && link.expire_by * 1000 < now)) return { state: "expired", paid, paymentId };
  if (link.status === "created" || link.status === "issued" || link.status === "partially_paid") return { state: "pending", paid, paymentId };
  return { state: "failed", paid, paymentId };
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
      throw err;
    }
    return json;
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
    verifyWebhook: (rawBody, headers) => verifySignature(rawBody, headers["x-razorpay-signature"] || "", webhookSecret),
    /* A webhook event → { orderId, paymentRef, view } for the plan payment it is about, or null */
    readWebhook(event) {
      const e = event && event.event, p = event && event.payload;
      if (!p || !p.payment_link || !p.payment_link.entity) return null;
      if (!["payment_link.paid", "payment_link.expired", "payment_link.cancelled"].includes(e)) return null;
      const link = { ...p.payment_link.entity }, pay = p.payment && p.payment.entity;
      if (pay && !Array.isArray(link.payments)) link.payments = [{ payment_id: pay.id, amount: pay.amount, status: pay.status }];
      return { orderId: str(link.id), paymentRef: str((link.notes && link.notes.hangtag_payment) || ""), view: linkState(link, now()) };
    },
  };
}
