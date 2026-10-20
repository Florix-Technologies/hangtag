# Hangtag controlled pilot: checklist

For the owner running the pilot with the client's shop (or a few shops the owner names). The pilot runs on what
Production serves today (`262dbdb`, build `hangtag-1601181284`) and the live database as it is: contained, not yet
repaired (RELEASE.md §2a). **Online payment, AutoPay and bill reading stay off throughout**: no provider secret, no
`subscription` / `subscription-webhook` deploy, AutoPay not switched on (RELEASE.md §6e). Nothing uncommitted in the
repository is needed for the pilot.

## Before it starts (the owner)
- [ ] RELEASE.md §6c steps 1–5: the console account; Free trial set to **30 days**; the trial audit; only the shops
      you approve extended (Customers → Extend, or `supabase/operations/2026-10-18-trial-corrections.sql` with their
      account IDs: an empty list changes nothing).
- [ ] RELEASE.md §6a checks 1–4 on Production with your own accounts: the build, Refresh, Diagnostics, and a second
      account of your own sees none of your shop.
- [ ] Plans & Billing says online payment isn't available. Leave it so.
- [ ] Tell the client: one device at a time for returns of the same bill until the repair is done (the fix for two
      returns at the same moment is in the post-repair migration, not yet live).

## The pilot, area by area
The client works in their own shop; the owner checks with them. "Proven here" names the automated tests that already
run each flow locally (Chrome against the real `schema.sql` on PGlite, row security on); they can't replace the
client's real devices, network and sign-in.

| Area | Do | Expect | Proven here |
|---|---|---|---|
| Sign-in | Sign in (Google or email) on a computer and a phone; sign out and in again | The same shop each time; no other account's data on that device | e2e `signin-tabs`, `google-signin`, `accounts-isolation`, `session-refresh` |
| Shop isolation | Owner only, with a second account of their own (a second shop) — never the client's | The second shop sees none of the client's products, bills or customers | e2e `accounts-isolation`, `open-policies-incident`; database `tenant-rpc-isolation`, `team-tenancy` |
| Product import | Products → Import: the template, filled; mistakes shown by row; import | Products, variants and opening stock as in the file; the same file again adds nothing twice | e2e `product-import`, `purchases-import-count` |
| Stock changes | A stock count adjustment; a product sold by the kg, if the shop has one | Stock moves by exactly what was counted or sold; history shows why | e2e `purchases-import-count`, `units-weighing`, `serial-batch-expiry`; database `stock-guards`, `tracking` |
| Purchase bills | A supplier purchase entered by hand (bill reading is off: "Upload bill" offers entry by hand) | Stock in; what the supplier is owed; the same invoice number flagged | e2e `purchases-import-count`, `bill-import`; database `purchases`, `supplier-bills` |
| Sales | Bills as the shop works (cash or UPI received as the shop records it today) | Bill numbers in order; totals and GST as printed; stock down | e2e `sell-pos`, `checkout-flow`, `bills`, `payments-cash-gst`, `units-weighing` |
| Returns | A return from a bill, back on the shelf or not; an exchange | Refund and stock as chosen; never more back than bought | e2e `returns-after-sales`, `serial-batch-expiry`; database `returns-events` |
| Offline sync | A sale with the phone's network off, then on; the computer refreshes | The sale reaches the cloud once; the other device shows it after a refresh (note how long: RELEASE.md §6a check 5) | e2e `offline-queue-sw`, `sync-scenarios`, `sync-catch-up`, `cloud-roundtrip`, `team-devices` |
| Trial expiry and extension | Plans & Billing; near the end, the owner's Extend in the console | "N days remaining — Trial ends on …": 30 days after setup, or the end the owner gave; after Extend (audited) the new end when the app is reopened, or at once with "Check again" on the lock screen; at the end, the lock screen and nothing else | e2e `subscription`, `platform-console`; database `subscriptions`, `plans-autopay-platform`, `owner-operations` |

## Stop and call the owner if
- another shop's product, bill or customer appears anywhere;
- a bill, return or stock change made on one device is missing on the other a minute after both are online and refreshed;
- the lock screen appears before the trial end Plans & Billing showed;
- Diagnostics keeps adding "connection failed" lines.

Then download the Diagnostics report (Settings → Advanced → Diagnostics & health) and send it with the time it happened.

## Only the owner or the client can check
Real sign-in on Production; the client's own devices and network; how long a second device takes to catch up after its
network returns (the tests refuse the realtime socket, so this is the first real evidence: RELEASE.md §6a check 5);
the client's trial end; the client's daily work.

## After the pilot, before anyone pays
The seven gates of RELEASE.md §6e, each with its evidence: a backup, an isolated restore and rehearsal, the repair and
then the post-repair migration (each approved), Cashfree's sandbox and a test project, the signed-in checks and trial
corrections, and one real low-value payment with reconciliation after it.
