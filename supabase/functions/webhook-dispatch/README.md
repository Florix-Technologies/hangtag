# webhook-dispatch

Sends a shop's outbound webhooks (Settings → Advanced → Integrations in the app). The database writes one event per
change it already sees (a bill, a payment, an order created or moved, a purchase received, a stock record, a new
customer) and one delivery per endpoint (`schema.sql` section 3r). This function sends the due deliveries, signs them,
and records each attempt; failed attempts are retried with back-off (1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h; 8
attempts at most).

## Request the receiver gets

```
POST <your address>
Content-Type: application/json
X-Hangtag-Event: sale.completed
X-Hangtag-Event-Id: 0b5c…            (the same on every retry: drop repeats)
X-Hangtag-Timestamp: 1790000000      (unix seconds)
X-Hangtag-Signature: sha256=<hex>    (HMAC-SHA256 of "<timestamp>.<raw body>" with the endpoint's secret)

{"id":"0b5c…","type":"sale.completed","created_at":"2026-10-03T10:00:00.000Z","data":{…}}
```

Check the signature with the secret shown once in the app (it starts with `whsec_`), and reject timestamps older than
5 minutes. `core.js` has `verifySignature(secret, timestamp, body, header)` as an example.

## Set up

1. Run `supabase/schema.sql` (or the migration `supabase/migrations/20261003120000_hangtag_commerce_batch.sql`).
2. `supabase secrets set WEBHOOK_DISPATCH_SECRET=<a long random string>`
3. `supabase functions deploy webhook-dispatch --no-verify-jwt`
4. Schedule it every minute (Supabase → Integrations → Cron), calling the function URL with
   `Authorization: Bearer <WEBHOOK_DISPATCH_SECRET>`.

Secrets never reach the app: the endpoint secrets are in `hangtag_webhook_secrets`, which only the service role reads.
Addresses that resolve to private, loopback or link-local networks are refused.
