// delivery-status: the providers' reports on the messages send-receipt handed them — WhatsApp (Meta's WhatsApp Cloud API
// webhooks), SMS and WhatsApp through Twilio (status callbacks) and email through Resend (webhooks, signed by Svix) —
// turned into the receipt's state on the bill: Delivered, or Failed with the reason (spec Phase 15: "Delivered, where the
// provider supports it"). Nothing is believed without the provider's signature. Pure (Web Crypto only): index.ts reads the
// request and writes hangtag_deliveries.
//   verifyMeta(appSecret, rawBody, header) · metaChallenge(params, verifyToken) · verifyTwilio(authToken, url, params, header)
//   verifySvix(secret, headers, rawBody, now) · reportsOf(provider, payload) → [{ provider, id, state: "delivered" | "failed", error? }]
//   patchFor(report, now) → { match: { provider, provider_message_id, from: [statuses] }, set: { … } }
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf) => { let s = ""; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/* the same length and the same characters, compared without stopping early */
export function sameText(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmac(alg, keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: alg }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, typeof data === "string" ? enc.encode(data) : data);
}
export const MAX_BODY = 256 * 1024;

/* ---------- WhatsApp Cloud API (Meta) ---------- */
/* The subscription check Meta makes when the webhook is set up: hub.mode=subscribe with the agreed token → the challenge */
export function metaChallenge(params, verifyToken) {
  const g = (k) => (params && typeof params.get === "function" ? params.get(k) : params && params[k]) || "";
  return verifyToken && g("hub.mode") === "subscribe" && sameText(g("hub.verify_token"), verifyToken) ? String(g("hub.challenge")) : null;
}
/* X-Hub-Signature-256: "sha256=" + HMAC-SHA256(app secret, the raw body) */
export async function verifyMeta(appSecret, rawBody, header) {
  if (!appSecret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  return sameText(header.slice(7).toLowerCase(), hex(await hmac("SHA-256", enc.encode(appSecret), rawBody)));
}

/* ---------- Twilio ---------- */
/* X-Twilio-Signature: base64(HMAC-SHA1(auth token, the full URL Twilio called + each POST field's name and value, sorted by name)) */
export async function verifyTwilio(authToken, url, params, header) {
  if (!authToken || !url || !header) return false;
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
  const data = url + [...p.keys()].sort().map((k) => k + p.getAll(k).join("")).join("");
  return sameText(header, b64(await hmac("SHA-1", enc.encode(authToken), data)));
}

/* ---------- Resend (Svix) ---------- */
/* svix-signature: "v1,<base64 HMAC-SHA256(secret, `${svix-id}.${svix-timestamp}.${body}`)>" (several, space-separated); the
   secret "whsec_<base64>"; the timestamp within 5 minutes */
export async function verifySvix(secret, headers, rawBody, now = Date.now()) {
  const h = (k) => (headers && typeof headers.get === "function" ? headers.get(k) : headers && headers[k]) || "";
  const id = h("svix-id"), ts = h("svix-timestamp"), sigs = h("svix-signature");
  if (!secret || !id || !/^\d{1,12}$/.test(ts) || !sigs) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  let key; try { key = unb64(String(secret).replace(/^whsec_/, "")); } catch { return false; }
  const want = b64(await hmac("SHA-256", key, `${id}.${ts}.${rawBody}`));
  return sigs.split(" ").some((s) => { const [v, sig] = s.split(","); return v === "v1" && sameText(sig, want); });
}

/* ---------- what the report says ---------- */
const clip = (s) => String(s || "").replace(/[\r\n]+/g, " ").slice(0, 280);
/* provider: "meta" | "twilio" | "resend"; payload: Meta / Resend JSON, Twilio's form fields → the messages' new states */
export function reportsOf(provider, payload) {
  const out = [];
  if (provider === "meta") {
    for (const e of (payload && Array.isArray(payload.entry) ? payload.entry : [])) for (const c of (Array.isArray(e && e.changes) ? e.changes : []))
      for (const s of (c && c.value && Array.isArray(c.value.statuses) ? c.value.statuses : [])) {
        const id = String(s && s.id || ""); if (!id) continue;
        if (s.status === "delivered" || s.status === "read") out.push({ provider, id, state: "delivered" });
        else if (s.status === "failed") { const er = Array.isArray(s.errors) && s.errors[0] || {}; out.push({ provider, id, state: "failed", error: clip(`WhatsApp couldn't deliver it${er.title ? ": " + er.title : ""}${er.code ? ` (${er.code})` : ""}.`) }); }
      }
  } else if (provider === "twilio") {
    const g = (k) => (payload && typeof payload.get === "function" ? payload.get(k) : payload && payload[k]) || "";
    const id = String(g("MessageSid") || g("SmsSid")), st = String(g("MessageStatus") || g("SmsStatus")), code = String(g("ErrorCode"));
    if (id && (st === "delivered" || st === "read")) out.push({ provider, id, state: "delivered" });
    else if (id && (st === "undelivered" || st === "failed")) out.push({ provider, id, state: "failed", error: clip(`The message couldn't be delivered${code ? ` (Twilio error ${code})` : ""}.`) });
  } else if (provider === "resend") {
    const t = String(payload && payload.type || ""), id = String(payload && payload.data && payload.data.email_id || "");
    if (id && t === "email.delivered") out.push({ provider, id, state: "delivered" });
    else if (id && t === "email.bounced") out.push({ provider, id, state: "failed", error: "The email bounced: the address couldn't receive it." });
  }
  return out;
}
/* The change on the delivery record: delivered (from pending or sent), failed (from pending or sent — never over a delivery
   already confirmed) */
export function patchFor(r, now = Date.now()) {
  const at = new Date(now).toISOString();
  return r.state === "delivered"
    ? { match: { provider: r.provider, provider_message_id: r.id, from: ["pending", "sent"] }, set: { status: "delivered", delivered_at: at, checked_at: at } }
    : { match: { provider: r.provider, provider_message_id: r.id, from: ["pending", "sent"] }, set: { status: "failed", error: r.error || "The provider couldn't deliver it.", checked_at: at } };
}
export const PROVIDERS = ["meta", "twilio", "resend"];
/* The address a provider reports to: DELIVERY_STATUS_URL with ?provider=… — send-receipt gives Twilio this one with each
   message, and Twilio signs exactly it, so both sides build it here */
export const callbackUrl = (base, provider) => { const b = String(base || "").trim(); return b ? b + (b.includes("?") ? "&" : "?") + "provider=" + provider : ""; };
