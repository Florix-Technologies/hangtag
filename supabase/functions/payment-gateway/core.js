// payment-gateway: payment intents at the provider (Razorpay) — a single-use UPI QR for an exact amount, or a card
// payment link the customer opens on their phone — on THE SHOP'S OWN merchant account, and what the provider says about
// them. Plain ES module with no Deno or Node APIs (WebCrypto only), so the unit tests import it directly
// (tests/unit/payments-delivery-cash.test.mjs, tests/unit/payment-gateway-handler.test.mjs); handler.js has the logic of
// each action, index.ts and ../payment-webhook/index.ts stay thin.
//
// Rules:
// - A gateway is optional, and it is always the shop's own: Razorpay keys the shop made in its own Razorpay account
//   (connect), so the provider settles the money to the shop's bank. There are no Hangtag keys for shops' customers'
//   payments, so no payment can go through a shared account. The keys are kept only sealed (AES-256-GCM with the
//   function's PAYMENT_ACCOUNTS_KEY, bound to the account and the field: a sealed secret copied to another account
//   doesn't open); the app sees a masked key id, never a secret.
// - Test keys only, until live payments are switched on (PAYMENT_LIVE_MODE=on, the owner's decision after the sandbox
//   tests): live keys are refused before anything is stored.
// - Creating, showing or refreshing a QR never makes it "verified". Only the provider's own record of a captured payment
//   of exactly the intent's amount does (qrView / linkView → nextIntent), read with the account the intent was made on.
// - Money that arrives for an intent that was cancelled or expired, or of another amount, is "unmatched": it is kept and
//   listed for the shop to refund or allocate, never silently attached to a bill.
// - A confirmation seen twice (status poll and webhook, or the same notification twice) changes the intent once; asking
//   again for the same bill part while its QR / link is still open gives that one back, never a second one to pay.
// - A return's refund goes back through the provider only onto that bill's verified payment, for the return's saved
//   refund, once (the refund id is kept on the return), and the provider's outcome of the refund is kept.

export const INTENT_STATES = ["created", "pending", "verified", "failed", "cancelled", "expired", "unmatched"];
export const METHODS = ["upi", "card"];
export const LIMITS = { amount: 1000000, note: 60, saleId: 64, reference: 40, perHour: 120 };
export const EXPIRY = { min: 2, max: 30, def: 5, linkMin: 16 };
/* What a shop sets up in its own Razorpay dashboard → Webhooks for this account (the address is shown on connecting) */
export const WEBHOOK_EVENTS = Object.freeze(["qr_code.credited", "qr_code.closed", "payment_link.paid", "payment_link.expired", "payment_link.cancelled",
  "refund.processed", "refund.failed"]);
const API = "https://api.razorpay.com/v1";
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const fail = (status, error, message) => ({ ok: false, status, error, message });
export const toPaise = (r) => Math.round((+r || 0) * 100);
const feePaise = payment => {
  if(!payment || payment.fee == null || payment.fee === '') return null;
  const fee = +payment.fee;
  return Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : null;
};

// ---------- the shop's own account ----------

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;
/* The keys a shop pastes from its Razorpay dashboard → { ok, keyId, keySecret, webhookSecret, mode } or a failure.
   Live keys pass only when live payments are switched on (liveOn). */
