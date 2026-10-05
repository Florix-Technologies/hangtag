# Hangtag database (new foundation)

`migrations/` holds the database for the new Hangtag app. `tests/` checks it against a real Postgres.
The current app still uses the old `hangtag_*` tables from `../schema.sql`. The two sets of tables don't touch each other.

## Apply

Supabase → SQL Editor → New query → paste `migrations/20260925180000_phase1_foundation.sql` → Run.
You can also use `supabase db push` with the Supabase CLI. It is safe to run again.

**Commerce batch (the live `hangtag_*` tables).** `migrations/20261003120000_hangtag_commerce_batch.sql` is section 3r
of `schema.sql` (price lists, purchase orders, kits, e-invoice / e-way bill readiness, repack, gift vouchers, outbound
webhooks) with its row security. Run it on a database that already has `schema.sql` up to section 3q (or run the whole
`schema.sql` again, which includes it). Safe to run again. Webhooks also need the `webhook-dispatch` Edge Function
(`functions/webhook-dispatch/README.md`).

**Plans, subscriptions, promo codes and the access lock (Wave 12).** `migrations/20261006120000_hangtag_plans_subscriptions.sql`
is section 3t of `schema.sql`. Run it on a database that already has `schema.sql` up to section 3s (or run the whole
`schema.sql` again). Safe to run again; the migration report then shows rows 74–77 with `ok = true`.

- **Every shop already set up gets a 7-day free trial starting when this runs.** After it ends, the shop's app is locked
  (only Plans & Billing) and every business write of the app is refused with SQLSTATE `HT402`. Nothing is deleted.
- **Prices** live in `public.hangtag_plans` (placeholders: ₹499 / ₹1,349 / ₹2,499). Change one with
  `UPDATE public.hangtag_plans SET price = 599 WHERE code = 'm1';` — re-running the script never overwrites it. The trial
  length is the `days` of the plan `trial`.
- **Promo codes** (checked only by the database; the app can't read them):
  ```sql
  INSERT INTO public.hangtag_promo_codes (code, kind, value, plans, starts_at, ends_at, max_uses, per_account_limit)
  VALUES ('LAUNCH20', 'percent', 20, NULL, now(), now() + interval '30 days', 500, 1),   -- 20% off any plan
         ('SIX300', 'fixed', 300, '{m6}', NULL, NULL, NULL, 1);                          -- ₹300 off the 6-month plan
  UPDATE public.hangtag_promo_codes SET active = false WHERE code = 'LAUNCH20';          -- switch one off
  ```
  Uses are recorded in `hangtag_promo_redemptions` against the paid payment.
- **Give a shop paid time without a payment, or suspend it** (SQL Editor):
  ```sql
  SELECT public.hangtag_admin_grant((SELECT id FROM auth.users WHERE email = 'owner@shop.in'), 'm3', 'Launch offer');
  SELECT public.hangtag_admin_suspend((SELECT id FROM auth.users WHERE email = 'owner@shop.in'), true, 'Chargeback');
  SELECT public.hangtag_admin_suspend((SELECT id FROM auth.users WHERE email = 'owner@shop.in'), false, NULL);
  ```
- **Payments** need the Edge Functions `subscription` (JWT on) and `subscription-webhook` (`--no-verify-jwt`) with
  Hangtag's own Razorpay keys — see `functions/subscription/README.md`. Without them the app says online payment isn't
  set up (never a fake Pay button).
- **The Agent's rate limit** (`hangtag_agent_take`, per person and per shop, per minute and per day) is used by the `agent`
  Edge Function; limits are its secrets (`functions/agent/README.md`).

## Test

```
npm install
npm run test:db
```

## Model

| Table | What it holds |
|---|---|
| `shops`, `shop_members` | A shop and who can use it. Creating a shop makes you its owner. |
| `products` | Name, category, brand, description, image, default price and cost, GST rate, HSN, archived |
| `product_variants` | One per colour + size, with SKU, barcode, and optional price and cost overrides |
| `stock_movements` | The stock ledger. Stock = `sum(quantity)`. |
| `customers` | Name, mobile, email, GSTIN, type |
| `bills`, `bill_items` | Bills, with copies of product details, price and cost at the time of sale |
| `returns`, `return_items` | Returns and exchanges, each item linked to the bill line it returns |
| `bill_counters` | Running bill number per shop and financial year |

Views: `variant_catalog` (each variant with the price and cost that apply, and stock on hand) and `variant_stock`.

## Rules the database enforces

- A user only reaches rows of shops they are a member of. Signed-out visitors reach nothing.
- `shop_id` can be left out when the user has exactly one shop.
- SKU and barcode are unique within a shop. Colour + size is unique within a product.
- **Stock is never typed in as a number.**
  - The app adds `OPENING_STOCK`, `STOCK_IN` and `ADJUSTMENT` rows; an adjustment needs a `reason`.
  - The database adds `SALE` rows (bill item saved), `CANCEL` rows (bill cancelled) and `RETURN` rows (return item saved with `restock`).
  - Ledger rows can't be edited or deleted.
- **Bills are created with their items in one call** (`create_bill`).
  - The subtotal must equal the sum of `line_total`, and the GST must equal the sum of the item GST.
  - `total = taxable_amount + gst_amount + round_off`.
  - After saving, only `payment_method`, `payment_status`, `notes` and cancellation can change.
  - A cancelled bill can't be reopened, and a bill with returns can't be cancelled.
- **Bill numbers** are `PREFIX/26-27/0001`, one series per shop and Indian financial year (India time).
- **Returns** can never exceed the pieces sold on a line, and all returns of a bill together can't exceed the bill total.
- **Products** with stock or sales history can't be deleted. Archive them (`is_archived`).

## Writing bills and returns (from the app)

```js
// Bill: prices and GST are worked out by the app; the database checks they add up
await sb.rpc('create_bill', {
  p_bill: { id, customer_id, subtotal, discount_percent, discount_amount, taxable_amount, gst_amount,
            round_off, total, prices_include_gst: true, payment_method: 'upi', billed_at },
  p_items: [{ variant_id, quantity, unit_price, discount_amount, gst_rate, gst_amount }],
});
// unit_price and gst_rate may be left out (the variant's price and the product's rate are used).
// Product name, colour, size, SKU, HSN and cost are always copied by the database.
// Sending the same bill id again returns the saved bill (safe to retry).

// Return or exchange
await sb.rpc('create_return', {
  p_return: { id, bill_id, kind: 'return', refund_method: 'cash', reason },
  p_items: [{ bill_item_id, quantity, amount, restock: true }],
});
```
