# delivery-status (Supabase Edge Function)

The messaging providers report here what happened to the bills and quotations `send-receipt` handed them. The bill then
shows **Delivered**, or **Failed** with the provider's reason, without anyone pressing Refresh. For WhatsApp through
Meta this is the only way to know: Meta's messages can't be looked up afterwards.

| Provider | Channel | How it reports | Signature checked with |
|---|---|---|---|
| Meta (WhatsApp Cloud API) | WhatsApp | App webhook, field `messages` (statuses `delivered`, `read`, `failed`) | `X-Hub-Signature-256` (HMAC-SHA256 of the body, `WHATSAPP_APP_SECRET`) |
| Twilio | SMS, WhatsApp | A status callback on each message (`delivered`, `read`, `undelivered`, `failed`) | `X-Twilio-Signature` (HMAC-SHA1 of the callback URL and fields, `TWILIO_AUTH_TOKEN`) |
| Resend | Email | Webhook events `email.delivered`, `email.bounced` | Svix headers (`svix-id`, `svix-timestamp`, `svix-signature`, `RESEND_WEBHOOK_SECRET`), 5-minute window |

- **Nothing is believed without the provider's signature.** A provider whose secret isn't set is refused (`503`). A bad
  signature gets `401` and changes nothing.
- **Only a message of ours changes.** The function finds the record in `hangtag_deliveries` by provider and the
  provider's message id. It changes the record only from `pending` or `sent`, so a delivered receipt never turns failed
  and a report that arrives twice changes nothing more. Reports about other messages (another integration on the same
  account) are acknowledged and left alone.
- Statuses with nothing to record (queued, sent, opened…) are acknowledged and ignored. If the database can't be
  written, the answer is `500` and the provider sends the report again.
- The logic is in `core.js` (pure, Web Crypto only; tested by `tests/unit/delivery-status.test.mjs`); `index.ts` reads
  the request and writes the record with the service role.

## Deploy

```bash
supabase functions deploy delivery-status --no-verify-jwt --project-ref <your-project-ref>
```

Deploy **without** JWT verification: the providers can't sign in. Their signatures are checked instead.

Run `supabase/schema.sql` section 3v (or `supabase/migrations/20261008120000_hangtag_delivery_reports.sql`): it adds
the index the function uses to find a message by the provider's id.

Secrets (`supabase secrets set NAME=value --project-ref <ref>`). Set only those of the providers you use:

| Secret | For |
|---|---|
| `DELIVERY_STATUS_URL` | `https://<project>.supabase.co/functions/v1/delivery-status`. One project secret, read by both functions: `send-receipt` gives it to Twilio with each message (`?provider=twilio` is added), and this function checks Twilio's signature against it. |
| `TWILIO_AUTH_TOKEN` | Twilio: the same token `send-receipt` uses. |
| `WHATSAPP_APP_SECRET` | Meta: the app's App Secret (Meta for Developers → the app → App settings → Basic). |
| `WHATSAPP_VERIFY_TOKEN` | Meta: any long random text you choose. Meta sends it back once, when the webhook is set up. |
| `RESEND_WEBHOOK_SECRET` | Resend: the endpoint's signing secret (`whsec_…`). |

Then tell each provider where to report:

- **Meta**: the app → WhatsApp → Configuration → Webhook.
  - Callback URL: `<DELIVERY_STATUS_URL>?provider=meta`
  - Verify token: the same `WHATSAPP_VERIFY_TOKEN`
  - Subscribe to the `messages` field.
- **Resend**: Webhooks → Add endpoint.
  - URL: `<DELIVERY_STATUS_URL>?provider=resend`
  - Events: `email.delivered` and `email.bounced`
  - Copy its signing secret into `RESEND_WEBHOOK_SECRET`.
- **Twilio**: nothing to set in the console. Each message names its own status callback once the
  `DELIVERY_STATUS_URL` secret is set.
