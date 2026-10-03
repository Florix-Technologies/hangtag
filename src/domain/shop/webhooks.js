// Outbound webhooks, as the owner sets them up (Settings → Advanced → Integrations): which events, and an https address on
// the public internet. The same rules as supabase/functions/webhook-dispatch/core.js (tests/unit/webhooks.test.mjs checks
// they agree); the database refuses anything else too. Pure.
export const WEBHOOK_EVENTS = ["sale.completed", "payment.recorded", "order.created", "order.updated", "purchase.received", "inventory.changed", "customer.created"];
export const EVENT_LABELS = { "sale.completed": "Bill completed", "payment.recorded": "Payment recorded", "order.created": "Order created", "order.updated": "Order updated",
  "purchase.received": "Stock received", "inventory.changed": "Stock changed", "customer.created": "Customer added", "webhook.test": "Test" };
export const DELIVERY_LABELS = { pending: "Waiting", sending: "Sending", delivered: "Delivered", failed: "Failed" };
export const MAX_ENDPOINTS = 5;
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
/* → { url } or { error } */
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
/* → { events } or { error } */
export function checkEvents(list){
  const ev = [...new Set((Array.isArray(list) ? list : []).map(String))];
  if(!ev.length) return { error: "Choose at least one event." };
  const bad = ev.find(e => !WEBHOOK_EVENTS.includes(e));
  return bad ? { error: "Unknown event: " + bad } : { events: ev };
}
