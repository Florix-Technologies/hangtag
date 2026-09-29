// send-receipt: request checks, which providers are set up, who may send, who a bill goes to, the message itself and the
// delivery record. Plain ES module with no Deno or Node APIs, so the unit tests import it directly
// (tests/unit/send-receipt.test.mjs). The HTTP wrapper (index.ts) and the providers (providers/*.js) stay thin.
//
// The message is written HERE, from the bill's saved rows (hangtag_sales, hangtag_sale_items, hangtag_payments) and the
// shop profile, read with the caller's own session. The request only says which bill and which channel: it carries no
// words, links or HTML of its own, and every saved text is escaped. Those saved texts (shop and product names) are still
// the account's own, which is why only the accounts in SEND_ALLOWED_USERS may send at all (allowedToSend).

export const CHANNELS = ["email", "whatsapp", "sms"];
export const CHANNEL_LABELS = { email: "email", whatsapp: "WhatsApp", sms: "SMS" };
export const LIMITS = { saleId: 64, sms: 300, whatsapp: 4000, lines: 200 };
/* Messages one shop can send per hour (a runaway loop or a leaked session can't spam customers) */
export const MAX_PER_HOUR = 60;
/* What the function reads of a bill, its lines, its payments and the shop (with the caller's session) */
export const SALE_COLUMNS = "id,bill_no,timestamp,subtotal,discount,total,credit,tax_amount,tax_inclusive,gst_mode,cgst_amount,sgst_amount,igst_amount,round_off,payment_method,is_void,customer_id,customer_name";
export const ITEM_COLUMNS = "line_no,product_name,variant_label,color,size,quantity,unit_price,discount_amount";
export const PAYMENT_COLUMNS = "method,amount,reference,change_given,status";
export const PROFILE_COLUMNS = "shop_name,address,city,state,phone,gstin";

const fail = (status, error, message) => ({ ok: false, status, error, message });
const str = (v) => (typeof v === "string" ? v : "");

/* body: { action: "channels" } · { action: "send", channel, sale_id, auto? } · { action: "refresh" | "link", sale_id }.
   Anything else in the body is ignored. auto: sent by itself when the bill completed — at most once per bill and channel. */
export function validateRequest(body) {
  if (!body || typeof body !== "object") return fail(400, "bad_request", "Send the request as JSON.");
  if (body.action === "channels") return { ok: true, action: "channels" };
  if (body.action === "refresh" || body.action === "link") {
    const saleId = str(body.sale_id).trim();
    if (!saleId || saleId.length > LIMITS.saleId) return fail(400, "bad_request", "Which bill? The bill id is missing.");
    return { ok: true, action: body.action, saleId };
  }
  if (body.action !== "send") return fail(400, "bad_request", "Unknown action.");
  const channel = body.channel;
  if (!CHANNELS.includes(channel)) return fail(400, "bad_channel", "Choose email, WhatsApp or SMS.");
  const saleId = str(body.sale_id).trim();
  if (!saleId || saleId.length > LIMITS.saleId) return fail(400, "bad_request", "Which bill? The bill id is missing.");
  return { ok: true, action: "send", channel, saleId, auto: body.auto === true };
}

/* Which provider serves each channel, from the function's secrets (env: an object of strings). null = not set up.
   WhatsApp counts as set up only with an approved template: WhatsApp doesn't deliver free text a business starts. */
export function providerConfig(channel, env) {
  const e = (k) => str(env[k]).trim();
  const twilio = e("TWILIO_ACCOUNT_SID") && e("TWILIO_AUTH_TOKEN") ? { accountSid: e("TWILIO_ACCOUNT_SID"), authToken: e("TWILIO_AUTH_TOKEN") } : null;
  if (channel === "email") {
    const name = (e("EMAIL_PROVIDER") || "resend").toLowerCase();
    if (name === "resend" && e("RESEND_API_KEY") && e("EMAIL_FROM")) return { name, apiKey: e("RESEND_API_KEY"), from: e("EMAIL_FROM"), replyTo: e("EMAIL_REPLY_TO") };
    return null;
  }
  if (channel === "sms") {
    const name = (e("SMS_PROVIDER") || "twilio").toLowerCase();
    if (name === "twilio" && twilio && e("TWILIO_SMS_FROM")) return { name, ...twilio, from: e("TWILIO_SMS_FROM") };
    return null;
  }
  const name = (e("WHATSAPP_PROVIDER") || "meta").toLowerCase();
  if (name === "meta" && e("WHATSAPP_TOKEN") && e("WHATSAPP_PHONE_NUMBER_ID") && e("WHATSAPP_TEMPLATE"))
    return { name, token: e("WHATSAPP_TOKEN"), phoneNumberId: e("WHATSAPP_PHONE_NUMBER_ID"), template: e("WHATSAPP_TEMPLATE"), language: e("WHATSAPP_TEMPLATE_LANG") || "en", apiVersion: e("WHATSAPP_API_VERSION") || "v21.0" };
  if (name === "twilio" && twilio && e("TWILIO_WHATSAPP_FROM") && e("TWILIO_WHATSAPP_CONTENT_SID"))
    return { name, ...twilio, from: e("TWILIO_WHATSAPP_FROM"), contentSid: e("TWILIO_WHATSAPP_CONTENT_SID"), whatsapp: true };
  return null;
}
export const configuredChannels = (env) => Object.fromEntries(CHANNELS.map((c) => [c, !!providerConfig(c, env)]));

