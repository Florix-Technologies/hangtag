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
// - A quotation (order_id instead of sale_id) goes by email or WhatsApp (its own approved template), written here from
//   the saved quotation; request_id (one press of Send on the phone) is used once, so a retry never sends it twice.
//   A team member needs create_order for it.
// - The invoice link's page is RECEIPT_URL, or (when that secret isn't set) the receipt page of the app the shop's owner
//   uses (Settings → receiptUrl, written by the owner's app; only an https …/receipt.html address is ever used).
// - A shop's team member sends for the shop: the shop is what the database says (hangtag_shop_id() with the caller's
//   session and device key, forwarded as x-hangtag-device), never the caller's own id; the member needs create_sale.
// Deploy with JWT verification on (the default).
import { createClient } from "npm:@supabase/supabase-js@2";
import { planGate } from "../_shared/plan-gate.js";
import { CHANNEL_LABELS, ITEM_COLUMNS, RETURN_COLUMNS, MAX_PER_HOUR, ORDER_COLUMNS, ORDER_ITEM_COLUMNS, PAYMENT_COLUMNS, PROFILE_COLUMNS, QUOTE_PERMISSION, SALE_COLUMNS, SEND_PERMISSION,
  allowedToSend, billMessage, configuredChannels, emailLogo, failureAnswer, failureKind, deliveryOutcome, fromName, linkRow, linkUrl, liveLink, newToken, providerConfig, providerStatus, quoteMessage,
  receiptBase, recipientFor, requestedReceiptBase, reservationRow, validateRequest } from "./core.js";
