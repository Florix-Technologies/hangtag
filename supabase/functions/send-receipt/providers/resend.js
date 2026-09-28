// Email through Resend (https://resend.com). cfg: { apiKey, from, replyTo } · msg: { to, subject, html, text, fromName }
// Returns { ok: true, id } only when Resend accepted the email and gave its id; otherwise { ok: false, status, message }.
export async function sendResendEmail(cfg, msg, fetchImpl) {
  const from = /<[^>]+>/.test(cfg.from) ? cfg.from : `${msg.fromName || "Hangtag"} <${cfg.from}>`;
  const body = { from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}), ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) };
  let res;
  try {
    res = await fetchImpl("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, status: 0, message: "The email service couldn't be reached." };
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok && json && json.id) return { ok: true, id: String(json.id) };
  return { ok: false, status: res.status, message: (json && (json.message || json.error)) || `The email service answered ${res.status}.` };
}
