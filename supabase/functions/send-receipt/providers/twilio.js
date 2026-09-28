// SMS and WhatsApp through Twilio (https://www.twilio.com). cfg: { accountSid, authToken, from, whatsapp?, contentSid? }
// msg: { to (+91…), text, params }. SMS sends the text; WhatsApp sends the approved template (cfg.contentSid) with the
// values {"1": …} from params, because WhatsApp doesn't deliver free text a business starts.
// Returns { ok: true, id } only when Twilio accepted the message and gave its SID.
export async function sendTwilioMessage(cfg, msg, fetchImpl) {
  const wa = (n) => (cfg.whatsapp ? "whatsapp:" + String(n).replace(/^whatsapp:/i, "") : n);
  const form = new URLSearchParams();
  form.set("To", wa(msg.to));
  if (/^MG[0-9a-f]{32}$/i.test(cfg.from)) form.set("MessagingServiceSid", cfg.from); else form.set("From", wa(cfg.from));
  if (cfg.whatsapp) {
    if (!cfg.contentSid) return { ok: false, status: 0, message: "No approved WhatsApp template is set up." };
    form.set("ContentSid", cfg.contentSid);
    form.set("ContentVariables", JSON.stringify(Object.fromEntries((msg.params || []).map((p, i) => [String(i + 1), String(p)]))));
  } else form.set("Body", msg.text);
  let res;
  try {
    res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${cfg.accountSid}:${cfg.authToken}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (e) {
    return { ok: false, status: 0, message: "The messaging service couldn't be reached." };
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok && json && json.sid && json.status !== "failed" && json.status !== "undelivered") return { ok: true, id: String(json.sid) };
  return { ok: false, status: res.status, message: (json && json.message) || `The messaging service answered ${res.status}.` };
}
