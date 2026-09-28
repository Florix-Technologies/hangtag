// One entry for every provider: deliver(cfg, channel, msg, fetch) → { ok: true, id } | { ok: false, status, message }.
// cfg comes from core.js providerConfig; adding a provider means a new file here and a case below.
import { sendResendEmail } from "./resend.js";
import { sendTwilioMessage } from "./twilio.js";
import { sendMetaWhatsApp } from "./meta-whatsapp.js";

export function deliver(cfg, channel, msg, fetchImpl) {
  if (channel === "email" && cfg.name === "resend") return sendResendEmail(cfg, msg, fetchImpl);
  if ((channel === "sms" || channel === "whatsapp") && cfg.name === "twilio") return sendTwilioMessage(cfg, msg, fetchImpl);
  if (channel === "whatsapp" && cfg.name === "meta") return sendMetaWhatsApp(cfg, msg, fetchImpl);
  return Promise.resolve({ ok: false, status: 0, message: `No ${channel} provider called ${cfg.name}.` });
}