export function checkKeys({ keyId, keySecret, webhookSecret }, liveOn) {
  const id = str(keyId).trim(), secret = str(keySecret).trim(), hook = str(webhookSecret).trim();
  const m = KEY_ID.exec(id);
  if (!m) return fail(422, "bad_key_id", "The Key Id starts with rzp_test_ (or rzp_live_): copy it from Razorpay → Account & Settings → API Keys.");
  if (!/^[A-Za-z0-9]{12,64}$/.test(secret)) return fail(422, "bad_key_secret", "The Key Secret is the long code Razorpay shows once when the key is made.");
  if (!/^[\x21-\x7e]{8,128}$/.test(hook)) return fail(422, "bad_webhook_secret", "The webhook secret is the one you typed when adding the webhook in Razorpay (8 or more characters).");
  if (m[1] === "live" && !liveOn) return fail(422, "live_not_allowed", "Live keys can't be connected yet: Hangtag takes test keys (rzp_test_) until live payments are switched on.");
  if (secret === hook) return fail(422, "bad_webhook_secret", "Use a webhook secret of its own, not the Key Secret.");
  return { ok: true, keyId: id, keySecret: secret, webhookSecret: hook, mode: m[1] };
}
export const liveAllowed = (env) => str(env && env.PAYMENT_LIVE_MODE).trim().toLowerCase() === "on";
/* "rzp_test_…Ab3d": enough to recognise the key, nothing to use */
export const maskKey = (keyId) => { const k = str(keyId), m = /^(rzp_(?:test|live)_)/.exec(k); return m ? m[1] + "…" + k.slice(-4) : ""; };

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => { const t = str(s).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "===".slice((t.length + 3) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
/* The function's sealing key from PAYMENT_ACCOUNTS_KEY (32 random bytes, base64 or base64url: `openssl rand -base64 32`),
   or null when it isn't set or isn't 32 bytes */
export async function accountsKey(env) {
  const raw = str(env && env.PAYMENT_ACCOUNTS_KEY).trim();
  if (!raw) return null;
  let bytes;
  try { bytes = unb64u(raw); } catch { return null; }
  if (bytes.length !== 32) return null;
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
/* A secret sealed for one account and field: "v1.<iv>.<ciphertext>" (AES-256-GCM; the account and field are its
   additional data, so the box opens only where it was sealed) */
export async function seal(key, secret, accountId, field) {
  const iv = crypto.getRandomValues(new Uint8Array(12)), enc = new TextEncoder();
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(accountId + "|" + field) }, key, enc.encode(secret)));
  return "v1." + b64u(iv) + "." + b64u(ct);
}
/* The secret in a box, or null (another account's or field's box, a changed box, another key) */
export async function unseal(key, box, accountId, field) {
  const m = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,400})$/.exec(str(box));
  if (!key || !m) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(m[1]), additionalData: new TextEncoder().encode(accountId + "|" + field) }, key, unb64u(m[2]));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}
/* The random id in an account's webhook address (32 bytes) */
export const newHookId = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
export const webhookUrl = (supabaseUrl, hookId) => str(supabaseUrl).replace(/\/+$/, "") + "/functions/v1/payment-webhook?a=" + encodeURIComponent(hookId);
/* The provider calls of one account: its key id and opened secret */
export const accountConfig = (row, secret) => ({ name: "razorpay", accountId: row.id, id: row.key_id, secret, mode: row.mode, cardLink: row.card_link !== false });
export const basicAuth = (cfg) => "Basic " + btoa(cfg.id + ":" + cfg.secret);
export const apiUrl = (path) => API + path;

/* May this account take provider payments? PAYMENT_ALLOWED_USERS: user ids or emails, comma-separated, or "*" — the
   shops a gateway is switched on for (the pilot's list). A shop's team member takes payments for the shop: listing the
   shop's owner (owner: looked up from the shop id the database gives) lets the whole team take them. */
export function allowedToPay(user, env, owner = null) {
  const list = str(env.PAYMENT_ALLOWED_USERS).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!user || !list.length) return false;
  const listed = (a) => !!a && (list.includes(str(a.id).toLowerCase()) || (!!a.email && list.includes(str(a.email).toLowerCase())));
  return list.includes("*") || listed(user) || listed(owner);
}
/* What a team member needs (hangtag_can) for each action; the owner may do everything. null = anyone in the shop.
   Seeing unmatched money is a report (view_reports); settling it (a provider refund, or marking it paid back or added to a
   bill) moves money, so it needs perform_return like any refund. Connecting or disconnecting the shop's account is a
   shop setting. */
export const ACTION_PERMISSIONS = { config: null, status: null, create: "create_sale", cancel: "create_sale", verify: "create_sale",
  refund_return: "perform_return", unmatched: "view_reports", resolve: "perform_return", connect: "manage_settings", disconnect: "manage_settings" };
