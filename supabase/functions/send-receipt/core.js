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
export const LIMITS = { saleId: 64, receiptUrl: 500, sms: 300, whatsapp: 4000, lines: 200, notes: 2000 };
/* Quotations go by email or WhatsApp (an SMS can't carry a quotation's lines) */
export const QUOTE_CHANNELS = ["email", "whatsapp"];
/* One press of Send on the phone: the id that makes a retry or a queued send go out only once */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/* Messages one shop can send per hour (a runaway loop or a leaked session can't spam customers) */
export const MAX_PER_HOUR = 60;
/* What the function reads of a bill, its lines, its payments and the shop (with the caller's session) */
export const SALE_COLUMNS = "id,bill_no,timestamp,subtotal,discount,item_discount,bill_discount,bill_discount_type,bill_discount_value,taxable_amount,total,credit,tax_rate,tax_amount,tax_inclusive,gst_mode,cgst_amount,sgst_amount,igst_amount,round_off,payment_method,due_amount,is_void,customer_id,customer_name";
export const ITEM_COLUMNS = "line_no,product_name,variant_label,color,size,quantity,unit_price,discount_amount,gst_rate,cgst_amount,sgst_amount,igst_amount,line_total";
export const PAYMENT_COLUMNS = "method,amount,reference,change_given,tendered,verification,card_last4,status";
/* A bill's returns (what came back and what was paid back), for the rows after the payments */
export const RETURN_COLUMNS = "value,refund_amount,kind";
export const PROFILE_COLUMNS = "shop_name,address,city,state,phone,gstin";

const fail = (status, error, message) => ({ ok: false, status, error, message });
const str = (v) => (typeof v === "string" ? v : "");

/* body: { action: "channels" } · { action: "send", channel, sale_id, auto? } · { action: "send", channel, order_id, request_id }
   (a quotation) · { action: "refresh" | "link", sale_id }. Anything else in the body is ignored. auto: sent by itself when
   the bill completed — at most once per bill and channel. */
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
  const orderId = str(body.order_id).trim();
  if (orderId) {
    if (orderId.length > LIMITS.saleId) return fail(400, "bad_request", "Which quotation? The quotation id is too long.");
    if (!QUOTE_CHANNELS.includes(channel)) return fail(400, "bad_channel", "Quotations go by email or WhatsApp.");
    const requestId = str(body.request_id).trim();
    if (!REQUEST_ID_RE.test(requestId)) return fail(400, "bad_request", "The send request has no id.");
    return { ok: true, action: "send", channel, orderId, requestId, auto: false };
  }
  const saleId = str(body.sale_id).trim();
  if (!saleId || saleId.length > LIMITS.saleId) return fail(400, "bad_request", "Which bill? The bill id is missing.");
  return { ok: true, action: "send", channel, saleId, auto: body.auto === true };
}

/* Which provider serves each channel, from the function's secrets (env: an object of strings). null = not set up.
   WhatsApp counts as set up only with an approved template: WhatsApp doesn't deliver free text a business starts.
   kind "quote": a quotation goes through its own approved WhatsApp template (WHATSAPP_QUOTE_TEMPLATE, or for Twilio
   TWILIO_WHATSAPP_QUOTE_CONTENT_SID): the bill's template would call it a bill. Email is the same for both. */
export function providerConfig(channel, env, kind = "bill") {
  if (kind === "quote") {
    if (!QUOTE_CHANNELS.includes(channel)) return null;
    if (channel === "whatsapp") {
      const q = { ...env, WHATSAPP_TEMPLATE: str(env.WHATSAPP_QUOTE_TEMPLATE), TWILIO_WHATSAPP_CONTENT_SID: str(env.TWILIO_WHATSAPP_QUOTE_CONTENT_SID) };
      return providerConfig(channel, q, "bill");
    }
  }
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
/* { email, whatsapp, sms } for bills, and quote_email / quote_whatsapp for quotations */
export const configuredChannels = (env) => ({ ...Object.fromEntries(CHANNELS.map((c) => [c, !!providerConfig(c, env)])),
  ...Object.fromEntries(QUOTE_CHANNELS.map((c) => ["quote_" + c, !!providerConfig(c, env, "quote")])) });

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
/* …and to send a quotation (whoever makes them) */
export const QUOTE_PERMISSION = "create_order";

/* An Indian mobile number as +91XXXXXXXXXX, or "" (the same rule as the app: domain/invoices/delivery.js) */
export function mobileE164(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2); else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? "+91" + d : "";
}
export const isEmail = (v) => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(v) && v.length <= 200;

