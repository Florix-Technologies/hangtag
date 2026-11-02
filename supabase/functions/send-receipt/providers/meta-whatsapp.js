// WhatsApp through Meta's WhatsApp Cloud API. cfg: { token, phoneNumberId, template, language, apiVersion, documentHeader? }
// msg: { to (+91…), params, document? { link, filename } }. Messages a shop starts must use an approved template
// (cfg.template, with body values {{1}}… filled from params): WhatsApp accepts free text a business starts but doesn't
// deliver it, so it is never sent. A template with a DOCUMENT header (cfg.documentHeader) carries the bill's invoice PDF:
// WhatsApp fetches it once from msg.document.link (a short-lived address of the one stored file) and sends it as a document.
// Returns { ok: true, id } only when WhatsApp accepted the message and gave its id.
export async function sendMetaWhatsApp(cfg, msg, fetchImpl) {
  if (!cfg.template) return { ok: false, status: 0, code: "no_template", message: "No approved WhatsApp template is set up." };
  // the template expects its document: without the invoice PDF it can't be sent (rather than a message WhatsApp refuses)
  if (cfg.documentHeader && !(msg.document && msg.document.link)) return { ok: false, status: 0, code: "no_document", message: "The WhatsApp template needs the bill's invoice PDF, which isn't ready." };
  const to = String(msg.to).replace(/^\+/, "");
  const components = [
    ...(cfg.documentHeader ? [{ type: "header", parameters: [{ type: "document", document: { link: msg.document.link, filename: msg.document.filename } }] }] : []),
    ...((msg.params || []).length ? [{ type: "body", parameters: msg.params.map((p) => ({ type: "text", text: p })) }] : []),
  ];
  const body = { messaging_product: "whatsapp", to, type: "template", template: { name: cfg.template, language: { code: cfg.language || "en" }, components } };
  let res;
  try {
    res = await fetchImpl(`https://graph.facebook.com/${cfg.apiVersion || "v21.0"}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, message: "WhatsApp couldn't be reached." };
  }
  const json = await res.json().catch(() => ({}));
  const id = json && Array.isArray(json.messages) && json.messages[0] && json.messages[0].id;
  if (res.ok && id) return { ok: true, id: String(id) };
  return { ok: false, status: res.status, code: json && json.error && json.error.code != null ? String(json.error.code) : "", message: (json && json.error && json.error.message) || `WhatsApp answered ${res.status}.` };
}
