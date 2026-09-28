// Supabase Edge Function "send-receipt": sends a finished bill to its customer by email, WhatsApp or SMS through the
// provider set up in this function's secrets, and records the attempt in hangtag_deliveries.
// - Provider keys live only here (function secrets), never in the app.
// - The caller must be signed in and allowed to send (SEND_ALLOWED_USERS; sending is off until it is set). The bill, its lines, payments and
//   customer are read with the caller's own session, so row security decides what they can send. The recipient comes
//   from the customer record and the message is written here from the saved bill (core.js billMessage): the request
//   only names the bill and the channel.
// - Each attempt first takes a place in hangtag_deliveries ("pending"), which is what the hourly limit counts; if the
//   log can't be written or counted, nothing is sent.
// - "sent" is recorded and returned only when the provider accepted the message and returned its id.
// Deploy with JWT verification on (the default).
import { createClient } from "npm:@supabase/supabase-js@2";
import { CHANNEL_LABELS, ITEM_COLUMNS, MAX_PER_HOUR, PAYMENT_COLUMNS, PROFILE_COLUMNS, SALE_COLUMNS, allowedToSend, billMessage, configuredChannels,
  deliveryOutcome, fromName, providerConfig, recipientFor, reservationRow, validateRequest } from "./core.js";
import { deliver } from "./providers/index.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const env = () => Deno.env.toObject();
const unavailable = () => reply(503, { ok: false, error: "not_configured", message: "Sending isn't available right now. Try again later." });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  const auth = req.headers.get("Authorization");
  if (!auth) return reply(401, { ok: false, error: "unauthorized", message: "Sign in first." });
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: who } = await db.auth.getUser();
  const user = who && who.user;
  if (!user) return reply(401, { ok: false, error: "unauthorized", message: "Sign in again." });

  let body: unknown;
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_request", message: "Send the request as JSON." }); }
  const r = validateRequest(body);
  if (!r.ok) return reply(r.status, { ok: false, error: r.error, message: r.message });
  const allowed = allowedToSend(user, env());
  if (r.action === "channels") return reply(200, { ok: true, channels: configuredChannels(allowed ? env() : {}) });
  if (!allowed) return reply(503, { ok: false, error: "not_configured", message: "Sending bills isn't turned on for this account." });

  // the bill and its customer, as this user may see them (row security)
  const { data: sale, error: saleErr } = await db.from("hangtag_sales").select(SALE_COLUMNS).eq("id", r.saleId).maybeSingle();
  if (saleErr) { console.error("send-receipt: couldn't read the bill:", saleErr.message); return unavailable(); }
  if (!sale) return reply(404, { ok: false, error: "not_found", message: "That bill isn't in the cloud yet. Try again once it has uploaded." });
  if (sale.is_void) return reply(409, { ok: false, error: "cancelled", message: "A cancelled bill can't be sent." });
  const { data: customer, error: custErr } = sale.customer_id
    ? await db.from("hangtag_customers").select("name,phone,email").eq("id", sale.customer_id).maybeSingle()
    : { data: null, error: null };
  if (custErr) { console.error("send-receipt: couldn't read the customer:", custErr.message); return unavailable(); }
  const to = recipientFor(r.channel, { customer, sale });
  if (!to.ok) return reply(to.status, { ok: false, error: to.error, message: to.message });
  const cfg = providerConfig(r.channel, env());
  if (!cfg) return reply(503, { ok: false, error: "not_configured", message: `Sending by ${CHANNEL_LABELS[r.channel]} isn't set up for this shop yet.` });

  // the message, written from the saved bill
  const [items, payments, profile] = await Promise.all([
    db.from("hangtag_sale_items").select(ITEM_COLUMNS).eq("sale_id", sale.id).order("line_no").limit(500),
    db.from("hangtag_payments").select(PAYMENT_COLUMNS).eq("sale_id", sale.id).order("id"),
    db.from("hangtag_profiles").select(PROFILE_COLUMNS).eq("id", user.id).maybeSingle(),
  ]);
  if (items.error || payments.error || profile.error) { console.error("send-receipt: couldn't read the bill:", (items.error || payments.error || profile.error)!.message); return unavailable(); }
  const message = billMessage(r.channel, { sale, items: items.data || [], payments: payments.data || [], shop: profile.data || {}, customer });

  // written by the function only (the app can read these rows, not write them). Take a place first, then count: if two
  // requests race, both see each other's row, so the limit can't be passed; if the log fails, nothing is sent.
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const held = await admin.from("hangtag_deliveries").insert(reservationRow({ ownerId: user.id, saleId: sale.id, channel: r.channel, to: to.to, provider: cfg.name })).select("id").single();
  if (held.error || !held.data) { console.error("send-receipt: couldn't write the delivery log:", held.error && held.error.message); return unavailable(); }
  const heldId: string = held.data.id;
  const release = () => admin.from("hangtag_deliveries").delete().eq("owner_id", user.id).eq("id", heldId);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error: countErr } = await admin.from("hangtag_deliveries").select("id", { count: "exact", head: true }).eq("owner_id", user.id).gte("created_at", since);
  if (countErr || count == null) { console.error("send-receipt: couldn't count recent messages:", countErr && countErr.message); await release(); return unavailable(); }
  if (count > MAX_PER_HOUR) { await release(); return reply(429, { ok: false, error: "rate_limited", message: "Too many messages in the last hour. Try again later." }); }

  const result = await deliver(cfg, r.channel, { to: to.to, fromName: fromName(profile.data && profile.data.shop_name), ...message }, fetch);
  const outcome = deliveryOutcome(result);
  const saved = await admin.from("hangtag_deliveries").update(outcome).eq("owner_id", user.id).eq("id", heldId);
  if (saved.error) console.error("send-receipt: couldn't finish the delivery record:", saved.error.message);
  if (outcome.status === "sent") return reply(200, { ok: true, status: "sent", channel: r.channel, recipient: to.to, provider: cfg.name, provider_message_id: outcome.provider_message_id });
  console.error("send-receipt: provider refused:", cfg.name, result && result.status, outcome.error);
  return reply(502, { ok: false, status: "failed", error: "provider_error", message: `The ${CHANNEL_LABELS[r.channel]} service didn't accept the message: ${outcome.error}` });
});
