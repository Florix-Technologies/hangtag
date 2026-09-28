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
// - auto: true (the phone sending by itself when the bill completed) goes at most once per bill and channel: a unique index
//   on the "auto" rows makes a retry or a second phone get the first attempt's answer instead of a second message.
// - SMS and WhatsApp carry the bill's secure invoice link when RECEIPT_URL is set (hangtag_invoice_links, 12 months).
// - "refresh" asks Twilio / Resend what happened to the bill's messages (delivered / failed); "link" returns the link.
// Deploy with JWT verification on (the default).
import { createClient } from "npm:@supabase/supabase-js@2";
import { CHANNEL_LABELS, ITEM_COLUMNS, MAX_PER_HOUR, PAYMENT_COLUMNS, PROFILE_COLUMNS, SALE_COLUMNS, allowedToSend, billMessage, configuredChannels,
  deliveryOutcome, fromName, linkRow, linkUrl, liveLink, newToken, providerConfig, providerStatus, receiptBase, recipientFor, reservationRow,
  validateRequest } from "./core.js";
import { deliver } from "./providers/index.js";
import { fetchStatus } from "./providers/status.js";

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
  const admin = createClient(url, service, { auth: { persistSession: false } });

  // the bill's secure link: reused while it works, otherwise a new one (written by this function only)
  const billLink = async (saleId: string) => {
    const base = receiptBase(env());
    if (!base) return "";
    const { data: rows } = await admin.from("hangtag_invoice_links").select("token,revoked_at,expires_at").eq("owner_id", user.id).eq("sale_id", saleId)
      .is("revoked_at", null).order("created_at", { ascending: false }).limit(1);
    const cur = (rows || [])[0];
    if (cur && liveLink(cur) && Date.parse(cur.expires_at) - Date.now() > 30 * 864e5) return linkUrl(base, cur.token);
    const row = linkRow({ ownerId: user.id, saleId, token: newToken() });
    const { error } = await admin.from("hangtag_invoice_links").insert(row);
    if (error) { console.error("send-receipt: couldn't save the invoice link:", error.message); return ""; }
    return linkUrl(base, row.token);
  };
  if (r.action === "link") {
    const { data: s } = await db.from("hangtag_sales").select("id").eq("id", r.saleId).maybeSingle();   // the caller's own bill
    if (!s) return reply(404, { ok: false, error: "not_found", message: "That bill isn't in the cloud yet. Try again once it has uploaded." });
    const link = await billLink(r.saleId);
    if (!link) return reply(503, { ok: false, error: "not_configured", message: "Invoice links aren't set up yet (RECEIPT_URL)." });
    return reply(200, { ok: true, url: link });
  }
  if (r.action === "refresh") {
    const { data: rows } = await db.from("hangtag_deliveries").select("id,channel,provider,provider_message_id,status").eq("sale_id", r.saleId).eq("status", "sent").limit(20);
    let updated = 0;
    for (const row of rows || []) {
      const cfg = providerConfig(row.channel, env());
      const st = providerStatus(row.provider, await fetchStatus(cfg, row, fetch));
      const now = new Date().toISOString();
      const patch = st === "delivered" ? { status: "delivered", delivered_at: now, checked_at: now } : st === "failed" ? { status: "failed", error: "The provider couldn't deliver it.", checked_at: now } : { checked_at: now };
      const { error } = await admin.from("hangtag_deliveries").update(patch).eq("owner_id", user.id).eq("id", row.id).eq("status", "sent");
      if (!error && st) updated++;
    }
    return reply(200, { ok: true, updated });
  }

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
  // sent by itself when the bill completed: once per bill and channel — a repeat gets the first attempt's answer
  if (r.auto) {
    const { data: prev } = await admin.from("hangtag_deliveries").select("status,recipient,provider,provider_message_id").eq("owner_id", user.id)
      .eq("sale_id", sale.id).eq("channel", r.channel).eq("mode", "auto").in("status", ["pending", "sent", "delivered"]).limit(1);
    const p = (prev || [])[0];
    if (p && p.status !== "pending") return reply(200, { ok: true, status: p.status, already: true, channel: r.channel, recipient: p.recipient, provider: p.provider, provider_message_id: p.provider_message_id });
    if (p) return reply(409, { ok: false, error: "busy", message: "This receipt is being sent already." });
  }
  const link = r.channel === "email" ? "" : await billLink(sale.id);
  const message = billMessage(r.channel, { sale, items: items.data || [], payments: payments.data || [], shop: profile.data || {}, customer, link,
    linkParam: String(Deno.env.get("WHATSAPP_LINK_PARAM") || "").toLowerCase() === "on" });

  // written by the function only (the app can read these rows, not write them). Take a place first, then count: if two
  // requests race, both see each other's row, so the limit can't be passed; if the log fails, nothing is sent.
  const held = await admin.from("hangtag_deliveries").insert(reservationRow({ ownerId: user.id, saleId: sale.id, channel: r.channel, to: to.to, provider: cfg.name, auto: r.auto })).select("id").single();
  if (held.error && r.auto && /duplicate|unique/i.test(held.error.message || "")) return reply(409, { ok: false, error: "busy", message: "This receipt is being sent already." });
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