import { deliver } from "./providers/index.js";
import { fetchStatus } from "./providers/status.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
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
  // the caller's own session (and device key, for a team member): row security decides what it can read
  const device = req.headers.get("x-hangtag-device");
  const db = createClient(url, anon, { global: { headers: { Authorization: auth, ...(device ? { "x-hangtag-device": device } : {}) } }, auth: { persistSession: false } });
  const { data: who } = await db.auth.getUser();
  const user = who && who.user;
  if (!user) return reply(401, { ok: false, error: "unauthorized", message: "Sign in again." });

  let body: unknown;
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_request", message: "Send the request as JSON." }); }
  const r = validateRequest(body);
  if (!r.ok) return reply(r.status, { ok: false, error: r.error, message: r.message });
  // the shop this account works for, as the database sees it: an owner's own account, or a team member's shop (only
  // from an enrolled device). Every row written below belongs to the shop, never to the caller's own id.
  const { data: shopData, error: shopErr } = await db.rpc("hangtag_shop_id");
  if (shopErr && shopErr.code !== "PGRST202") { console.error("send-receipt: couldn't read the shop:", shopErr.message); return unavailable(); }
  const shopId: string | null = shopErr ? user.id : shopData;   // (PGRST202: a database without section 3i yet, where every account is its own shop)
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const owner = !shopId ? null : shopId === user.id ? user : ((await admin.auth.admin.getUserById(shopId)).data || { user: null }).user;
  const allowed = !!shopId && allowedToSend(user, env(), owner);
  if (r.action === "channels") return reply(200, { ok: true, channels: configuredChannels(allowed ? env() : {}) });
  if (!shopId) return reply(403, { ok: false, error: "forbidden", message: "This account isn't connected to a shop." });
  const shop: string = shopId;
  // the shop's Hangtag plan: a shop whose trial or plan has ended can't use this by calling it directly either
  const gate = await planGate(admin, shop);
  if (gate) return reply(gate.status, gate.body);
  // the shop's region (settings.region): receipts in its currency and time zone (India when not set)
  const { data: regionRow } = await admin.from("hangtag_meta").select("value").eq("owner_id", shopId).eq("key", "settings").maybeSingle();
  const region: string = regionRow && regionRow.value && typeof regionRow.value.region === "string" ? regionRow.value.region : "IN";
  const quote = r.action === "send" && !!r.orderId;
  if (shop !== user.id && r.action !== "refresh") {
    const { data: can } = await db.rpc("hangtag_can", { p: quote ? QUOTE_PERMISSION : SEND_PERMISSION });
    if (can !== true) return reply(403, { ok: false, error: "forbidden", message: quote ? "This account can't send quotations." : "This account can't send bills." });
  }

  // the page an invoice link opens: RECEIPT_URL, else the receipt page of the app the shop's owner uses (their settings)
  const linkBase = async () => {
    const fixed = receiptBase(env());
    if (fixed) return fixed;
    const { data: meta } = await admin.from("hangtag_meta").select("value").eq("owner_id", shop).eq("key", "settings").maybeSingle();
    const v = meta && meta.value && typeof meta.value === "object" ? (meta.value as { receiptUrl?: unknown }).receiptUrl : "";
    return requestedReceiptBase(typeof v === "string" ? v : "");
  };
  // the bill's secure link: reused while it works, otherwise a new one (written by this function only)
  const billLink = async (saleId: string) => {
    const base = await linkBase();
    if (!base) return null;
    const { data: rows } = await admin.from("hangtag_invoice_links").select("token,revoked_at,expires_at").eq("owner_id", shop).eq("sale_id", saleId)
      .is("revoked_at", null).order("created_at", { ascending: false }).limit(1);
    const cur = (rows || [])[0];
    if (cur && liveLink(cur) && Date.parse(cur.expires_at) - Date.now() > 30 * 864e5)
      return { url: linkUrl(base, cur.token), token: cur.token, expiresAt: cur.expires_at };
    const row = linkRow({ ownerId: shop, saleId, token: newToken() });
    const { error } = await admin.from("hangtag_invoice_links").insert(row);
    if (error) { console.error("send-receipt: couldn't save the invoice link:", error.message); return null; }
    return { url: linkUrl(base, row.token), token: row.token, expiresAt: row.expires_at };
  };
  if (r.action === "link") {
    const { data: s } = await db.from("hangtag_sales").select("id").eq("id", r.saleId).maybeSingle();   // the caller's own bill
    if (!s) return reply(404, { ok: false, error: "not_found", message: "That bill isn't in the cloud yet. Try again once it has uploaded." });
    const link = await billLink(r.saleId);
    if (!link) return reply(503, { ok: false, error: "not_configured", message: "Invoice links aren't set up yet: open Settings once as the shop's owner (or set RECEIPT_URL on the server)." });
    return reply(200, { ok: true, ...link });
  }
  if (!allowed) return reply(503, { ok: false, error: "not_configured", message: "Sending bills isn't turned on for this account." });
  if (r.action === "refresh") {
    const { data: rows } = await db.from("hangtag_deliveries").select("id,channel,provider,provider_message_id,status").eq("sale_id", r.saleId).eq("status", "sent").limit(20);
    let updated = 0;
    for (const row of rows || []) {
      const cfg = providerConfig(row.channel, env());
      const st = providerStatus(row.provider, await fetchStatus(cfg, row, fetch));
      const now = new Date().toISOString();
      const patch = st === "delivered" ? { status: "delivered", delivered_at: now, checked_at: now } : st === "failed" ? { status: "failed", error: "The provider couldn't deliver it.", checked_at: now } : { checked_at: now };
      const { error } = await admin.from("hangtag_deliveries").update(patch).eq("owner_id", shop).eq("id", row.id).eq("status", "sent");
      if (!error && st) updated++;
    }
    return reply(200, { ok: true, updated });
  }

  /* Sends one message with its place in the delivery log: written by the function only (the app can read these rows,
     not write them). Take a place first, then count: if two requests race, both see each other's row, so the limit can't
     be passed; if the log fails, nothing is sent. A request id (a quotation's press of Send) is used once per shop. */
  const sendLogged = async (target: { saleId?: string; orderId?: string; requestId?: string; auto?: boolean }, to: { to: string }, cfg: { name: string }, message: Record<string, unknown>, shopName: string) => {
    const held = await admin.from("hangtag_deliveries").insert(reservationRow({ ownerId: shop, saleId: target.saleId, orderId: target.orderId, requestId: target.requestId, channel: r.channel, to: to.to, provider: cfg.name, auto: target.auto })).select("id").single();
    if (held.error && (target.auto || target.requestId) && /duplicate|unique/i.test(held.error.message || "")) return reply(409, { ok: false, error: "busy", message: target.requestId ? "This quotation is being sent already." : "This receipt is being sent already." });
    if (held.error || !held.data) { console.error("send-receipt: couldn't write the delivery log:", held.error && held.error.message); return unavailable(); }
    const heldId: string = held.data.id;
    const release = () => admin.from("hangtag_deliveries").delete().eq("owner_id", shop).eq("id", heldId);
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count, error: countErr } = await admin.from("hangtag_deliveries").select("id", { count: "exact", head: true }).eq("owner_id", shop).gte("created_at", since);
    if (countErr || count == null) { console.error("send-receipt: couldn't count recent messages:", countErr && countErr.message); await release(); return unavailable(); }
    if (count > MAX_PER_HOUR) { await release(); return reply(429, { ok: false, error: "rate_limited", message: "Too many messages in the last hour. Try again later." }); }

    const result = await deliver(cfg, r.channel, { to: to.to, fromName: fromName(shopName), ...message }, fetch);
    const outcome = deliveryOutcome(result);
    const saved = await admin.from("hangtag_deliveries").update(outcome).eq("owner_id", shop).eq("id", heldId);
    if (saved.error) console.error("send-receipt: couldn't finish the delivery record:", saved.error.message);
    if (outcome.status === "sent") return reply(200, { ok: true, status: "sent", channel: r.channel, recipient: to.to, provider: cfg.name, provider_message_id: outcome.provider_message_id });
    // worth trying again (the service busy or down) or not (the customer's contact, the shop's set-up): the app retries only the first
    const kind = failureKind(cfg.name, result), answer = failureAnswer(r.channel, kind, outcome.error);
    console.error("send-receipt: provider refused:", cfg.name, result && result.status, result && result.code, kind);
    return reply(answer.status, answer.body);
  };

  if (r.orderId) {
    // the quotation and its customer, as this user may see them (row security): a saved quotation, not cancelled
    const { data: order, error: orderErr } = await db.from("hangtag_orders").select(ORDER_COLUMNS).eq("id", r.orderId).maybeSingle();
    if (orderErr) { console.error("send-receipt: couldn't read the quotation:", orderErr.message); return unavailable(); }
    if (!order || order.kind !== "quote") return reply(404, { ok: false, error: "not_found", message: "That quotation isn't in the cloud yet. Try again once it has uploaded." });
    if (order.status === "cancelled") return reply(409, { ok: false, error: "cancelled", message: "A cancelled quotation can't be sent." });
    // this press of Send was handled already (a retry, or the phone's queue sending it again): its answer, never a second message
    const { data: prev } = await admin.from("hangtag_deliveries").select("status,channel,recipient,provider,provider_message_id,error").eq("owner_id", shop).eq("request_id", r.requestId).limit(1);
    const p0 = (prev || [])[0];
    if (p0 && p0.status === "pending") return reply(409, { ok: false, error: "busy", message: "This quotation is being sent already." });
    if (p0 && p0.status === "failed") return reply(502, { ok: false, status: "failed", already: true, error: "provider_error", message: `The ${CHANNEL_LABELS[p0.channel as "email"]} service didn't accept the message: ${p0.error || "not accepted"}` });
    if (p0) return reply(200, { ok: true, status: p0.status, already: true, channel: p0.channel, recipient: p0.recipient, provider: p0.provider, provider_message_id: p0.provider_message_id });
    const { data: qc, error: qcErr } = order.customer_id
      ? await db.from("hangtag_customers").select("name,phone,email").eq("id", order.customer_id).maybeSingle()
      : { data: null, error: null };
    if (qcErr) { console.error("send-receipt: couldn't read the customer:", qcErr.message); return unavailable(); }
    const qto = recipientFor(r.channel, { customer: qc, sale: order, what: "quotation" });
    if (!qto.ok) return reply(qto.status, { ok: false, error: qto.error, message: qto.message });
    const qcfg = providerConfig(r.channel, env(), "quote");
    if (!qcfg) return reply(503, { ok: false, error: "not_configured", message: `Sending quotations by ${CHANNEL_LABELS[r.channel]} isn't set up for this shop yet.` });
    const [lines, qprofile] = await Promise.all([
      db.from("hangtag_order_items").select(ORDER_ITEM_COLUMNS).eq("order_id", order.id).order("line_no").limit(500),
      db.from("hangtag_profiles").select(PROFILE_COLUMNS).eq("id", shop).maybeSingle(),
    ]);
    if (lines.error || qprofile.error) { console.error("send-receipt: couldn't read the quotation:", (lines.error || qprofile.error)!.message); return unavailable(); }
    const qmsg = quoteMessage(r.channel, { order, items: lines.data || [], shop: qprofile.data || {}, customer: qc, region });
    return await sendLogged({ orderId: order.id, requestId: r.requestId }, qto, qcfg, qmsg, qprofile.data && qprofile.data.shop_name);
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
  const [items, payments, profile, rets] = await Promise.all([
    db.from("hangtag_sale_items").select(ITEM_COLUMNS).eq("sale_id", sale.id).order("line_no").limit(500),
    db.from("hangtag_payments").select(PAYMENT_COLUMNS).eq("sale_id", sale.id).order("id"),
    db.from("hangtag_profiles").select(PROFILE_COLUMNS).eq("id", shop).maybeSingle(),
    db.from("hangtag_returns").select(RETURN_COLUMNS).eq("sale_id", sale.id).limit(100),
  ]);
  if (items.error || payments.error || profile.error) { console.error("send-receipt: couldn't read the bill:", (items.error || payments.error || profile.error)!.message); return unavailable(); }
  // sent by itself when the bill completed: once per bill and channel — a repeat gets the first attempt's answer
  if (r.auto) {
    const { data: prev } = await admin.from("hangtag_deliveries").select("status,recipient,provider,provider_message_id").eq("owner_id", shop)
      .eq("sale_id", sale.id).eq("channel", r.channel).eq("mode", "auto").in("status", ["pending", "sent", "delivered"]).limit(1);
    const p = (prev || [])[0];
    if (p && p.status !== "pending") return reply(200, { ok: true, status: p.status, already: true, channel: r.channel, recipient: p.recipient, provider: p.provider, provider_message_id: p.provider_message_id });
    if (p) return reply(409, { ok: false, error: "busy", message: "This receipt is being sent already." });
  }
  const link = r.channel === "email" ? null : await billLink(sale.id);
  // an email carries the shop's logo (as the shop prints it: Settings → Bills & Documents → Logo)
  const logoMeta = r.channel === "email" ? (await admin.from("hangtag_meta").select("value").eq("owner_id", shop).eq("key", "logo").maybeSingle()).data : null;
  const message = billMessage(r.channel, { sale, items: items.data || [], payments: payments.data || [], returns: rets.data || [], shop: profile.data || {}, customer, region, link: link && link.url || "",
    linkParam: String(Deno.env.get("WHATSAPP_LINK_PARAM") || "").toLowerCase() === "on",
    logo: logoMeta ? emailLogo(logoMeta.value, regionRow && regionRow.value) : null });

  return await sendLogged({ saleId: sale.id, auto: r.auto }, to, cfg, message, profile.data && profile.data.shop_name);
});
