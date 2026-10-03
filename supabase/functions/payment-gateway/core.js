// payment-gateway: payment intents at the provider (Razorpay) — a single-use UPI QR for an exact amount, or a card
// payment link the customer opens on their phone — and what the provider says about them. Plain ES module with no Deno
// or Node APIs, so the unit tests import it directly (tests/unit/payment-gateway.test.mjs); index.ts and
// ../payment-webhook/index.ts stay thin.
//
// Rules:
// - Provider keys are this function's secrets only; the app sees a QR image / link, opaque ids and a state.
// - Creating, showing or refreshing a QR never makes it "verified". Only the provider's own record of a captured payment
//   of exactly the intent's amount does (qrView / linkView → nextIntent).
// - Money that arrives for an intent that was cancelled or expired, or of another amount, is "unmatched": it is kept and
//   listed for the shop to refund or allocate, never silently attached to a bill.
// - A confirmation seen twice (status poll and webhook) changes the intent once.
// - A return's refund goes back through the provider only onto that bill's verified payment, for the return's saved
//   refund, once (the refund id is kept on the return).

export const INTENT_STATES = ["created", "pending", "verified", "failed", "cancelled", "expired", "unmatched"];
export const METHODS = ["upi", "card"];
export const LIMITS = { amount: 1000000, note: 60, saleId: 64, reference: 40, perHour: 120 };
export const EXPIRY = { min: 2, max: 30, def: 5, linkMin: 16 };
const API = "https://api.razorpay.com/v1";
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const fail = (status, error, message) => ({ ok: false, status, error, message });
export const toPaise = (r) => Math.round((+r || 0) * 100);
const feePaise = payment => {
  if(!payment || payment.fee == null || payment.fee === '') return null;
  const fee = +payment.fee;
  return Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : null;
};

/* Razorpay keys from the function's secrets, or null */
export function razorpayConfig(env) {
  const id = str(env.RAZORPAY_KEY_ID).trim(), secret = str(env.RAZORPAY_KEY_SECRET).trim();
  if (!id || !secret) return null;
  const off = str(env.PAYMENT_CARD_LINK).trim().toLowerCase() === "off";
  return { name: "razorpay", id, secret, webhookSecret: str(env.RAZORPAY_WEBHOOK_SECRET).trim(), cardLink: !off };
}
export const basicAuth = (cfg) => "Basic " + btoa(cfg.id + ":" + cfg.secret);
export const apiUrl = (path) => API + path;

/* May this account take provider payments? PAYMENT_ALLOWED_USERS: user ids or emails, comma-separated, or "*". A shop's
   team member takes payments for the shop: listing the shop's owner (owner: looked up from the shop id the database
   gives) lets the whole team take them. */
export function allowedToPay(user, env, owner = null) {
  const list = str(env.PAYMENT_ALLOWED_USERS).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!user || !list.length) return false;
  const listed = (a) => !!a && (list.includes(str(a.id).toLowerCase()) || (!!a.email && list.includes(str(a.email).toLowerCase())));
  return list.includes("*") || listed(user) || listed(owner);
}
/* What a team member needs (hangtag_can) for each action; the owner may do everything. null = anyone in the shop.
   Seeing unmatched money is a report (view_reports); settling it (a provider refund, or marking it paid back or added to a
   bill) moves money, so it needs perform_return like any refund. */
export const ACTION_PERMISSIONS = { config: null, status: null, create: "create_sale", cancel: "create_sale", verify: "create_sale",
  refund_return: "perform_return", unmatched: "view_reports", resolve: "perform_return" };
export const permissionFor = (action) => (Object.prototype.hasOwnProperty.call(ACTION_PERMISSIONS, action) ? ACTION_PERMISSIONS[action] : "manage_settings");
/* What the app may offer: { provider, upi, cardLink } (all off when not set up or not allowed) */
export function configView(cfg, allowed) {
  const on = !!cfg && !!allowed;
  return { ok: true, provider: on ? cfg.name : null, upi: on, cardLink: on && cfg.cardLink };
}

