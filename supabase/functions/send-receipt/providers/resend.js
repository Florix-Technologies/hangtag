// Email through Resend (https://resend.com). cfg: { apiKey, from, replyTo } · msg: { to, subject, html, text, fromName }
// Returns { ok: true, id } only when Resend accepted the email and gave its id; otherwise { ok: false, status, message }.
// A message carrying the shop's logo (msg.attachments: the picture inline, cid) goes with it; if the service turns the
// picture down (400 / 422), the same email goes once more without it (msg.plainHtml) — the receipt matters more than the logo.
export async function sendResendEmail(cfg, msg, fetchImpl) {
  const r = await post(cfg, msg, fetchImpl);
  if (!r.ok && msg.attachments && msg.plainHtml && (r.status === 400 || r.status === 422)) return post(cfg, { ...msg, html: msg.plainHtml, attachments: null }, fetchImpl);
  return r;
}
async function post(cfg, msg, fetchImpl) {
  const from = /<[^>]+>/.test(cfg.from) ? cfg.from : `${msg.fromName || "Hangtag"} <${cfg.from}>`;
  const body = { from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}), ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    ...(Array.isArray(msg.attachments) && msg.attachments.length ? { attachments: msg.attachments } : {}) };
  let res;
  try {
    res = await fetchImpl("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, status: 0, message: "The email service couldn't be reached." };
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok && json && json.id) return { ok: true, id: String(json.id) };
  return { ok: false, status: res.status, code: json && json.name ? String(json.name) : "", message: (json && (json.message || json.error)) || `The email service answered ${res.status}.` };
}
