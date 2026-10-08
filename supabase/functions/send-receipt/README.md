# send-receipt (Supabase Edge Function)

Sends a finished bill to its customer by **email, WhatsApp or SMS**, from the bill's **Send** buttons in the app, and
records every attempt in `hangtag_deliveries`.

- `index.ts`: HTTP wrapper (Deno). Needs a signed-in user. It reads the bill, its lines, payments and customer with that
  user's session, so row security decides what can be sent. It checks the bill isn't cancelled, writes the message,
  applies a limit of 60 messages an hour per shop, calls the provider and records the result.
- `core.js`: request checks, which providers are set up, who may send, who the bill goes to, the message (email,
  SMS, WhatsApp) and the delivery record. Unit-tested in Node: `tests/unit/send-receipt.test.mjs`.
- `providers/`: one file per provider; `providers/index.js` picks one.
  - `resend.js`: email (Resend).
  - `twilio.js`: SMS and WhatsApp (Twilio).
  - `meta-whatsapp.js`: WhatsApp Cloud API (Meta).

To use another provider, add a file with the same `(cfg, msg, fetch) → { ok, id } | { ok: false, status, message }`
shape and a case in `providers/index.js` and `core.js` `providerConfig`. The app doesn't change: it only talks to this
function.

## What the app sends and what the function decides

- The app sends only **the bill id and the channel**. The function writes the message itself (`core.js` `billMessage`)
  from the saved bill (`hangtag_sales`, `hangtag_sale_items`, `hangtag_payments`) and the shop profile, escaping every
  saved text: a request can't carry words, links or HTML of its own. Figures are the saved ones; nothing is
  recalculated. Shop and product names are still the account's own text, so only the accounts in `SEND_ALLOWED_USERS`
  may send (unset = sending is off).
- The **recipient always comes from the bill's customer as saved in Customers** (`hangtag_customers.email` /
  `phone`), never from the request or the copy kept on the bill. A bill without a saved customer, or a customer without
  an email or mobile, is refused (`422 missing_contact`).
- Each attempt first writes a `pending` row in `hangtag_deliveries`; the hourly limit counts those rows, so parallel
  requests can't slip past it, and if the log can't be written or counted nothing is sent (`503`). Deleting bills
  doesn't remove delivery records (their bill link is cleared).
- **"Sent" means the provider accepted the message and returned its id.** Anything else is recorded as `failed` with
  the provider's reason, and the app says it wasn't sent. `{ action: "refresh", sale_id }` asks Twilio (SMS) and
  Resend (email) what happened to the bill's sent messages and records `delivered` (or `failed` when the provider
  couldn't deliver it). Meta WhatsApp reports delivery only through webhooks: with the `delivery-status` function set
  up (its README), every provider reports by itself and the bill shows Delivered or why it failed without a refresh.
- **A refusal says whether trying again helps** (core.js `failureKind`, from the provider's own error code): the
  service busy, limited or down → `502 provider_error`, which the app's queue tries again; the customer's number or
  address can't receive it (not on WhatsApp, not a mobile, opted out, invalid) → `422 bad_recipient`; the shop's
  provider set-up (template, token, sender, domain) → `422 provider_setup`. The last two are final: the app says what
  to fix and never sends again by itself.
- **Emails carry the shop's logo** as Settings → Bills & Documents → Logo prints it (shown or not, left / centre /
  right): an inline picture (`cid:shop-logo`), since email apps block pictures written into the message. If Resend
  turns the picture down, the same email goes once more without it.
- **Automatic receipts** (`{ action: "send", ..., auto: true }`, sent by the phone when a bill completes and the shop
  turned the channel on): at most one per bill and channel. A unique index on the `auto` rows makes a retry (or a
  second phone) get the first attempt's answer (`already: true`) or `409 busy` while it is still being sent.
- **Quotations** (`{ action: "send", channel: "email" | "whatsapp", order_id, request_id }`): the function reads the
  quotation and its lines with the caller's session (a saved quotation of the shop, not cancelled), writes the message
  from it (headed QUOTATION, never a bill; the total the app saved with it) and sends it to the quotation's customer as
  saved in Customers. `request_id` is made by the phone for one press of Send and is used once per shop (a unique index
  on `hangtag_deliveries.request_id`): a retry or the phone's queue sending it again gets the first answer, never a
  second message. A team member needs `create_order`. WhatsApp needs a template of its own for quotations.