/* body → { ok, action, ... } or a failure. Only these fields are read. */
export function validateRequest(body) {
  if (!body || typeof body !== "object") return fail(400, "bad_request", "Send the request as JSON.");
  const a = body.action;
  if (a === "config" || a === "unmatched") return { ok: true, action: a };
  if (a === "create") {
    const method = body.method, amount = +body.amount, saleId = str(body.sale_id).trim();
    if (!METHODS.includes(method)) return fail(400, "bad_method", "Choose UPI or card.");
    if (!Number.isFinite(amount) || amount <= 0 || amount > LIMITS.amount || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6)
      return fail(422, "bad_amount", "The amount must be more than ₹0 and at most 2 decimal places.");
    if (!saleId || saleId.length > LIMITS.saleId) return fail(400, "bad_request", "Which bill? The bill id is missing.");
    const exp = Math.round(+body.expiry_min);
    return { ok: true, action: a, method, amount: Math.round(amount * 100) / 100, saleId, note: str(body.note).replace(/[^\w .#/-]/g, "").slice(0, LIMITS.note),
      expiryMin: Number.isFinite(exp) ? Math.min(EXPIRY.max, Math.max(EXPIRY.min, exp)) : EXPIRY.def };
  }
  if (a === "status" || a === "cancel") {
    const id = str(body.id).trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(400, "bad_request", "Which payment? The id is missing.");
    return { ok: true, action: a, id };
  }
  if (a === "verify") {
    const saleId = str(body.sale_id).trim(), reference = str(body.reference).trim();
    if (!saleId || saleId.length > LIMITS.saleId) return fail(400, "bad_request", "Which bill? The bill id is missing.");
    if (!reference || reference.length > LIMITS.reference) return fail(422, "bad_reference", "The UPI reference is missing.");
    return { ok: true, action: a, saleId, paymentId: saleId + ":upi", reference };
  }
  if (a === "refund_return") {
    const returnId = str(body.return_id).trim();
    if (!returnId || returnId.length > LIMITS.saleId) return fail(400, "bad_request", "Which return? The return id is missing.");
    return { ok: true, action: a, returnId };
  }
  if (a === "resolve") {
    const id = str(body.id).trim(), resolution = body.resolution;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(400, "bad_request", "Which payment? The id is missing.");
    if (!["refund", "refunded", "allocated"].includes(resolution)) return fail(400, "bad_request", "Choose refund or allocated.");
    return { ok: true, action: a, id, resolution, note: str(body.note).trim().slice(0, 200) };
  }
  return fail(400, "bad_request", "Unknown action.");
}

/* When the intent stops accepting money (ms). A payment link must stay open at least 16 minutes at Razorpay. */
export function expiresAt(method, expiryMin, now) {
  const m = method === "card" ? Math.max(EXPIRY.linkMin, expiryMin) : expiryMin;
  return now + m * 60_000;
}
/* Razorpay request bodies. Amounts go in paise. */
export function createQrBody({ amount, note, closeBy, intentId, saleId }) {
  return { type: "upi_qr", name: (note || "Hangtag bill").slice(0, 40), usage: "single_use", fixed_amount: true, payment_amount: toPaise(amount),
    description: ("Bill " + (note || saleId)).slice(0, 60), close_by: Math.floor(closeBy / 1000), notes: { intent_id: intentId, sale_id: saleId } };
}
export function createLinkBody({ amount, note, expireBy, intentId, saleId }) {
  return { amount: toPaise(amount), currency: "INR", accept_partial: false, description: ("Bill " + (note || saleId)).slice(0, 60),
    reference_id: intentId.replace(/-/g, "").slice(0, 40), expire_by: Math.floor(expireBy / 1000), reminder_enable: false,
    notify: { sms: false, email: false }, notes: { intent_id: intentId, sale_id: saleId },
    options: { checkout: { method: { card: "1", upi: "0", netbanking: "0", wallet: "0", emi: "0", paylater: "0" } } } };
}
/* The provider's QR code (and its payments) → { state: "paid"|"pending"|"expired"|"cancelled"|"failed", paid (paise), paymentId, method } */
export function qrView(qr, payments, now = Date.now()) {
  if (!qr || typeof qr !== "object" || !qr.id) return { state: "failed", paid: 0 };
  const captured = (payments || []).filter((p) => p && (p.status === "captured" || p.status === "authorized"));
  const paid = captured.length ? captured.reduce((a, p) => a + (+p.amount || 0), 0) : +qr.payments_amount_received || 0;
  const pay = captured[0], fees = captured.map(feePaise), hasFee = !!captured.length && fees.every(fee => fee != null);
  const base = { paid, paymentId: pay ? str(pay.id) : null, method: pay ? str(pay.method) : "upi", rrn: pay && pay.acquirer_data ? str(pay.acquirer_data.rrn) : "",
    ...(hasFee ? { fee: fees.reduce((sum, fee) => sum + fee, 0) } : {}) };
  if (paid > 0) return { state: "paid", ...base };
  if (qr.status === "closed") return { state: qr.close_reason === "on_demand" ? "cancelled" : "expired", ...base };
  if (qr.close_by && qr.close_by * 1000 < now) return { state: "expired", ...base };
  if (qr.status === "active") return { state: "pending", ...base };
  return { state: "failed", ...base };
}
/* The provider's payment link → the same shape */
export function linkView(link, now = Date.now()) {
  if (!link || typeof link !== "object" || !link.id) return { state: "failed", paid: 0 };
  const pays = Array.isArray(link.payments) ? link.payments.filter((p) => p && (p.status === "captured" || p.status === "authorized")) : [];
  const paid = +link.amount_paid || pays.reduce((a, p) => a + (+p.amount || 0), 0);
  const fees = pays.map(feePaise), hasFee = !!pays.length && fees.every(fee => fee != null);
  const base = { paid, paymentId: pays[0] ? str(pays[0].payment_id || pays[0].id) : null, method: pays[0] ? str(pays[0].method) : "card", rrn: "",
    ...(hasFee ? { fee: fees.reduce((sum, fee) => sum + fee, 0) } : {}) };
  if (paid > 0 && (link.status === "paid" || link.status === "partially_paid")) return { state: "paid", ...base };
  if (link.status === "cancelled") return { state: "cancelled", ...base };
  if (link.status === "expired" || (link.expire_by && link.expire_by * 1000 < now)) return { state: "expired", ...base };
  if (link.status === "created" || link.status === "issued") return { state: "pending", ...base };
  return { state: "failed", ...base };
}
/* The intent row's next state from what the provider says, or null when nothing changes (idempotent: a confirmation
   seen twice changes nothing the second time). */
export function nextIntent(intent, view) {
  if (!intent || !view) return null;
  const cur = intent.status, settled = cur === "verified" || cur === "unmatched";
  if (view.state === "paid") {
    if (settled) return null;
    const exact = view.paid === toPaise(intent.amount) && (intent.method !== "card" || !view.method || view.method === "card");
    const open = cur === "pending" || cur === "created";
    return { status: exact && open ? "verified" : "unmatched", paid_amount: view.paid / 100, provider_payment_id: view.paymentId || null,
      ...(view.fee != null && Number.isFinite(+view.fee) && +view.fee >= 0 ? { provider_fee: Math.round(+view.fee) / 100 } : {}) };
  }
  if (settled || cur === view.state) return null;
  if ((cur === "pending" || cur === "created") && ["expired", "cancelled", "failed"].includes(view.state)) return { status: view.state };
  if (cur === "created" && view.state === "pending") return { status: "pending" };
  return null;
}
/* The app's view of an intent row */
export const intentReply = (row) => ({ ok: true, id: row.id, method: row.method, kind: row.kind, status: row.status, amount: +row.amount,
  paidAmount: row.paid_amount == null ? null : +row.paid_amount, reference: row.reference, paymentId: row.provider_payment_id || null,
  qrUrl: row.qr_url || null, linkUrl: row.link_url || null, expiresAt: row.expires_at ? Date.parse(row.expires_at) : null,
  saleId: row.client_sale_id || null, resolution: row.resolution || null, ...(row.provider_fee == null ? {} : { providerFee: +row.provider_fee }),
  createdAt: row.created_at ? Date.parse(row.created_at) : null });

/* A UPI payment checked by hand (reference typed in) matched to the provider's captured payments: same amount and the
   same bank reference (RRN / UTR). Returns the payment or null. */
export function matchManual(payments, { amount, reference }) {
  const ref = str(reference).replace(/\s/g, "").toUpperCase(), want = toPaise(amount);
  if (!ref) return null;
  const hits = (payments || []).filter((p) => p && p.method === "upi" && (p.status === "captured" || p.status === "authorized") && +p.amount === want &&
    [p.acquirer_data && p.acquirer_data.rrn, p.acquirer_data && p.acquirer_data.upi_transaction_id, p.id].some((x) => x && str(x).toUpperCase() === ref));
  return hits.length === 1 ? hits[0] : null;
}

/* Webhook: the Razorpay signature is the HMAC-SHA256 (hex) of the raw body with the webhook secret. */
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
/* Which intent a webhook event is about, and what it says: { kind, providerIntentId, view } or null */
export function webhookTarget(event, now = Date.now()) {
  const e = event && event.event, p = event && event.payload;
  if (!p) return null;
  const pay = p.payment && p.payment.entity;
  if ((e === "qr_code.credited" || e === "qr_code.closed") && p.qr_code && p.qr_code.entity)
    return { kind: "qr", providerIntentId: str(p.qr_code.entity.id), view: qrView(p.qr_code.entity, pay ? [pay] : [], now) };
  if ((e === "payment_link.paid" || e === "payment_link.expired" || e === "payment_link.cancelled") && p.payment_link && p.payment_link.entity) {
    const link = { ...p.payment_link.entity };
    if (pay && !Array.isArray(link.payments)) link.payments = [{ payment_id: pay.id, amount: pay.amount, status: pay.status, method: pay.method, fee: pay.fee }];
    return { kind: "link", providerIntentId: str(link.id), view: linkView(link, now) };
  }
  return null;
}
