// What a provider says now about one message it accepted: fetchStatus(cfg, row, fetch) → the provider's JSON, or null
// when it can't say (Meta WhatsApp reports delivery only through webhooks, so it isn't asked). core.js providerStatus
// turns the answer into "delivered" / "failed".
export async function fetchStatus(cfg, row, fetchImpl) {
  const id = encodeURIComponent(String(row.provider_message_id || ""));
  if (!id) return null;
  try {
    if (row.provider === "twilio" && cfg && cfg.accountSid) {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages/${id}.json`, {
        headers: { Authorization: "Basic " + btoa(`${cfg.accountSid}:${cfg.authToken}`) } });
      return res.ok ? await res.json() : null;
    }
    if (row.provider === "resend" && cfg && cfg.apiKey) {
      const res = await fetchImpl(`https://api.resend.com/emails/${id}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
      return res.ok ? await res.json() : null;
    }
  } catch {
    return null;
  }
  return null;
}