- **Secure invoice links**: with `RECEIPT_URL` set, SMS and WhatsApp messages carry `RECEIPT_URL#<token>`, an
  unguessable link (32 random bytes) to that one bill, kept 12 months in `hangtag_invoice_links` (the shop can revoke
  it from the bill). `{ action: "link", sale_id }` returns the bill's link for sharing by hand. The page
  (`receipt.html`) asks the `receipt` function for the bill; a wrong, revoked or expired token gets "not found".
  Without `RECEIPT_URL` the link uses the shop's own receipt page: the owner's app saves the address of its
  `receipt.html` in the shop's settings (`receiptUrl`, written only by the owner, only an https …/receipt.html address;
  the function checks it again), so invoice links work without this secret.
- **Team members** (schema.sql section 3i) send for their shop: the function asks the database for the shop
  (`hangtag_shop_id()` with the caller's session and the phone's `x-hangtag-device` key, which it forwards) and writes
  every row for that shop, never for the member's own account. The member needs `create_sale` (`hangtag_can`), and
  `SEND_ALLOWED_USERS` may name the member or, for the whole team, the shop's owner.
- A channel without its secrets answers `503 not_configured`. Nothing is recorded, and the app offers Download, Share or
  "Open WhatsApp" instead.

## Deploy

```bash
supabase functions deploy send-receipt --project-ref <your-project-ref>
```

Keep JWT verification on (the default). `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
provided to every Edge Function automatically. The service-role key is only used here, to write `hangtag_deliveries`,
which the app can read but not write.

Set the secrets of the channels you want (`supabase secrets set NAME=value --project-ref <ref>`):

| Channel | Secrets |
|---|---|
| Email (Resend) | `RESEND_API_KEY`, `EMAIL_FROM` (an address on a domain verified in Resend, e.g. `bills@yourshop.in`), optional `EMAIL_REPLY_TO` |
| SMS (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM` (a Twilio number or a Messaging Service SID `MG…`) |
| WhatsApp (Meta) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE` (an approved template whose body has `{{1}}` customer name, `{{2}}` shop, `{{3}}` bill number, `{{4}}` amount), optional `WHATSAPP_TEMPLATE_LANG` (default `en`), `WHATSAPP_API_VERSION` (default `v21.0`) |
| WhatsApp (Twilio) | `WHATSAPP_PROVIDER=twilio`, the Twilio secrets above, `TWILIO_WHATSAPP_FROM` (the WhatsApp sender, `+14155238886` or `whatsapp:+14155238886`), `TWILIO_WHATSAPP_CONTENT_SID` (an approved WhatsApp template in Twilio Content, variables `{{1}}`–`{{4}}` as above) |
| Who may send (**required**) | `SEND_ALLOWED_USERS`: the accounts allowed to send, as user ids or sign-in emails, comma-separated, or `*` for every signed-in account. **Unset = nobody sends.** Sign-up is open and the messages go out from your provider accounts, so list your shops' accounts rather than using `*` |

| Invoice links (optional) | `RECEIPT_URL`: the address of `receipt.html` on your site, e.g. `https://<you>.github.io/hangtag/receipt.html` (https, no query). Without it, the receipt page of the app the shop's owner uses (saved in the shop's settings) is used. With WhatsApp, `WHATSAPP_LINK_PARAM=on` when the approved template has a 5th value `{{5}}` for the link. |
| Delivery reports (optional) | `DELIVERY_STATUS_URL`: the address of the `delivery-status` function (`https://<project>.supabase.co/functions/v1/delivery-status`). Twilio messages then ask Twilio to report there. Meta and Resend are set up in their dashboards (see `delivery-status/README.md`). |
| Quotations by WhatsApp (optional) | `WHATSAPP_QUOTE_TEMPLATE` (Meta: an approved template with `{{1}}` customer, `{{2}}` shop, `{{3}}` quotation number, `{{4}}` amount, `{{5}}` valid until) or, with `WHATSAPP_PROVIDER=twilio`, `TWILIO_WHATSAPP_QUOTE_CONTENT_SID`. Quotations by email use the email secrets above. |

The invoice-link page needs the `receipt` function, deployed **without** JWT verification (it is called with the
project's publishable key and the token is its only key):

```bash
supabase functions deploy receipt --no-verify-jwt --project-ref <your-project-ref>
```

WhatsApp counts as set up only with its template: WhatsApp accepts free text a business starts but doesn't deliver
it, so the function never sends it. Without a WhatsApp provider the app opens WhatsApp on the device instead.

India: SMS to Indian numbers needs DLT registration (sender ID and template) with your SMS provider, and WhatsApp
messages a business starts need an approved template.
