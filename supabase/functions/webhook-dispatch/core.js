// Pure parts of the "webhook-dispatch" Edge Function (unit-tested in Node: tests/unit/webhooks.test.mjs).
// Outbound webhooks are a small integration foundation, not a developer platform: a shop's owner adds an https address and
// picks events (Settings → Advanced → Integrations). The database writes one event per change it already knows about and
// one delivery per endpoint (supabase/schema.sql section 3r: idempotent — a bill uploaded twice is one event); this
// function sends them, signed, and retries with back-off.
//   POST <url>  body: {"id","type","created_at","data"}
//   X-Hangtag-Event: sale.completed · X-Hangtag-Event-Id: <uuid> (the same on every retry: receivers drop repeats)
//   X-Hangtag-Timestamp: <unix seconds> · X-Hangtag-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the endpoint secret>
// The secret is made by the database, shown to the owner once, and only ever read here (service role). It never reaches
// the app's JavaScript after that.
export const WEBHOOK_EVENTS = ["sale.completed", "payment.recorded", "order.created", "order.updated", "purchase.received", "inventory.changed", "customer.created"];
export const EVENT_LABELS = { "sale.completed": "Bill completed", "payment.recorded": "Payment recorded", "order.created": "Order created", "order.updated": "Order updated",
  "purchase.received": "Stock received", "inventory.changed": "Stock changed", "customer.created": "Customer added", "webhook.test": "Test" };
export const MAX_ATTEMPTS = 8;
/* Seconds to wait before attempt n+1 after n failed attempts (1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h) */
const BACKOFF = [60, 300, 900, 3600, 10800, 21600, 43200];
export const retryDelay = attempts => BACKOFF[Math.min(Math.max(1, attempts) - 1, BACKOFF.length - 1)];
export const TIMEOUT_MS = 10000;
const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
/* "sha256=<hex>" of HMAC-SHA256(secret, "<timestamp>.<body>") — WebCrypto, the same in Deno and Node */
export async function signature(secret, timestamp, body){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`)));
}
/* Constant-time check a receiver can copy (also used by the tests) */
export async function verifySignature(secret, timestamp, body, header, { now = Math.floor(Date.now() / 1000), tolerance = 300 } = {}){
  if(!/^\d+$/.test(String(timestamp)) || Math.abs(now - +timestamp) > tolerance) return false;
  const want = await signature(secret, timestamp, body), got = String(header || "");
  if(want.length !== got.length) return false;
  let d = 0; for(let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}
/* The body sent for an event row ({ id, type, payload, created_at }) — the same bytes on every retry */
export const eventBody = e => JSON.stringify({ id: e.id, type: e.type, created_at: new Date(e.created_at).toISOString(), data: e.payload || {} });
export const deliveryHeaders = ({ id, type, timestamp, sig }) => ({ "Content-Type": "application/json", "User-Agent": "Hangtag-Webhooks/1",
  "X-Hangtag-Event": type, "X-Hangtag-Event-Id": id, "X-Hangtag-Timestamp": String(timestamp), "X-Hangtag-Signature": sig });
/* What a response means: delivered (2xx), retry (network, timeout, 408, 425, 429, 5xx) or failed (other 4xx: the receiver
   refuses it; retrying won't help) */
export function outcome(status){
  if(status >= 200 && status < 300) return "delivered";
  if(!status || status === 408 || status === 425 || status === 429 || status >= 500) return "retry";
  return "failed";
}
/* After an attempt → { status: "delivered" | "pending" | "failed", retryIn (seconds, for pending) } */
export function afterAttempt(attempts, httpStatus){
  const o = outcome(httpStatus);
  if(o === "delivered") return { status: "delivered" };
  if(o === "failed" || attempts >= MAX_ATTEMPTS) return { status: "failed" };
  return { status: "pending", retryIn: retryDelay(attempts) };
}
/* An endpoint address the shop may use: https, a public host name (no localhost, private or link-local addresses, no
   credentials in it, the default port or 443/8443). The function checks the resolved addresses again before sending. */
export function checkUrl(raw){
  let u;
  try{ u = new URL(String(raw || "").trim()); }catch(_e){ return { error: "Enter the full address, starting with https://" }; }
  if(u.protocol !== "https:") return { error: "Webhook addresses must start with https://" };
  if(u.username || u.password) return { error: "Don't put a user name or password in the address." };
  if(u.port && !["443", "8443"].includes(u.port)) return { error: "Use the standard https port." };
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if(!h.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h)) return { error: "Use a public internet address." };
  if(privateAddress(h)) return { error: "Use a public internet address." };
  if(String(raw).length > 500) return { error: "That address is too long." };
  return { url: u.toString() };
}
/* Is this IP literal private, loopback, link-local, carrier-grade NAT or otherwise not on the public internet? */
export function privateAddress(h){
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if(v4){
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if(h.includes(":")){
    const x = h.toLowerCase();
    return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")
      || x.startsWith("::ffff:") || x.startsWith("64:ff9b:");
  }
  return false;
}
export const checkEvents = list => {
  const ev = [...new Set((Array.isArray(list) ? list : []).map(String))];
  if(!ev.length) return { error: "Choose at least one event." };
  const bad = ev.find(e => !WEBHOOK_EVENTS.includes(e));
  return bad ? { error: "Unknown event: " + bad } : { events: ev };
};