export const permissionFor = (action) => (Object.prototype.hasOwnProperty.call(ACTION_PERMISSIONS, action) ? ACTION_PERMISSIONS[action] : "manage_settings");
/* What the app may offer: { provider, upi, cardLink } (all off without the shop's own connected account), and the
   gateway's set-up: whether this shop may connect one (available), and the connected account as the app may show it */
export function configView(account, { allowed, available, manage = false, supabaseUrl = "" } = {}) {
  const on = !!account && !!allowed && available !== false;
  return { ok: true, provider: on ? "razorpay" : null, upi: on, cardLink: on && account.card_link !== false,
    gateway: { available: !!allowed && !!available, connected: !!account, ...(account ? { provider: "razorpay", mode: account.mode, keyId: maskKey(account.key_id),
      checkedAt: account.checked_at ? Date.parse(account.checked_at) : null, lastEventAt: account.last_event_at ? Date.parse(account.last_event_at) : null,
      ...(manage ? { webhookUrl: webhookUrl(supabaseUrl, account.hook_id), events: [...WEBHOOK_EVENTS] } : {}) } : {}) } };
}

/* body → { ok, action, ... } or a failure. Only these fields are read. */
export function validateRequest(body) {
  if (!body || typeof body !== "object") return fail(400, "bad_request", "Send the request as JSON.");
  const a = body.action;
  if (a === "config" || a === "unmatched" || a === "disconnect") return { ok: true, action: a };
  if (a === "connect") {
    if (str(body.provider || "razorpay") !== "razorpay") return fail(400, "bad_provider", "Only Razorpay can be connected for now.");
    return { ok: true, action: a, keyId: str(body.key_id), keySecret: str(body.key_secret), webhookSecret: str(body.webhook_secret) };
  }
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
/* An intent still open for exactly this bill part, on this account, with at least a minute left: asked for again (a retry,
   a double tap, a second phone) it is given back instead of a second QR or link the customer could also pay */
export function reusable(row, { accountId, saleId, method, amount }, now) {
  return !!row && row.account_id === accountId && row.client_sale_id === saleId && row.method === method && toPaise(row.amount) === toPaise(amount)
    && (row.status === "pending" || row.status === "created") && row.kind !== "match" && !!row.expires_at && Date.parse(row.expires_at) - now > 60_000;
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
  ...(row.refund_status ? { refundStatus: row.refund_status } : {}), createdAt: row.created_at ? Date.parse(row.created_at) : null });

/* A UPI payment checked by hand (reference typed in) matched to the provider's captured payments: same amount and the
   same bank reference (RRN / UTR). Returns the payment or null. */
export function matchManual(payments, { amount, reference }) {
  const ref = str(reference).replace(/\s/g, "").toUpperCase(), want = toPaise(amount);
  if (!ref) return null;
  const hits = (payments || []).filter((p) => p && p.method === "upi" && (p.status === "captured" || p.status === "authorized") && +p.amount === want &&
    [p.acquirer_data && p.acquirer_data.rrn, p.acquirer_data && p.acquirer_data.upi_transaction_id, p.id].some((x) => x && str(x).toUpperCase() === ref));
  return hits.length === 1 ? hits[0] : null;
}
/* A refund's state as Razorpay gives it → "pending" | "processed" | "failed" */
export const refundState = (status) => (status === "processed" ? "processed" : status === "failed" ? "failed" : "pending");

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
/* The notification's id: Razorpay's x-razorpay-event-id, else the body's SHA-256 (the same body sent again is the same
   notification) */
export async function eventIdOf(header, rawBody) {
  const h = str(header).trim();
  if (/^[A-Za-z0-9_.:-]{1,100}$/.test(h)) return h;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody)));
  return "sha256:" + Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 64);
}
/* Which intent (or refund) a webhook event is about, and what it says: { kind, providerIntentId, view } |
   { kind: "refund", refundId, paymentId, state } | null */
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
  if ((e === "refund.processed" || e === "refund.failed") && p.refund && p.refund.entity && p.refund.entity.id)
    return { kind: "refund", refundId: str(p.refund.entity.id), paymentId: str(p.refund.entity.payment_id), state: e === "refund.processed" ? "processed" : "failed" };
  return null;
}
