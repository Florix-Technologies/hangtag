# Hangtag launch readiness (2026-10-22)

For the owner. What each requirement really has, what proves it, what is left and when it is needed. Statuses:
**COMPLETE** (built, and its whole flow tested) · **PARTIAL** (built in part, or not proven end to end) · **NOT
IMPLEMENTED** · **BLOCKED** (needs infrastructure, keys or a live step) · **NEEDS DECISION** (the owner's call first).
"Release 1.0" is what the pilot and the paid launch need; "Later" is the roadmap (PLAN.md Parts B and C). Nothing of
Hangtag 2.0 (Sentinel, Business Operator, Product Memory) is in the code or in this scope.

Production serves `7e77c74` (build `hangtag-db09103bf2`, since 2026-10-22). This session's work (AUDIT 198–214) is in the
working tree, tested, not committed: it reaches Production only through a commit, a Preview and a promotion.

## 1. The changes asked for now

| Requirement | Status | What there is | Proven by |
|---|---|---|---|
| A. POS variant picker: responsive, 1 to 90+ variants, no sideways scroll, legible, right lines in the cart | **COMPLETE** | Sizes wrap into as many columns as fit; the sheet is as wide as its sizes need; one scroll between a fixed header and footer; long size names smaller on two lines; the place in a long list kept; phone: colours as chips | `tests/e2e/variant-picker-layout` (97 checks at 1600, 1280, 768 and 375 px with 1, 6, 30, 96 and 40 variants; the previous picker fails 23 of them), `pos-variants`, `sell-pos`, `responsive-matrix` |
| B. Import: the template and its columns | **COMPLETE** | Unchanged template (Excel and CSV), the same headers | `product-import` (unit and e2e) |
| B. Import: header found reliably, required fields checked | **COMPLETE** | Column names found below a title or notes (first 15 rows), and said so; name and selling price required | unit `product-import` (+7 checks), the pilot client's own files (below) |
| B. Import: preview in List and Grid, search, All / Ready / Needs fixing / Left out, 50 per page | **COMPLETE** | One line per row, or one card per product; search by name, codes, colours, sizes, row | `tests/e2e/product-import-preview` (27 checks, a 230-row file) |
| B. Import: row errors with how to fix them | **COMPLETE** | Each problem in the file's own words; the file back with a Problems column | `product-import` |
| B. Import: colours, sizes, units, variants | **COMPLETE** | Option columns, the shop's own fields, units with decimals | `product-import`, `product-import-fields`, `custom-fields` |
| B. Import: existing products and SKUs never duplicated; new product vs existing told apart | **COMPLETE** | A product the shop has is refused or left out on request (never changed); each row says new product, new variant of one, a variant the shop has, or a new colour or size of it | `product-import-preview`, unit `product-import` |
| B. Import: updating existing products, adding variants to them from a file | **NOT IMPLEMENTED** (Later) | Planned as PLAN I5–I11 and I9 (export with IDs, matching, an update plan, stale checks) | — |
| B. Import: never overwrite stock; an unknown quantity is never 0 | **COMPLETE** for new products | An empty stock cell is "not given" (—), announced, and makes no stock record; existing stock is never touched. "Set stock to" from a file (I17) is planned | `product-import-preview` (the database holds stock only for given quantities) |
| B. Import: results match what is saved | **COMPLETE** | Checked again at Import; all or nothing | `product-import-preview` (156 products, 227 variants, opening stock exactly as counted) |
| C. "Connect a payment gateway" in Settings, optional for every shop | **COMPLETE** (the section; 2026-10-23: connecting the shop's own account) | Three ways side by side: cash and the card machine; the shop's own UPI QR (configure, test with a no-amount QR, change, remove with a warning); a gateway: "not switched on for your shop yet", or, where the server allows it, the shop connects its own Razorpay test keys in a form of their own, sees test mode, the masked key and the webhook address, and can disconnect | `tests/e2e/payment-settings` (16), `tests/e2e/shop-payments` (21) |
| C. Not forced at sign-up | **COMPLETE** | Sign-up and setup never ask for payments | `business-capabilities`, `getting-started` |
| C. A gateway account of the shop's own (merchant onboarding) | **COMPLETE in code and tests (mocked provider); BLOCKED for real use** — Razorpay sandbox not run, the model to be confirmed with Razorpay (RELEASE §6e), the migration and deploy are the owner's (§6f) | Each shop connects its own Razorpay keys (checked with Razorpay, sealed with AES-256-GCM, unreadable by any app account); every intent names the shop's own account; each account has its own webhook address and secret. The shared Hangtag account is removed from the code. Test keys only until `PAYMENT_LIVE_MODE=on`. Cashfree for shops: not built | `supabase/tests/shop-payments-gateway` (61), `shop-payments` (48), `tests/e2e/shop-payments` (21) |
| C. Never paid from a screenshot, a claim or a redirect; webhooks authenticated, idempotent, reconciled | **COMPLETE** in design and tests (plan billing, and shop payments with a mocked provider); **BLOCKED** for real providers (no sandbox run) | UPI to the shop's own QR is "Unverified" until the shop confirms it (Reconciliation → Received: owner or a role that sees the books; a phone can't set it); verified only from the provider's own record; webhooks only with the account's own signature, once per event; refunds once, their outcome kept | `shop-payments-gateway`, `shop-payments`, `subscription-handlers`, `subscription-reconcile`, `payments-delivery-cash`, `checkout-payments` |
| C. Hangtag's plan billing separate from shops' payments | **COMPLETE** | Separate functions, tables and settings (Plans & Billing) | — |
| C. Live payments off until the gates pass | **COMPLETE** | Off today; shop gateways test-keys-only until `PAYMENT_LIVE_MODE=on` (the owner's approval) | RELEASE §6e, §6f |
| D. Public marketing website | **NOT IMPLEMENTED** · NEEDS DECISION | Where it lives, its words, the industries, the assisted-onboarding channel; no prices | — |
| D. No public pricing | **COMPLETE** | Prices only inside the app, to a signed-in owner | — |
| D. Sign-up → 30-day trial → private shop | **COMPLETE** in code and tests; the 30 days is the console's Free trial setting (RELEASE §6c step 3, the owner's) | The sign-up screen now says the trial starts once the shop is set up; `<app>/#signup` opens on Create account | `subscription`, `accounts-isolation`, `getting-started` |
| D. Guided setup; products; the first bill | **COMPLETE** | Setup (shop name, type, contact); Home's new "Getting started" (products, first bill, payments, receipt), ticked from the shop's own records | `business-capabilities`, `getting-started` (12 checks) |
| D. Assisted onboarding | **NOT IMPLEMENTED** · NEEDS DECISION | The console can extend trials and give plans; no way for a visitor to ask for help | — |
| D. Trial-ending messages | **PARTIAL** | Home's banner (days left), the lock screen; no email or WhatsApp reminder | `subscription` |
| D. Trial controls and promotions only for authorised staff | **COMPLETE** | Platform Console roles, every action audited | `platform-console`, `owner-operations` |
| D. `hangtag.florixtechnologies.com` | **BLOCKED** · NEEDS DECISION | No DNS record (the company's DNS is at Hostinger); steps in RELEASE §6e | — |
| E. Settings: simple, role-limited, shop vs platform apart | **COMPLETE** (audited) | Sections by permission; the console is separate (`/platform/`); four messages that named server internals now say "contact Hangtag support" | `business-capabilities`, `signin-tabs` |
| E. Thermal and A4 receipts kept; no silent-print promise | **COMPLETE** | Epson ePOS on the network prints directly; other printers through the browser's print dialog; nothing claims otherwise | `billing-output`, `documents-branding` |

## 2. The retail requirements

| Requirement | Status | Proven by | Release |
|---|---|---|---|
| Catalogue, variants, units, SKU and barcodes (GS1, camera scan) | **COMPLETE** | `pos-variants`, `product-options`, `units-weighing`, `gs1-barcodes`, `camera-scan` | 1.0 |
| Bulk import (new products) | **COMPLETE**; updates from a file **NOT IMPLEMENTED** | above | 1.0; updates Later |
| Stock adjustments and counts | **COMPLETE** | `purchases-import-count`, `stock-guards` | 1.0 |
| Stock history | **PARTIAL**: history by kind; a stock card per variant with a running balance (PLAN T1) planned | `purchases` | Later |
| Low-stock alerts | **COMPLETE** | `home`, `business-today` | 1.0 |
| Serial numbers, batches and expiry | **COMPLETE** (the tracked-record rule on every path is in the post-repair migration, not live) | `serial-batch-expiry`, `tracking` | 1.0 |
| Fast checkout, multi-variant cart, discounts | **COMPLETE** | `sell-pos`, `checkout-flow`, `payments-cash-gst`, `variant-picker-layout` | 1.0 |
| Returns and exchanges | **COMPLETE**; two returns of one line at the same moment: the fix is in the post-repair migration (not live), its proof **BLOCKED** (no PostgreSQL here) | `returns-after-sales`, `post-repair-integrity` | 1.0 |
| Bill numbers safe across devices | **COMPLETE** (each device its own series) | `units-weighing`, `units-numbers` | 1.0 |
| Customers, dues and credit, sales reports | **COMPLETE** | `customers`, `credit-orders`, `reports-options`, `business-today` | 1.0 |
| Quotations and sales orders into bills | **COMPLETE** | `quotations`, `credit-orders` | 1.0 |
| Purchase orders, suppliers, purchase entry | **COMPLETE**; reading a supplier's bill needs the Anthropic key (off) | `purchases-import-count`, `bill-import` | 1.0 |
| GST reports; GSTR-1 export | **PARTIAL**: the GST reports and a GSTR-1 dataset (B2B, B2CL, B2CS, CDNR, CDNUR, nil, HSN, documents) for checking — not validated against the GSTN schema or offline tool, and marked as prepared by Hangtag | `payments-cash-gst`, `payments-delivery-cash` | Needs the official schema check before it is called upload-ready |
| Thermal and A4 receipts | **COMPLETE** | `billing-output` | 1.0 |
| Offline, sync recovery, several devices | **COMPLETE** in tests; real realtime reconnect timing is the owner's check (RELEASE §6a) | `offline-queue-sw`, `sync-scenarios`, `sync-catch-up`, `team-devices` | 1.0 |
| Roles and shop isolation | **COMPLETE** in code and tests; the live database is contained but **not repaired** | `team-devices`, `accounts-isolation`, `tenant-rpc-isolation` | 1.0 (the repair before paid launch) |
| Backup, restore, audit, recovery | **PARTIAL**: in-app backup and restore, the console's audit log, the repair runbook and rehearsal; a backup of live (the owner's own dump, 2026-10-25), proven restorable on one computer into plain PostgreSQL and a simulated new Supabase project (`supabase/RESTORE-RUNBOOK.md`); **NOT done**: a recovery drill on a real new project | `sync-backup-events`, `restore-rehearsal`, `restore-checks` | Before the repair |
| Weighing | **COMPLETE** for typed weights and the scale's reading; a real scale model not tried | `units-weighing` | 1.0 |
| Restaurant: tables, QR ordering, kitchen queue | **COMPLETE** | `restaurant` | 1.0 (for restaurants) |
| Event mode | **COMPLETE** | `sync-backup-events` | 1.0 |
| Services and repair jobs (PLAN Part C) | **NOT IMPLEMENTED** | — | Later |
| Public online store and order status link (Wave 12) | **COMPLETE** in tests | `store`, `unified-commerce` | 1.0 (optional per shop) |
| Bank accounts, cash book and day close; reconciliation of hand-checked UPI | **COMPLETE** | `payments-cash-gst`, unit `payments-delivery-cash` | 1.0 |
| Receipts sent by WhatsApp, SMS or email, invoice links | **COMPLETE** in code and tests (providers stood in); **BLOCKED** live: the sending providers and `send-receipt`'s settings are the owner's | `receipt-delivery`, `receipt-link`, `billing-output` | 1.0 when set up |
| Reading a supplier's bill (AI) | **COMPLETE** in code (provider stood in); **BLOCKED** live: the Anthropic key (`npm run eval:extract-bill` never run) | `bill-import`, eval plumbing | Optional |
| Hangtag Agent, automation centre, smart reorder | **COMPLETE** for the shop's own data and rules (local); the Agent's model calls need the key | `agent-app`, `automation`, `automation-center` | 1.0 (assistive) |
| Platform Console (staff roles, customers, plans, promotions, billing review) | **COMPLETE** in tests; Suspend and Restore on live wait for the repair (or the optional permissions SQL) | `platform-console`, `console-billing-review` | 1.0 |
| Hangtag 2.0: Sentinel, Business Operator, Product Memory | **Reserved for 2.0**: none of it is in the code, and nothing here builds toward it | — | 2.0 |

## 3. The pilot client's own import files (checked locally, nothing written anywhere)
- The latest files read cleanly. Two had a title and notes above the column names: now found (row 5), and said so.
- 89 rows of the "All Columns Filled" and "Prices Updated" files were refused only because each row had its own
  description ("Grey socks, size Small"): with "Keep each product's first description", 0 to fix.
- "Import Fixed" / "Master Stock" / "Updated Stock": 60 rows have no stock quantity ("left blank until confirmed") —
  now shown as not given and announced, never 0; 4 rows have no selling price (still refused: it is required).
- The stock tracker workbook is not in the template's columns (Colour, Size, Current Stock): it still needs the template.
- These files are the shop's data: they stay out of the repository; the tests use a file shaped like them.

## 4. What is left, in order
1. **Protect the live data** (RELEASE §6e gates 1–4): a backup, an isolated restore and rehearsal, the repair, then the
   post-repair migration — each the owner's step. Then the concurrent-returns proof on a disposable PostgreSQL.
2. **The pilot** on Production as it is (PILOT-CHECKLIST.md), payments off. The improvements of sessions 17 and 18
   (picker, import, payment settings, Getting started; shop payments, UPI confirmation, honest card wording) reach it
   only after the owner's review, a commit, a Preview check (§6a) and a promotion.
3. **Shop payments** (2026-10-23, built and tested with a scripted Razorpay; RELEASE §6f), in this order:
   1. ask Razorpay which model it expects of a platform: the shop's own keys, as built, or its partner OAuth;
   2. after the repair, the shop payments migration;
   3. a test project, with the README's sandbox steps on the owner's own Razorpay test account;
   4. named pilot shops on test keys;
   5. live keys only on approval.
   Cashfree for shops is not built: decide first whether it is wanted.
4. **Plan payments** (gates 5 and 7): Cashfree's sandbox and a test project, then one real low-value payment.
5. **Imports that update** (PLAN I5–I11, I9, I17), deferred by the payment-first decision: change prices and details of
   products the shop has, add sizes and colours, set counted stock — each previewed, nothing silent.
6. **The public website and domain**, assisted onboarding, trial-ending reminders (decisions first).
7. **GSTR-1**: check the export against the GSTN schema with an accountant before calling it upload-ready.
8. Later: the stock card (T1), source codes (T2), unit conversions and packs (I21–I26), services and jobs (Part C).

## 5. How this was verified (2026-10-23, the final tree: AUDIT 215–226)
| Kind | Result | What it proves |
|---|---|---|
| Unit tests (Node) | 89 files, 2,841 checks, all passed | The rules in the code |
| Database tests (PGlite, the real `schema.sql`, the post-repair and shop payments migrations) | 40 files, 1,870 checks, all passed | The database code, on a copy built from the repository; the shop payment functions' logic on it, with a **scripted** Razorpay |
| The same database tests on PostgreSQL 17 (local) | 40 files, 1,870 checks, all passed | The same on a real PostgreSQL server |
| Browser tests (Chrome, the app from this computer, PGlite behind a stand-in, network-isolated) | 63 files, 2,229 checks, all passed; 0 requests left this computer | The screens and flows end to end, on local data (shop payments through the real function logic and a scripted Razorpay) |
| Eval checks (no model calls) | 4 files, 122 checks, all passed | The Agent's and bill reading's plumbing |
| `npm run check`, `lint`, `build` | exit 0 | The build is complete and clean |
| Payment providers' sandboxes (Razorpay for shops, Cashfree for plans), a deployed test project | **Not run** (no keys, no project) | — |
| The live project: its database, a signed-in check on Production | **Not run** (the owner's; not authorised here) | — |

None of this shows the live database is safe: it is contained, not repaired, and its only backup is the owner's own dump
of 2026-10-25 (proven on one computer, never recovered into a real project: `supabase/RESTORE-RUNBOOK.md`).

## 6. Verdicts
- **Controlled pilot: GO, with the conditions in PILOT-CHECKLIST.md** — payments off, named shops, returns of one bill
  from one device at a time, §6c and §6a done first. Strongly advised before it starts: turn on the platform's daily
  backups (the live data has none but the owner's own dump of 2026-10-25).
- **Paid commercial launch: NO-GO** — none of the seven gates has its evidence, there is no public website or domain, and
  shop payments, though built, have run only against a scripted Razorpay: the account model must be confirmed with
  Razorpay, then the migration, the sandbox steps and a first live payment, each on the owner's approval (RELEASE §6f).