/* Who the bill goes to: always the bill's customer as saved in Customers (hangtag_customers), never an address from the
   request or a copy kept on the bill. → { to } or a failure (422 missing_contact) */
export function recipientFor(channel, { customer, sale, what = "bill" }) {
  if (!sale || !customer) return fail(422, "missing_contact", `This ${what} has no saved customer. Add the customer in Customers to send it.`);
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
/* The shop's region (settings.region, as src/shared/formatting/regions.js): currency mark, number style and time zone */
export const MONEY_REGIONS = Object.freeze({ IN: ["₹", "en-IN", "Asia/Kolkata"], AE: ["AED ", "en-AE", "Asia/Dubai"], GB: ["£", "en-GB", "Europe/London"],
  IE: ["€", "en-IE", "Europe/Dublin"], US: ["$", "en-US", "America/New_York"], SG: ["S$", "en-SG", "Asia/Singapore"] });
const regionOf = (code) => MONEY_REGIONS[String(code || "").toUpperCase()] || MONEY_REGIONS.IN;
export const moneyFor = (code) => { const [mark, loc] = regionOf(code); return (n) => { const v = r2(num(n)); return mark + v.toLocaleString(loc, { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); }; };
export const rupees = moneyFor("IN");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const oneLine = (s) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
const PAY = { cash: "Cash", upi: "UPI", card: "Card", voucher: "Gift voucher" };
const dateFor = (code) => { const [, loc, timeZone] = regionOf(code); return (t) => { const d = new Date(num(t)); return isNaN(d) ? "" : d.toLocaleString(loc, { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); }; };;

/* The bill's money rows: [label, amount as written, bold]. The same words, signs and order as the app's one bill document
   (src/domain/documents/bill-content.js billContent + billRows: Subtotal, Item discounts, Bill discount, the taxable amount and
   GST — after the total, as "Includes …", when prices include it — Round off, Total, Exchange credit and Amount due, each
   payment with how it was paid, or what settled the bill, then the balance due, the change and returns), worked out from the
   columns the app saved: tests/unit/bill-content.test.mjs runs the same bills through both and they must agree. Bills saved
   before GST was split keep their one "GST" row. */
const pctText = (v) => Math.round(num(v) * 100) / 100 + "%";
function moneyRows({ s, items, pays, rets, rupees }) {
  const R = [], add = (label, amount, sign = "", bold = false) => R.push([label, (sign || "") + rupees(amount), bold]);
  const incl = s.tax_inclusive !== false, tax = num(s.tax_amount), total = num(s.total), credit = num(s.credit), due = Math.max(0, r2(total - credit));
  // bills saved before discounts were split (both 0, or missing) show their one discount as the bill discount
  const itemD = num(s.item_discount), billD = itemD || num(s.bill_discount) ? num(s.bill_discount) : r2(num(s.discount) - itemD);
  // GST: CGST + SGST or IGST, with the rate when the whole bill has one (the bill's lines, else its own rate)
  let gst = [];
  if (tax > 0) {
    if (!s.gst_mode || s.gst_mode === "none") gst = [["GST", tax]];
    else {
      const L = items || [], lineTax = L.length > 0 && L.every((i) => i.line_total != null);
      const rates = [...new Set(L.filter((i) => num(i.cgst_amount) + num(i.sgst_amount) + num(i.igst_amount) > 0).map((i) => num(i.gst_rate)))];
      const one = lineTax ? (rates.length === 1 && rates[0] ? rates[0] : num(s.tax_rate)) : num(s.tax_rate), rate = (f) => (one ? " " + pctText(one * f) : "");
      gst = s.gst_mode === "inter" ? [["IGST" + rate(1), s.igst_amount]] : [["CGST" + rate(0.5), s.cgst_amount], ["SGST" + rate(0.5), s.sgst_amount]];
    }
  }
  const taxable = s.taxable_amount != null ? num(s.taxable_amount) : r2(total - tax - num(s.round_off));
  add("Subtotal", s.subtotal);
  if (itemD > 0) add("Item discounts", itemD, "−");
  if (billD > 0) add("Bill discount" + (s.bill_discount_type === "percent" && num(s.bill_discount_value) > 0 ? " " + pctText(s.bill_discount_value) : ""), billD, "−");
  if (gst.length && !incl) { add("Taxable amount", taxable); gst.forEach(([l, a]) => add(l, a)); }
  if (num(s.round_off)) add("Round off", Math.abs(num(s.round_off)), num(s.round_off) > 0 ? "+" : "−");
  add("Total", total, "", true);
  if (gst.length && incl) { add("Taxable amount", taxable); gst.forEach(([l, a]) => add("Includes " + l, a)); }
  if (credit) { add("Exchange credit", credit, "−"); add("Amount due", due, "", true); }
  pays.forEach((x) => R.push(["Paid by " + x.label + (x.note ? " (" + x.note + ")" : ""), rupees(x.amount), false]));
  const paid = r2(pays.reduce((a, x) => a + x.amount, 0)), owed = Math.max(0, r2(due - paid)), change = r2(pays.reduce((a, x) => a + x.change, 0));
  if (!pays.length && !owed) R.push([credit ? "Covered by the exchange credit" : "Nothing to pay", "", false]);
  // part (or all) of the bill left on the customer's account: said plainly, never "paid" for the whole bill
  if (owed) add("Balance due (on account)", owed, "", true);
  if (change > 0) add("Change given", change);
  const back = r2((rets || []).reduce((a, x) => a + num(x.value), 0)), refunded = r2((rets || []).reduce((a, x) => a + num(x.refund_amount), 0));
  if (back) add("Returned items", back);
  if (refunded) add("Refunded", refunded);
  return { rows: R, owed };
}

/* The bill as shown in a message: { shop, contact, number, date, title, customer, lines, more, rows, paid, total } */
export function billView({ sale, items, payments, returns, shop, customer, region }) {
  const rupees = moneyFor(region), billDate = dateFor(region);
  const s = sale || {}, p = shop || {};
  const lines = (items || []).slice().sort((a, b) => num(a.line_no) - num(b.line_no)).map((i) => ({
    name: oneLine(i.product_name), detail: oneLine(i.variant_label || [i.color, i.size].filter((x) => x != null && x !== "").join(" / ")),
    qty: num(i.quantity), rate: num(i.unit_price), gross: r2(num(i.quantity) * num(i.unit_price)), discount: num(i.discount_amount),
  }));
  const total = num(s.total), credit = num(s.credit), due = Math.max(0, r2(total - credit));
  // each payment, with how it was paid: cash received and change, the reference, the card's last digits, verified or not
  const pays = (payments || []).filter((x) => x.status !== "cancelled" && num(x.amount) > 0).map((x) => {
    const amount = num(x.amount), change = num(x.change_given), received = x.tendered == null ? r2(amount + change) : num(x.tendered);
    const note = [x.method === "cash" && change ? `received ${rupees(received)} · change ${rupees(change)}` : x.reference ? "ref " + oneLine(x.reference) : "",
      x.card_last4 ? "card ••" + oneLine(x.card_last4) : "", x.verification === "verified" ? "verified" : x.verification === "unverified" ? "unverified" : ""].filter(Boolean).join(" · ");
    return { label: PAY[x.method] || oneLine(x.method), amount, change, note };
  });
  // bills from before split payments have no payment rows: the bill's one method paid what was due (less what is on account)
  const onAcct = num(s.due_amount) > 0 ? r2(num(s.due_amount)) : 0;
  if (!pays.length && r2(due - onAcct) > 0 && s.payment_method && s.payment_method !== "due") pays.push({ label: PAY[s.payment_method] || oneLine(s.payment_method), amount: r2(due - onAcct), change: 0, note: "" });
  const { rows, owed } = moneyRows({ s, items, pays, rets: returns, rupees });
  const paid = (pays.length ? "paid by " + pays.map((x) => `${x.label} ${rupees(x.amount)}`).join(" + ")
    : credit ? "covered by your exchange credit" : owed ? "" : "nothing to pay") + (owed ? (pays.length ? ", " : "") + rupees(owed) + " on your account" : "");
  return {
    shop: oneLine(p.shop_name) || "Our shop", contact: [[p.address, p.city, p.state].map(oneLine).filter(Boolean).join(", "), p.phone ? "Phone " + oneLine(p.phone) : "", p.gstin ? "GSTIN " + oneLine(p.gstin).toUpperCase() : ""].filter(Boolean),
    number: oneLine(s.bill_no || s.id), date: billDate(s.timestamp), title: num(s.tax_amount) > 0 ? "Tax Invoice" : "Bill", customer: oneLine(customer && customer.name),
    lines: lines.slice(0, LIMITS.lines), more: Math.max(0, lines.length - LIMITS.lines), rows, paid, total: rupees(total),
  };
}
const lineText = (l) => `${l.name}${l.detail ? " (" + l.detail + ")" : ""} × ${l.qty} = ${rupees(l.gross)}${l.discount ? ` (discount −${rupees(l.discount)})` : ""}`;

/* The message for a channel: email { subject, html, text } · SMS { text } · WhatsApp { text, params } (template values
   {{1}} customer, {{2}} shop, {{3}} bill number, {{4}} amount) */
export function billMessage(channel, data) {
  const rupees = moneyFor(data && data.region);
  const B = billView(data), more = B.more ? [`… and ${B.more} more items`] : [];
  const link = data && data.link ? String(data.link) : "";
  if (channel === "sms") {
    // one message where possible: the link is kept whole; the words before it are shortened when space is short
    const head = `${B.shop}: Bill ${B.number} for ${B.total}, ${B.paid}.`, tail = link ? ` Invoice: ${link}` : " Thank you for shopping with us!";
    const t = head + tail;
    return { text: t.length <= LIMITS.sms ? t : link ? head.slice(0, LIMITS.sms - tail.length - 1) + "…" + tail : t.slice(0, LIMITS.sms - 1) + "…" };
  }
  if (channel === "whatsapp") {
    const text = [`*${B.shop}*`, `${B.title} ${B.number} · ${B.date}`, "", ...B.lines.map(lineText), ...more, "", ...B.rows.map(([l, v, b]) => (v ? (b ? `*${l}: ${v}*` : `${l}: ${v}`) : l)), ...(link ? ["", `Invoice: ${link}`] : [])].join("\n");
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
    `${B.title} ${B.number} · ${B.date}`, "", ...B.lines.map(lineText), ...more, "", ...B.rows.map(([l, v]) => (v ? `${l}: ${v}` : l))].join("\n");
  return { subject, html, text };
}

/* ---------- a quotation (sent before anything is sold: never an invoice) ---------- */
/* What the function reads of a quotation and its lines (with the caller's session) */
export const ORDER_COLUMNS = "id,kind,no,status,customer_id,customer,notes,terms,valid_until,total,t";
export const ORDER_ITEM_COLUMNS = "line_no,name,variant_label,unit,qty,price,disc";
const UNIT_SYM = { pcs: "", box: " box", pack: " pack", dozen: " dozen", kg: " kg", g: " g", l: " L", ml: " ml", m: " m" };
const day = (v) => { const s = str(v).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ""; const d = new Date(s + "T12:00:00Z"); return isNaN(d) ? "" : d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }); };
const discText = (d) => { if (!d || typeof d !== "object" || !(num(d.value) > 0)) return ""; return d.type === "fixed" ? "−" + rupees(d.value) : "−" + num(d.value) + "%"; };
/* The quotation as shown in a message: { shop, contact, number, date, validUntil, customer, lines, more, total, notes, terms } */
export function quoteView({ order, items, shop, customer, region }) {
  const rupees = moneyFor(region), billDate = dateFor(region);
  const o = order || {}, p = shop || {};
  const lines = (items || []).slice().sort((a, b) => num(a.line_no) - num(b.line_no)).map((i) => ({
    name: oneLine(i.name), detail: oneLine(i.variant_label), qty: num(i.qty), unit: UNIT_SYM[i.unit] || "", rate: num(i.price), discount: discText(i.disc) }));
  const cust = (customer && customer.name) || (o.customer && typeof o.customer === "object" && o.customer.name) || "";
  return {
    shop: oneLine(p.shop_name) || "Our shop", contact: [[p.address, p.city, p.state].map(oneLine).filter(Boolean).join(", "), p.phone ? "Phone " + oneLine(p.phone) : "", p.gstin ? "GSTIN " + oneLine(p.gstin).toUpperCase() : ""].filter(Boolean),
    number: oneLine(o.no || o.id), date: billDate(o.t), validUntil: day(o.valid_until), customer: oneLine(cust),
    lines: lines.slice(0, LIMITS.lines), more: Math.max(0, lines.length - LIMITS.lines), total: o.total == null ? "" : rupees(o.total),
    notes: String(o.notes || "").slice(0, LIMITS.notes), terms: String(o.terms || "").slice(0, LIMITS.notes),
  };
}
const quoteLine = (l) => `${l.name}${l.detail ? " (" + l.detail + ")" : ""} × ${l.qty}${l.unit} @ ${rupees(l.rate)}${l.discount ? ` (discount ${l.discount})` : ""}`;
/* The message for a quotation: email { subject, html, text } · WhatsApp { text, params } (the quotation template's values
   {{1}} customer, {{2}} shop, {{3}} quotation number, {{4}} amount, {{5}} valid until). Headed QUOTATION, never a bill. */
export function quoteMessage(channel, data) {
  const rupees = moneyFor(data && data.region);
  const Q = quoteView(data), more = Q.more ? [`… and ${Q.more} more items`] : [];
  const validity = Q.validUntil ? `Valid until ${Q.validUntil}` : "";
  if (channel === "whatsapp") {
    const text = [`*${Q.shop}*`, `QUOTATION ${Q.number} · ${Q.date}`, validity, "", ...Q.lines.map(quoteLine), ...more, "", ...(Q.total ? [`*Total: ${Q.total}*`] : []),
      ...(Q.notes ? ["", Q.notes] : []), ...(Q.terms ? ["", "Terms: " + Q.terms] : [])].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
    const params = [Q.customer || "Customer", Q.shop, Q.number, Q.total || "-", Q.validUntil || "-"];
    return { text: text.slice(0, LIMITS.whatsapp), params: params.map((x) => x.slice(0, 200)) };
  }
  const subject = `Quotation ${Q.number} from ${Q.shop}${Q.total ? " — " + Q.total : ""}`.slice(0, 200);
  const td = 'style="padding:6px 0;border-bottom:1px solid #eee;font-size:14px;color:#222"', tdr = 'style="padding:6px 0;border-bottom:1px solid #eee;font-size:14px;color:#222;text-align:right;white-space:nowrap"';
  const items = Q.lines.map((l) => `<tr><td ${td}><b>${esc(l.name)}</b>${l.detail ? `<br><span style="color:#666;font-size:13px">${esc(l.detail)}</span>` : ""}</td><td ${tdr}>${l.qty}${esc(l.unit)} × ${esc(rupees(l.rate))}</td><td ${tdr}>${esc(l.discount || "")}</td></tr>`).join("")
    + (Q.more ? `<tr><td ${td} colspan="3">… and ${Q.more} more items</td></tr>` : "");
  const block = (label, t) => t ? `<tr><td style="padding-top:14px;font-size:13px;color:#222"><b>${esc(label)}</b><br>${esc(t).replace(/\r?\n/g, "<br>")}</td></tr>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f5f4f1;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;padding:24px">
<tr><td style="font-size:20px;font-weight:700;color:#111">${esc(Q.shop)}</td></tr>
${Q.contact.length ? `<tr><td style="font-size:13px;color:#666;padding-top:2px">${Q.contact.map(esc).join(" · ")}</td></tr>` : ""}
<tr><td style="padding-top:18px;font-size:22px;font-weight:700;letter-spacing:2px;color:#111">QUOTATION</td></tr>
<tr><td style="padding-top:4px;font-size:13px;color:#666">No. <b style="color:#222">${esc(Q.number)}</b> · ${esc(Q.date)}${validity ? " · " + esc(validity) : ""}</td></tr>
<tr><td style="padding-top:14px;font-size:15px;color:#222">${Q.customer ? `Hello ${esc(Q.customer)},<br>` : ""}Here is our quotation. Prices are as quoted; nothing has been billed.</td></tr>
<tr><td style="padding-top:10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table></td></tr>
${Q.total ? `<tr><td style="padding-top:10px;font-size:16px;font-weight:700;color:#111;text-align:right">Total ${esc(Q.total)}</td></tr>` : ""}
${block("Notes", Q.notes)}${block("Terms & conditions", Q.terms)}
<tr><td style="padding-top:22px;font-size:11px;color:#999">This is a quotation, not a bill. Sent by ${esc(Q.shop)} with Hangtag. Reply to this email to contact the shop.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [Q.shop, ...Q.contact, "", `QUOTATION ${Q.number} · ${Q.date}`, validity, "", `${Q.customer ? `Hello ${Q.customer},\n` : ""}Here is our quotation. Prices are as quoted; nothing has been billed.`, "",
    ...Q.lines.map(quoteLine), ...more, ...(Q.total ? ["", `Total: ${Q.total}`] : []), ...(Q.notes ? ["", "Notes: " + Q.notes] : []), ...(Q.terms ? ["", "Terms & conditions: " + Q.terms] : []),
    "", "This is a quotation, not a bill."].join("\n");
  return { subject, html, text };
}

/* ---------- the delivery record ----------
   A row is written as "pending" before the provider is called (it holds the attempt's place under the hourly limit),
   then finished as "sent" (only with the provider's message id) or "failed". */
export const reservationRow = ({ ownerId, saleId, orderId, requestId, channel, to, provider, auto }) =>
  ({ owner_id: ownerId, sale_id: saleId || null, channel, recipient: String(to).slice(0, 200), status: "pending", provider: provider || null, mode: auto ? "auto" : "manual",
    ...(orderId ? { order_id: orderId } : {}), ...(requestId ? { request_id: requestId } : {}) });
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
/* The public receipt page configured on the server. Production must use HTTPS; loopback HTTP is allowed for local testing.
   It must name receipt.html and carry no credentials, query or fragment. */
export function requestedReceiptBase(value) {
  const raw = str(value).trim();
  if (!raw || raw.length > LIMITS.receiptUrl) return "";
  try {
    const u = new URL(raw);
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) || u.username || u.password || u.search || u.hash || !/\/receipt\.html$/.test(u.pathname)) return "";
    return u.href;
  } catch { return ""; }
}
/* Only the deployment's fixed RECEIPT_URL is trusted. The token goes after "#", so it never reaches the static host or its logs. */
export function receiptBase(env) {
  return requestedReceiptBase(env && env.RECEIPT_URL);
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