/* May this signed-in account send? Sign-up is open and the provider accounts are the operator's, so sending is off until
   SEND_ALLOWED_USERS names who may send: user ids or sign-in emails, comma-separated, or "*" for every signed-in account.
   A shop's team member sends for the shop: listing the shop's owner (owner: the owner's account, looked up by the
   function from the shop id the database gives) lets the whole team send. */
export function allowedToSend(user, env, owner = null) {
  const list = str(env.SEND_ALLOWED_USERS).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!user || !list.length) return false;
  const listed = (a) => !!a && (list.includes(String(a.id || "").toLowerCase()) || (!!a.email && list.includes(String(a.email).toLowerCase())));
  return list.includes("*") || listed(user) || listed(owner);
}
/* What a team member needs (hangtag_can) to send a bill or copy its link; the owner may always */
export const SEND_PERMISSION = "create_sale";

/* An Indian mobile number as +91XXXXXXXXXX, or "" (the same rule as the app: domain/invoices/delivery.js) */
export function mobileE164(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2); else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? "+91" + d : "";
}
export const isEmail = (v) => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(v) && v.length <= 200;

/* Who the bill goes to: always the bill's customer as saved in Customers (hangtag_customers), never an address from the
   request or a copy kept on the bill. → { to } or a failure (422 missing_contact) */
