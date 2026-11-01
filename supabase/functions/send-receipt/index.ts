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
// - "invoice": the bill's one invoice PDF (core.js, canonical invoice). The phone registers its copy once; the first copy
//   registered for a bill is kept for good (hangtag_invoices, unique per bill; the file in the private bucket). From then on
//   every channel uses that file: the email's one attachment, WhatsApp's document (or link), the SMS's download link.
//   A walk-in bill can go to a saved customer named in the request (customer_id): the bill and its invoice don't change.
// Deploy with JWT verification on (the default).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { planGate } from "../_shared/plan-gate.js";
import { CHANNEL_LABELS, INVOICE_BUCKET, INVOICE_COLUMNS, ITEM_COLUMNS, RETURN_COLUMNS, MAX_PER_HOUR, ORDER_COLUMNS, ORDER_ITEM_COLUMNS, PAYMENT_COLUMNS, PROFILE_COLUMNS, QUOTE_PERMISSION, SALE_COLUMNS, SEND_PERMISSION,
  allowedToSend, base64Of, billMessage, checkInvoicePdf, configuredChannels, emailLogo, failureAnswer, failureKind, deliveryOutcome, fromName, invoiceFileName, invoicePath, invoiceView, linkRow, linkUrl, liveLink,
  newToken, pdfFromBase64, providerConfig, providerStatus, quoteMessage, receiptBase, recipientFor, requestedReceiptBase, reservationRow, sha256Hex, validateRequest } from "./core.js";
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

  /* The bill's one invoice PDF, if it has one ({ row } | { row: null } | { error }: the table isn't there yet = none) */
  const currentInvoice = async (saleId: string) => {
    const { data, error } = await admin.from("hangtag_invoices").select(INVOICE_COLUMNS).eq("owner_id", shop).eq("sale_id", saleId).maybeSingle();
    if (error && /hangtag_invoices|42P01|does not exist|schema cache/i.test(`${error.code} ${error.message}`)) return { row: null, missing: true };
    return error ? { error } : { row: data };
  };
  /* A short-lived address of the stored file (the private bucket has no public access) */
  const invoiceUrl = async (row: { storage_path: string; number: string }, seconds: number) => {
    const { data, error } = await admin.storage.from(INVOICE_BUCKET).createSignedUrl(row.storage_path, seconds, { download: invoiceFileName(row.number) });
    if (error || !data) { console.error("send-receipt: couldn't sign the invoice address:", error && error.message); return ""; }
    return data.signedUrl as string;
  };
  if (r.action === "invoice") {
    const { data: s, error: sErr } = await db.from("hangtag_sales").select("id,bill_no,total,is_void").eq("id", r.saleId).maybeSingle();   // the caller's own bill
    if (sErr) { console.error("send-receipt: couldn't read the bill:", sErr.message); return unavailable(); }
    if (!s) return reply(404, { ok: false, error: "not_found", message: "That bill isn't in the cloud yet. Try again once it has uploaded." });
    if (s.is_void) return reply(409, { ok: false, error: "cancelled", message: "A cancelled bill has no invoice to send." });
    const cur = await currentInvoice(s.id);
    if (cur.missing) return reply(503, { ok: false, error: "not_configured", message: "Invoice PDFs aren't set up on the server yet." });
    if (cur.error) { console.error("send-receipt: couldn't read the invoice:", cur.error.message); return unavailable(); }
    if (cur.row) return reply(200, { ok: true, already: true, invoice: invoiceView(cur.row), url: await invoiceUrl(cur.row, 600) });
    if (!r.pdf) return reply(404, { ok: false, error: "no_invoice", message: "This bill has no invoice PDF yet." });
    const bytes = pdfFromBase64(r.pdf);
    if (!bytes) return reply(400, { ok: false, error: "bad_pdf", message: "That isn't an invoice PDF." });
    const chk = checkInvoicePdf(bytes, s);
    if (!chk.ok) return reply(chk.status, { ok: false, error: chk.error, message: chk.message });
    const sha = await sha256Hex(bytes), path = invoicePath(shop, sha);
    // the same file is stored once (its path is its hash): "already exists" is the same file
    const up = await admin.storage.from(INVOICE_BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false });
    if (up.error && !/exist|duplicate|409/i.test(`${up.error.message} ${(up.error as { statusCode?: string }).statusCode || ""}`)) { console.error("send-receipt: couldn't store the invoice:", up.error.message); return unavailable(); }
    const ins = await admin.from("hangtag_invoices").insert({ owner_id: shop, sale_id: s.id, number: String(s.bill_no), total: s.total, sha256: sha, size_bytes: bytes.length, storage_path: path, created_by: user.id })
      .select(INVOICE_COLUMNS).single();
    if (ins.error) {
      // another phone (or channel) registered the bill's invoice first: that one is the invoice; this copy's file goes
      const won = await currentInvoice(s.id);
      if (won.row) {
        if (won.row.storage_path !== path) await admin.storage.from(INVOICE_BUCKET).remove([path]);
        return reply(200, { ok: true, already: true, invoice: invoiceView(won.row), url: await invoiceUrl(won.row, 600) });
      }
      console.error("send-receipt: couldn't record the invoice:", ins.error.message); return unavailable();
    }
    return reply(200, { ok: true, invoice: invoiceView(ins.data), url: await invoiceUrl(ins.data, 600) });
  }

  /* Sends one message with its place in the delivery log: written by the function only (the app can read these rows,
     not write them). Take a place first, then count: if two requests race, both see each other's row, so the limit can't
     be passed; if the log fails, nothing is sent. A request id (one press of Send) is used once per shop. */
  const sendLogged = async (target: { saleId?: string; orderId?: string; requestId?: string; invoiceId?: string; format?: string; auto?: boolean }, to: { to: string }, cfg: { name: string }, message: Record<string, unknown>, shopName: string) => {
    const held = await admin.from("hangtag_deliveries").insert(reservationRow({ ownerId: shop, saleId: target.saleId, orderId: target.orderId, requestId: target.requestId, invoiceId: target.invoiceId, channel: r.channel, to: to.to, provider: cfg.name, auto: target.auto })).select("id").single();
    if (held.error && (target.auto || target.requestId) && /duplicate|unique/i.test(held.error.message || "")) return reply(409, { ok: false, error: "busy", message: target.orderId ? "This quotation is being sent already." : "This receipt is being sent already." });
    if (held.error || !held.data) { console.error("send-receipt: couldn't write the delivery log:", held.error && held.error.message); return unavailable(); }
    const heldId: string = held.data.id;
    const release = () => admin.from("hangtag_deliveries").delete().eq("owner_id", shop).eq("id", heldId);
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count, error: countErr } = await admin.from("hangtag_deliveries").select("id", { count: "exact", head: true }).eq("owner_id", shop).gte("created_at", since);
    if (countErr || count == null) { console.error("send-receipt: couldn't count recent messages:", countErr && countErr.message); await release(); return unavailable(); }
    if (count > MAX_PER_HOUR) { await release(); return reply(429, { ok: false, error: "rate_limited", message: "Too many messages in the last hour. Try again later." }); }

    // the provider's own guard against a repeat of this request (where it has one: Resend)
    const result = await deliver(cfg, r.channel, { to: to.to, fromName: fromName(shopName), ...message, idempotencyKey: `${shop}:${target.requestId || heldId}` }, fetch);
    const outcome = deliveryOutcome(result);
    const saved = await admin.from("hangtag_deliveries").update(outcome).eq("owner_id", shop).eq("id", heldId);
    if (saved.error) console.error("send-receipt: couldn't finish the delivery record:", saved.error.message);
    if (outcome.status === "sent") return reply(200, { ok: true, status: "sent", channel: r.channel, recipient: to.to, provider: cfg.name, provider_message_id: outcome.provider_message_id,
      ...(target.invoiceId ? { invoice_id: target.invoiceId } : {}), format: target.format || "text" });
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
  // this press of Send was handled already (a retry, the queue sending it again, a second tap): its answer, never a second message
  if (r.requestId) {
    const { data: prev } = await admin.from("hangtag_deliveries").select("status,channel,recipient,provider,provider_message_id,error,invoice_id").eq("owner_id", shop).eq("request_id", r.requestId).limit(1);
    const p0 = (prev || [])[0];
    if (p0 && p0.status === "pending") return reply(409, { ok: false, error: "busy", message: "This receipt is being sent already." });
    if (p0 && p0.status === "failed") return reply(502, { ok: false, status: "failed", already: true, error: "provider_error", message: `The ${CHANNEL_LABELS[p0.channel as "email"]} service didn't accept the message: ${p0.error || "not accepted"}` });
    if (p0) return reply(200, { ok: true, status: p0.status, already: true, channel: p0.channel, recipient: p0.recipient, provider: p0.provider, provider_message_id: p0.provider_message_id, ...(p0.invoice_id ? { invoice_id: p0.invoice_id } : {}) });
  }
  // the bill's customer; a walk-in bill may go to a saved customer named in the request (the bill itself doesn't change)
  if (r.customerId && sale.customer_id && r.customerId !== sale.customer_id) return reply(409, { ok: false, error: "has_customer", message: "This bill has its own customer: it goes to them." });
  const custId = sale.customer_id || r.customerId || null;
  const { data: customer, error: custErr } = custId
    ? await db.from("hangtag_customers").select("name,phone,email").eq("id", custId).maybeSingle()
    : { data: null, error: null };
  if (custErr) { console.error("send-receipt: couldn't read the customer:", custErr.message); return unavailable(); }
  if (custId && !customer && !sale.customer_id) return reply(404, { ok: false, error: "not_found", message: "That customer isn't in the cloud yet. Try again once their details have uploaded." });
  const to = recipientFor(r.channel, { customer, sale });
  if (!to.ok) return reply(to.status, { ok: false, error: to.error, message: to.message });
  const cfg = providerConfig(r.channel, env());
  if (!cfg) return reply(503, { ok: false, error: "not_configured", message: `Sending by ${CHANNEL_LABELS[r.channel]} isn't set up for this shop yet.` });
  // the bill's one invoice PDF: every channel uses that same file once it exists
  const cur = await currentInvoice(sale.id);
  if (cur.error) { console.error("send-receipt: couldn't read the invoice:", cur.error.message); return unavailable(); }
  const invoice = cur.row || null;
  if (!invoice && (cfg as { documentHeader?: boolean }).documentHeader) return reply(409, { ok: false, error: "no_invoice", message: "The bill's invoice PDF isn't ready yet. Try again in a moment." });

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
  // SMS can't carry a file: with the invoice PDF it carries the link to download it, so without a link it isn't sent
  if (invoice && r.channel === "sms" && !link) return reply(503, { ok: false, error: "not_configured", message: "Invoice links aren't set up yet, so the SMS can't carry the bill: open Settings once as the shop's owner (or set RECEIPT_URL on the server)." });
  // email: the stored PDF itself, as the one attachment; WhatsApp: the same file as a document (a template with a document
  // header) through a short-lived address WhatsApp fetches once
  let pdf: { base64: string; filename: string } | null = null, document: { link: string; filename: string } | null = null;
  if (invoice && r.channel === "email") {
    const file = await admin.storage.from(INVOICE_BUCKET).download(invoice.storage_path);
    if (file.error || !file.data) { console.error("send-receipt: couldn't read the invoice file:", file.error && file.error.message); return unavailable(); }
    pdf = { base64: base64Of(new Uint8Array(await file.data.arrayBuffer())), filename: invoiceFileName(invoice.number) };
  }
  if (invoice && r.channel === "whatsapp" && (cfg as { documentHeader?: boolean }).documentHeader) {
    const url = await invoiceUrl(invoice, 3600);
    if (!url) return unavailable();
    document = { link: url, filename: invoiceFileName(invoice.number) };
  }
  // an email without the PDF carries the shop's logo (as the shop prints it: Settings → Bills & Documents → Logo)
  const logoMeta = r.channel === "email" && !pdf ? (await admin.from("hangtag_meta").select("value").eq("owner_id", shop).eq("key", "logo").maybeSingle()).data : null;
  const message = billMessage(r.channel, { sale, items: items.data || [], payments: payments.data || [], returns: rets.data || [], shop: profile.data || {}, customer, region, link: link && link.url || "",
    linkParam: String(Deno.env.get("WHATSAPP_LINK_PARAM") || "").toLowerCase() === "on", pdf, document, pdfLink: !!invoice,
    logo: logoMeta ? emailLogo(logoMeta.value, regionRow && regionRow.value) : null });
  // what the customer gets: the PDF attached (email), the PDF as a document (WhatsApp), a link to the PDF, or the text only
  const format = pdf ? "attachment" : document ? "document" : invoice && link ? "pdf_link" : link ? "link" : "text";

  return await sendLogged({ saleId: sale.id, auto: r.auto, requestId: r.requestId, invoiceId: invoice ? invoice.id : undefined, format }, to, cfg, message, profile.data && profile.data.shop_name);
});