export function recipientFor(channel, { customer, sale }) {
  if (!sale || !customer) return fail(422, "missing_contact", "This bill has no saved customer. Add the customer in Customers to send it.");
  const name = str(customer.name).trim() || "This customer";
  if (channel === "email") {
    const e = str(customer.email).trim();
    return e && isEmail(e) ? { ok: true, to: e } : fail(422, "missing_contact", `${name} has no email address.`);
  }
  const m = mobileE164(customer.phone);
  return m ? { ok: true, to: m } : fail(422, "missing_contact", `${name} has no mobile number.`);
}
/* A shop name safe to show in an email's From line */
export const fromName = (shopName) => String(shopName || "Hangtag").replace(/["<>\r\n\\]/g, "").trim().slice(0, 60) || "Hangtag";

/* ---------- the message, from the bill's saved figures (nothing is recalculated) ---------- */
const num = (v) => (v == null || v === "" || isNaN(+v) ? 0 : +v);
const r2 = (n) => Math.round(n * 100) / 100;
export const rupees = (n) => { const v = r2(num(n)); return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const oneLine = (s) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
const PAY = { cash: "Cash", upi: "UPI", card: "Card" };
const billDate = (t) => { const d = new Date(num(t)); return isNaN(d) ? "" : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); };

/* The bill as shown in a message: { shop, contact, number, date, title, customer, lines, more, rows, paid, total } */
export function billView({ sale, items, payments, shop, customer }) {
  const s = sale || {}, p = shop || {}, incl = s.tax_inclusive !== false;
  const lines = (items || []).slice().sort((a, b) => num(a.line_no) - num(b.line_no)).map((i) => ({
    name: oneLine(i.product_name), detail: oneLine(i.variant_label || [i.color, i.size].filter((x) => x != null && x !== "").join(" / ")),
    qty: num(i.quantity), rate: num(i.unit_price), gross: r2(num(i.quantity) * num(i.unit_price)), discount: num(i.discount_amount),
  }));
  const gst = s.gst_mode
    ? [["IGST", s.igst_amount], ["CGST", s.cgst_amount], ["SGST", s.sgst_amount]].filter(([, a]) => num(a) > 0)
    : num(s.tax_amount) > 0 ? [["GST", s.tax_amount]] : [];
  const total = num(s.total), credit = num(s.credit), due = Math.max(0, r2(total - credit));
  const pays = (payments || []).filter((x) => x.status !== "cancelled" && num(x.amount) > 0)
    .map((x) => ({ label: PAY[x.method] || oneLine(x.method), amount: num(x.amount), ref: oneLine(x.reference), change: num(x.change_given) }));
  // bills from before split payments have no payment rows: the bill's one method paid what was due
  if (!pays.length && due > 0 && s.payment_method) pays.push({ label: PAY[s.payment_method] || oneLine(s.payment_method), amount: due, ref: "", change: 0 });
  const rows = [["Subtotal", rupees(s.subtotal)]];
  if (num(s.discount) > 0) rows.push(["Discount", "−" + rupees(s.discount)]);
  gst.forEach(([l, a]) => rows.push([l + (incl ? " (included)" : ""), rupees(a)]));
  if (num(s.round_off)) rows.push(["Round off", (num(s.round_off) > 0 ? "+" : "−") + rupees(Math.abs(num(s.round_off)))]);
  rows.push(["Total", rupees(total), true]);
  if (credit) { rows.push(["Exchange credit", "−" + rupees(credit)]); rows.push(["Amount paid", rupees(due), true]); }
  pays.forEach((x) => rows.push(["Paid by " + x.label + (x.ref ? " (ref " + x.ref + ")" : ""), rupees(x.amount)]));
  const change = r2(pays.reduce((a, x) => a + x.change, 0));
  if (change > 0) rows.push(["Change given", rupees(change)]);
  const paid = pays.length ? "paid by " + pays.map((x) => `${x.label} ${rupees(x.amount)}`).join(" + ")
    : credit ? "covered by your exchange credit" : "nothing to pay";
  return {
    shop: oneLine(p.shop_name) || "Our shop", contact: [[p.address, p.city, p.state].map(oneLine).filter(Boolean).join(", "), p.phone ? "Phone " + oneLine(p.phone) : "", p.gstin ? "GSTIN " + oneLine(p.gstin).toUpperCase() : ""].filter(Boolean),
    number: oneLine(s.bill_no || s.id), date: billDate(s.timestamp), title: gst.length ? "Tax invoice" : "Bill", customer: oneLine(customer && customer.name),
    lines: lines.slice(0, LIMITS.lines), more: Math.max(0, lines.length - LIMITS.lines), rows, paid, total: rupees(total),
  };
}
const lineText = (l) => `${l.name}${l.detail ? " (" + l.detail + ")" : ""} × ${l.qty} = ${rupees(l.gross)}${l.discount ? ` (discount −${rupees(l.discount)})` : ""}`;

/* The message for a channel: email { subject, html, text } · SMS { text } · WhatsApp { text, params } (template values
   {{1}} customer, {{2}} shop, {{3}} bill number, {{4}} amount) */
export function billMessage(channel, data) {
  const B = billView(data), more = B.more ? [`… and ${B.more} more items`] : [];
  const link = data && data.link ? String(data.link) : "";
  if (channel === "sms") {
    // one message where possible: the link is kept whole; the words before it are shortened when space is short
    const head = `${B.shop}: Bill ${B.number} for ${B.total}, ${B.paid}.`, tail = link ? ` Invoice: ${link}` : " Thank you for shopping with us!";
    const t = head + tail;
    return { text: t.length <= LIMITS.sms ? t : link ? head.slice(0, LIMITS.sms - tail.length - 1) + "…" + tail : t.slice(0, LIMITS.sms - 1) + "…" };
  }
  if (channel === "whatsapp") {
    const text = [`*${B.shop}*`, `${B.title} ${B.number} · ${B.date}`, "", ...B.lines.map(lineText), ...more, "", ...B.rows.map(([l, v, b]) => (b ? `*${l}: ${v}*` : `${l}: ${v}`)), ...(link ? ["", `Invoice: ${link}`] : [])].join("\n");
    // the approved template has {{1}}..{{4}}; a template with a 5th value for the link is used when WHATSAPP_LINK_PARAM=on
    const params = [B.customer || "Customer", B.shop, B.number, B.total, ...(link && data.linkParam ? [link] : [])];
    return { text: text.slice(0, LIMITS.whatsapp), params: params.map((x) => x.slice(0, 200)) };
  }
  const subject = `Your bill ${B.number} from ${B.shop} — ${B.total}`.slice(0, 200);
  const td = 'style="padding:6px 0;border-bottom:1px solid #eee;font-size:14px;color:#222"', tdr = 'style="padding:6px 0;border-bottom:1px solid #eee;font-size:14px;color:#222;text-align:right;white-space:nowrap"';
  const items = B.lines.map((l) => `<tr><td ${td}><b>${esc(l.name)}</b>${l.detail ? `<br><span style="color:#666;font-size:13px">${esc(l.detail)}</span>` : ""}${l.discount ? `<br><span style="color:#2e7d32;font-size:13px">Discount −${esc(rupees(l.discount))}</span>` : ""}</td><td ${tdr}>${l.qty} × ${esc(rupees(l.rate))}</td><td ${tdr}>${esc(rupees(l.gross))}</td></tr>`).join("")
    + (B.more ? `<tr><td ${td} colspan="3">… and ${B.more} more items</td></tr>` : "");
  const money = B.rows.map(([l, v, b]) => `<tr><td style="padding:3px 0;font-size:14px;color:#222${b ? ";font-weight:700" : ""}">${esc(l)}</td><td style="padding:3px 0;font-size:14px;color:#222;text-align:right${b ? ";font-weight:700" : ""}">${esc(v)}</td></tr>`).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f4f1;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:24px">
<tr><td style="font-size:20px;font-weight:700;color:#111">${esc(B.shop)}</td></tr>
${B.contact.length ? `<tr><td style="font-size:13px;color:#666;padding-top:2px">${B.contact.map(esc).join(" · ")}</td></tr>` : ""}
<tr><td style="padding-top:18px;font-size:15px;color:#222">${B.customer ? `Hello ${esc(B.customer)},<br>` : ""}Thank you for shopping with us. Here is your ${esc(B.title.toLowerCase())}.</td></tr>
<tr><td style="padding-top:14px;font-size:13px;color:#666">${esc(B.title)} <b style="color:#222">${esc(B.number)}</b> · ${esc(B.date)}</td></tr>
<tr><td style="padding-top:10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table></td></tr>
<tr><td style="padding-top:10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${money}</table></td></tr>
<tr><td style="padding-top:22px;font-size:11px;color:#999">Sent by ${esc(B.shop)} with Hangtag. Reply to this email to contact the shop.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [B.shop, ...B.contact, "", `${B.customer ? `Hello ${B.customer},\n` : ""}Thank you for shopping with us. Here is your ${B.title.toLowerCase()}.`, "",
    `${B.title} ${B.number} · ${B.date}`, "", ...B.lines.map(lineText), ...more, "", ...B.rows.map(([l, v]) => `${l}: ${v}`)].join("\n");
  return { subject, html, text };
}

/* ---------- the delivery record ----------
   A row is written as "pending" before the provider is called (it holds the attempt's place under the hourly limit),
   then finished as "sent" (only with the provider's message id) or "failed". */
export const reservationRow = ({ ownerId, saleId, channel, to, provider, auto }) =>
  ({ owner_id: ownerId, sale_id: saleId, channel, recipient: String(to).slice(0, 200), status: "pending", provider: provider || null, mode: auto ? "auto" : "manual" });
/* result: a provider's { ok, id, message } → the columns that finish the row */
export function deliveryOutcome(result) {
  const sent = !!(result && result.ok && result.id);
  return { status: sent ? "sent" : "failed", provider_message_id: sent ? String(result.id).slice(0, 200) : null,
    error: sent ? null : String((result && result.message) || "Not accepted").slice(0, 300) };
}
/* The finished row for one attempt */
export const deliveryRow = ({ result, ...r }) => ({ ...reservationRow(r), ...deliveryOutcome(result) });

/* ---------- secure invoice links ---------- */
export const LINK_DAYS = 366;
/* An unguessable token: 32 random bytes, base64url (43 characters) */
export function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/* The public page that shows one bill, from RECEIPT_URL (e.g. https://shop.example/receipt.html); the token goes after
   "#", so it never reaches a server log. "" when RECEIPT_URL isn't set (messages then go without a link). */
export function receiptBase(env) {
  const u = str(env.RECEIPT_URL).trim();
  return /^https:\/\/[^\s#?]+$/.test(u) ? u : "";
}
export const linkUrl = (base, token) => (base && token ? base + "#" + token : "");
export const linkRow = ({ ownerId, saleId, token, now = Date.now() }) =>
  ({ token, owner_id: ownerId, sale_id: saleId, expires_at: new Date(now + LINK_DAYS * 864e5).toISOString() });
/* A link that still works: not revoked, not expired */
export const liveLink = (row, now = Date.now()) => !!row && !row.revoked_at && Date.parse(row.expires_at) > now;

/* ---------- delivery status from the providers ---------- */
/* A provider's report on one message → "delivered" | "failed" | null (nothing new) */
export function providerStatus(provider, json) {
  if (!json || typeof json !== "object") return null;
  if (provider === "twilio") {
    const st = str(json.status);
    if (st === "delivered" || st === "read") return "delivered";
    if (st === "undelivered" || st === "failed") return "failed";
    return null;
  }
  if (provider === "resend") {
    const ev = str(json.last_event);
    if (ev === "delivered" || ev === "opened" || ev === "clicked") return "delivered";
    if (ev === "bounced") return "failed";
    return null;
  }
  return null;
}
