# Hangtag roadmap

Updated 2026-10-12. Three parts, worked in this order:
- **Part A, production readiness:** release tasks only, no new features.
- **Part B, universal products and inventory.**
- **Part C, products and services.**

Production steps (migrations, secrets, function deploys, promotion) are in `RELEASE.md`; they happen only on the owner's
word. `AUDIT.md` records what was checked and found, with its tests.

Status words used below:
- **Done:** committed with its tests, and the full suite green.
- **Blocked:** needs something only the owner can give.
- **Planned:** not started.

## Rules for every increment
- **One increment per commit**, with its tests. The full suite (`npm test`, which includes the PostgreSQL 17 run) is
  green before the next one starts.
- **Database changes go in new sections** after the last one (3za now), each with its exact migration file:
  - a function is re-created as an exact copy of its latest body plus the change;
  - running `schema.sql` again stays safe;
  - no new value is added to a CHECK that `schema.sql` re-adds on every run (`hangtag_stock_imports.kind`, for one).
  - When a section adds report rows, `REPORT_ROWS` in `supabase/tests/report-rows.mjs` changes with it. A suite that
    re-runs an older migration also re-runs the later ones that re-create its functions.
- **Stock, cost and unit never change as a side effect.** Every stock change is an explicit record that was previewed,
  and the server checks it.
- **Old app versions keep working.** New columns are nullable or defaulted, RPC arguments stay the same or become
  optional, and the integer cost columns stay. The app updates itself on its next start online; until then an old
  version must not corrupt data, only lack the new feature.
- **No claim without a run.** A real API, a hosted database or a deployment counts as verified only when it was
  actually used.

---

## Part A — Production readiness (release work only)

| # | Item | Status | Done so far | Still needed |
|---|------|--------|-------------|--------------|
| A1 | Inventory integrity and unit safety | **Done for this release** | All five confirmed defects are fixed, each with regression tests:<br>- unit change re-rounding stock: I1 `7a372f9` and I3 `ea09567`;<br>- the duplicate serial race and the duplicate supplier-bill race: I2 `ea09567`;<br>- supplier bills losing their unit: I19 `93308e2`;<br>- repack making stock from rounding: I20 `451ded6`. | Recommended hardening, not blocking: AUDIT.md items 56 and 57 (I4 and I10 below). Item 55 was wrong (AUDIT.md item 68) |
| A2 | Review and push the local commits | **Done** for `db47975` | 12 commits reviewed for secrets, logs and build output, then pushed on the owner's word (2026-10-12). The Vercel Preview built. | Commits since then are local until the owner says "push" |
| A3 | Anthropic API configuration | Documented; real-API check **blocked** | How to set `ANTHROPIC_API_KEY` safely: `RELEASE.md` §4. The request was already checked against the API reference (AUDIT.md item 41). | A key, for `npm run eval:extract-bill` and for the live secret |
| A4 | Staging database | **Blocked** | Three stand-ins:<br>- the staging runbook (AUDIT.md);<br>- every database suite on PostgreSQL 17;<br>- the upgrade test, which runs 3x, 3y, 3z and 3za on the previous release's database with data, twice and in two orders. | A separate staging project; creating one is the owner's billing decision. Then: run the runbook, and point Previews at staging (R1) |
| A5 | Edge Function authentication | **Done** in code | `team` and `webhook-dispatch` are designed to run without JWT verification (the app's key is a publishable key, not a JWT). Their own gates are explicit and tested: `7dff39f`. The rest of each function's checks were read: AUDIT.md. | Live: redeploy with `--no-verify-jwt` (`RELEASE.md` §5) |
| A6 | Preview and production rollout | Runbook done; Preview **not inspected** | The Preview of `db47975` built (Vercel status: success). `RELEASE.md` covers backups, the migration order, function deploys, checks after the release, and rollback per step. | Inspecting the Preview needs a Vercel sign-in in the browser (the browser tools weren't connected here), and it uses live data. The owner's steps 1–7 |

**R1 (planned, needs A4).** Previews get their own Supabase project. The build would write `config.js` from Vercel
environment variables when they are set: Preview scope pointing at staging, Production at the live project. Without the
variables it keeps the committed `config.js`. Then testing a Preview never touches live data.

**The release is ready when:**
- staging and then live show the report all ok (82 rows);
- `npm run preflight:live` lists only providers left off on purpose;
- a real supplier bill is read on Production;
- a team QR adds a phone;
- the checks in `RELEASE.md` §7 pass.

---

## Part B — Universal products and inventory

What the brief asks for, and the increments that deliver it:
1. **The base unit is protected** where stock history makes a change unsafe: I1 and I3 (done).
2. **Safe updates to existing products and variants through imports**, with explicit control over prices and stock: I5–I11, and I17 for stock.
3. **Imports with batches, expiry dates and serial numbers or IMEIs:** I12–I18.
4. **Unit conversions** (box to piece, kilogram to gram) that keep quantities and costs right: I21–I26 (I19 and I20 done).
5. **The shop's own fields in reports, labels and documents:** F1–F3.
6. **Stock traceability** across purchases, sales, returns, exchanges and adjustments: T1 and T2, with I4 and I14.

### B1–B4: the inventory increments
S, M, L: small, medium, large. "Needs": increments that must land first.

| # | Size | What | Needs | Database | Status |
|---|------|------|-------|----------|--------|
| I1 | S | A product's unit is pinned once it has stock records, bills, orders or purchase orders. The stock box, Stock in and Adjust refuse a quantity with too many decimals instead of rounding it | — | none | **Done** `7a372f9` |
| I2 | M | Stock-write guards:<br>- a new serial can't take one another device has just added;<br>- a supplier bill locks on its file and invoice number before the duplicate check;<br>- products made from a bill keep their field values | — | 3za | **Done** `ea09567` |
| I3 | S | Products and variants keep a database-maintained `updated_at` (unchanged on an identical resend). The database refuses a unit change once a product has history | I1 | 3za | **Done** `ea09567` |
| I4 | M | The database refuses stock records of the wrong shape for tracked products on every path: serials for serial tracking, batch and expiry for batch tracking. Older records and exact resends pass | — | a nullable `tracked_since` column, a trigger, a backfill | Planned (closes AUDIT.md 56) |
| I5 | S | The product export carries "Hangtag ID" and "Hangtag version" columns. Stock is left out of the version, so a sale doesn't make a file stale | — | none | Planned |
| I6 | M | Match file rows to products: by Hangtag ID, then SKU, then barcode, then name with option values. An ambiguous match is an error, never a guess; a rename is matched only by ID | I5 | none | Planned |
| I7 | M | The update plan:<br>- only cells that differ change;<br>- an empty cell keeps its value and "(clear)" clears it;<br>- variants are never removed; stock and unit never change | I6, I1 | none | Planned |
| I8 | S | Stale checks:<br>- a row changed elsewhere since the export becomes a decision, kept by default;<br>- a catalog change between the preview and Confirm refuses | I5, I7 | none | Planned |
| I9 | S | Appending option values uploads only the new variants | — | none | Planned |
| I10 | M | Checked upload:<br>- a queued product edit compares the cloud with its expected old values before writing (using I3's `updated_at`);<br>- a conflict goes to sync review;<br>- a product deleted elsewhere stays deleted | I3 | none | Planned (closes AUDIT.md 57) |
| I11 | L | "Update your products" from a file:<br>- the preview shows old → new, with decisions;<br>- one local save;<br>- uploads only through I10 | I7, I8, I9, I10 | none | Planned |
| I12 | S | Opening stock from a file carries its cost. History labels and "Received today" go by the kind of stock record | — | none | **Done** 2026-10-18 (AUDIT.md 139) |
| I13 | M | Tracking columns in the product file (Track stock by, Batch, Expiry date, Serial numbers or IMEIs), checked across the whole file | — | none | Planned |
| I14 | L | A server-checked, repeat-safe function for stock from product files:<br>- opening lines are insert-only;<br>- "set to" lines carry the quantity expected now, and are refused if stock has moved since | I2 | one function | Planned |
| I15 | M | New products with opening stock, serials and batches, through I14. Online only: names aren't unique, and two offline phones would double the stock | I4, I12, I13, I14 | none beyond I14 | Planned |
| I16 | M | Existing tracked products get new batches and serials from a file. Nothing is written off without an explicit choice and a reason | I6, I15 | none | Planned |
| I17 | M | "Set stock to" for products the shop already has. The preview shows system, file and difference; the server checks the expected quantity | I6, I14 | none | Planned |
| I18 | S | An export that round-trips tracked stock: one row per batch, the serials in stock, real on-hand quantities | I16, I17 | none | Planned |
| I19 | S | Supplier bills keep the printed unit. A line in another unit ("5 box") needs its base quantity; the purchase keeps the bill's money exactly | — | none | **Done** `93308e2` |
| I20 | S | Repacking never creates stock. An output off the target unit's grid is refused, with the nearest amounts that fit suggested | — | none | **Done** `451ded6` |
| I21 | S | Bill and return lines carry the unit sold. (With I1 and I3 a unit can no longer change under a product's history, so this is now only for a bill made offline before the product had any.) | — | two functions re-created | Planned |
| I22 | M | Quantity and money tidiness:<br>- purchase line money rounded as sales are;<br>- low-stock levels keep their decimals;<br>- a shop unit's GST code is locked once lines use it | — | `low_stock` to `NUMERIC(12,3)`; unit guard extended | Partly done 2026-10-18: line money (AUDIT.md 139); the rest needs the schema, after the repair |
| I23 | L | Exact cost per base unit (4 decimals), next to the integer cost columns, which stay | I3 | additive columns, a trigger for old apps, functions | Planned |
| I24 | M | Same-dimension conversions (kg = 1000 g, l = 1000 ml, m = 100 cm, dozen = 12 pcs). Each is made once, at entry, with the factor kept on the line; supplier-bill lines in g or dozens convert instead of asking | I3, I19, I23 | functions check the factor when present | Planned |
| I25 | L | Pack definitions per product (box of 12, carton of 24): a pack's factor never changes, and every code sits in one registry | I3, I24 | `packs` column, `hangtag_codes` table | Planned |
| I26 | L | Buying in packs. Purchase, Stock in, purchase-order and bill lines can be in packs; the base quantity is packs × factor, computed once | I23, I24, I25 | a pack snapshot on stock records | Planned |
| I27 | S | Optional: big catalogs, with filtered and split exports | I5, I11 | none | Planned |
| I28 | L | Optional: selling packs | I21, I25 | pack on bill, return and order lines | Planned |
| I29 | S | Optional: packs in product import and export, and in reorder suggestions | I11, I25 | none | Planned |
| I30 | M | Optional: an atomic per-product update function, and price checks | I10 | one function, two checks | Planned |

**Unit conversions in brief:**
- **One base unit per product, pinned** (I1, I3). Stock, cost and every line quantity are in it.
- **Converted once, at entry.** The factor goes on the line, so a re-upload, a purchase-order receipt or a return never
  converts again.
- **Never rounded.** A quantity off the base unit's grid is refused, with the nearest valid one suggested (as repack now
  does).
- **Same dimension: a fixed table.** Box to piece: per-product packs with a factor that never changes.
- **Cost:** money entered is kept as entered. Cost per base unit is rate ÷ factor, to 4 decimals (I23). For a supplier
  bill this is already true of the purchase's money (I19).
- **Not planned:** converting between dimensions (kg to litres needs a density); re-reading stored quantities in another
  unit.

### B5: the shop's own fields in output
| # | Size | What | Needs | Database | Acceptance |
|---|------|------|-------|----------|------------|
| F1 | S | Labels: choose which of the shop's fields print on barcode labels | — | none | A "Material: Jute" label prints from the product's value; a field without a value prints nothing |
| F2 | M | Bills and quotations: a field marked "show on bills" prints under the line. The line keeps the values it was sold with, as it keeps option values, so a later edit doesn't rewrite history | — | `attrs` JSONB, nullable, on bill and order lines | An old bill reprints with the values it had. An old app's bill without them still saves |
| F3 | M | Reports and exports: group and filter sales and stock by a field; exports carry the fields | F2 | none | "Sales by Material" adds up to the sales total |

Risks:
- A field renamed after a sale: the line keeps the field's id and the value. Its label is read at print time, and the
  value is never rewritten.
- Personal data typed into a field prints wherever the field is shown. The owner chooses which fields print.

### B6: stock traceability
| # | Size | What | Needs | Database | Acceptance |
|---|------|------|-------|----------|------------|
| T1 | M | A stock card per variant: every movement (purchase, bill, return, exchange, adjustment, repack, import, count, job) with its document, who, when and the running balance | — | none | Every unit on hand traces to the documents that brought it in and took it out; the balance equals stock |
| T2 | S | Every stock record names its source. A report row counts records without one (older ones listed, not refused), and an adjustment keeps its reason as a code, not only as text | T1 | report row; nullable `reason` column | The report row is ok on a shop made today |

Plus I4 (the shape of tracked records) and I14 (insert-only stock from files). A saved record's serials, batch and expiry
already never change (section 3n), and a quantity correction by the owner or a manager is logged by design, so there is
no increment for rewritten records (AUDIT.md item 68).

**Order for Part B:**
1. Hardening: I4 and I10.
2. Updating from a file: I5, I6, I7, I9, I8, I11.
3. Stock from files: I12, I13, I14, I15, I17, I16, I18.
4. Traceability and fields: T1, T2, F1, F2, F3.
5. Units and costing: I21, I22, I23, I24, I25, I26.
6. Optional: I27–I30.

---

## Part C — Products and services

### The decision
**Services are catalog items. A repair is a job record whose money goes through the existing quotation → sales order
→ bill → payment engine.** No second billing system.

Two approaches were weighed:
1. **A job as a new kind of order** (`hangtag_orders.kind = 'job'`). It reuses the most code, but it bends every order
   function and screen:
   - the status machine;
   - the cart from an order;
   - fulfilment;
   - the store's reservations;
   - the Orders tab.

   A job also has fields an order has no place for: device, complaint, diagnosis, technician, approval, warranty and
   history.
2. **A job record of its own that links to orders and bills** (chosen):
   - The job holds what is about the repair.
   - Its estimate is an ordinary quotation; its approval converts that quotation to a sales order, as today.
   - Its final bill is an ordinary bill made from that order: payments, receipts, GST, returns and e-invoices unchanged.
   - Each piece can ship and be tested alone.

### Data model (new section, after Part A's)
- **Service items:** `hangtag_products.item_type` (`goods` default, or `service`).
  - A service has no stock, no tracking and no low-stock level.
  - Its tax code is a SAC (6 digits, 99…), kept in the HSN column, which already takes 6 digits.
  - Labour sold by the hour uses a shop unit, "hour" with 2 decimals (3z already supports that).
  - It is an item type, not a capability. A shop sees it once `uses_services` is on.
- **Jobs:** `hangtag_jobs`, one row per repair.
  - Columns: number, customer, asset (type, make, model, serial or IMEI, accessories handed over, condition), complaint,
    diagnosis, technician (a member), status, promised date, linked quotation, sales order and bill, warranty until,
    version (as orders have).
  - A device passcode is never stored; at most "passcode given: yes".
- **Job events:** `hangtag_job_events`, append-only. Each status change, note, assignment and approval is recorded with
  who and when. An approval also records how: in person, by phone or by link.
- **Status machine** in the database (as `hangtag_order_next_ok` is for orders):
  - intake → diagnosis → awaiting_approval → in_progress → ready_for_collection → completed (billed) → delivered (handed
    over);
  - on_hold from any open state, and back to where it came from;
  - cancelled from any state before completed.
  - The CHECKs sit inside the new tables' CREATE TABLE, so re-running the schema doesn't re-add them.
- **Stock:**
  - A service never touches stock: the ledger and every stock screen and check skip services.
  - Parts for a job are held for it while its sales order is open, the way the online store's orders hold stock today
    (`hangtag_mobile_reserved`, extended to job orders). They leave stock only on the job's bill, as ordinary bill lines
    with their serials and batches.
  - So stock still moves only through bills, purchases and adjustments, and every part traces to the job's bill.
- **Permissions and capabilities:**
  - `uses_services`, and `uses_jobs` (needs services).
  - A permission `manage_jobs` (create and update jobs; record diagnosis and approval), and a "technician" role that
    sees and updates the jobs assigned to it.
  - Bills keep `create_sale`; estimates keep `create_order`.
  - Every new table is per shop, with row security like the other business tables, and is closed when the shop's plan
    has ended (the 3t guard).
- **Sync:** jobs are saved through an RPC with a version check, as orders are. A conflict between two phones goes to
  sync review; events are insert-only, so they never conflict.

### Increments
| # | Size | What | Needs | Database | Acceptance | Tests |
|---|------|------|-------|----------|------------|-------|
| S1 | M | Service items:<br>- "This is a service" in the product form: no stock box, no tracking, SAC instead of HSN;<br>- services skip every stock read: stock page, value, low stock, reorder, counts, store availability, repack, purchases, bill import | A1 | `item_type` column (defaulted), a CHECK, a report row; the store's availability function | A service sells without "out of stock"; stock reports are unchanged by service sales | Unit: ledger and stock rules skip services. Database: the column, the CHECK, the store. E2E: create and sell a service |
| S2 | M | Mixed invoices:<br>- goods and services on one bill, with discounts, GST per line (18% on most services), totals and payments as today;<br>- the e-invoice marks a service line `IsServc: "Y"` with its SAC;<br>- GSTR-1's HSN summary lists SAC rows (unit "NA");<br>- a service is returned as a refund, never into stock | S1 | none | One bill with a part and a labour line: the GST split, e-invoice and GSTR-1 rows are right; returning the labour line refunds without stock | Unit: checkout totals, e-invoice payload, GSTR-1 summary. E2E: the mixed bill |
| S3 | S | Reports: product revenue and service revenue apart; parts cost (cost of goods on service bills) and labour | S2 | none | The two revenues add up to sales; cost of goods counts goods only | Unit: report sums |
| S4 | L | Jobs:<br>- intake (customer, asset, accessories, condition, complaint, promised date);<br>- the Jobs tab by status, with the status machine, events and a printable job sheet;<br>- `uses_jobs`, `manage_jobs` | S1 | `hangtag_jobs`, `hangtag_job_events`, the transition function, row security, report rows, migration | A job moves only by allowed steps; every step is in its history with who and when; another shop never sees it | Database: transitions, history, row security, isolation, the plan-ended guard. Unit: the status machine. E2E: intake to diagnosis |
| S5 | M | Estimate and approval:<br>- the job's estimate is a quotation linked to it (parts and labour), sent as quotations are;<br>- approval converts it to a sales order and records who approved, when and how;<br>- a revised estimate is a new quotation, the first kept | S4, S2 | `job_id` on orders | An approved estimate can't change; a revision keeps the history | Database: the link and the conversion. E2E: estimate → approval |
| S6 | M | Parts held for the job: the approved order's parts are held (not sellable elsewhere); a serial part names its serial. Cancelling the job releases them | S5 | the holding function extended to job orders | The SSD held for job 12 can't be sold at the counter; cancelling job 12 makes it sellable | Database: holding, release, two jobs racing one serial |
| S7 | M | Billing and delivery:<br>- "Bill this job" fills the cart from the job's order (parts and labour, hours × rate) and checks out as any bill: shared payments, receipts, GST;<br>- the job becomes completed, then delivered with the receiver's name | S6 | `job_id` on bills (or through `order_id`) | Paid once, stock out once (the part's serial sold), the job completed; a second tap bills nothing twice | Database: idempotent billing. E2E: bill and payment |
| S8 | M | History and warranty:<br>- the customer's jobs, and an asset's (by serial or IMEI) jobs and sale;<br>- a service item can carry warranty days, so a delivered job has "warranty until";<br>- a new job for the same asset within warranty is flagged | S7 | `warranty_days` on items (nullable) | Looking up the laptop's serial shows its earlier repair and its warranty | Unit: warranty dates. E2E: lookup |
| S9 | M | Pricing:<br>- fixed-price services; hourly labour (hour unit); a diagnostic fee that can be waived when the repair is approved;<br>- service packages as kits of services and parts (a kit's service lines never touch stock) | S2, S7 | none | A package bills its parts and labour lines with the package price | Unit: package lines, waivers |
| S10 | S | Roles and reports:<br>- a technician sees and updates the jobs assigned to it;<br>- reports of jobs by status, turnaround time and technician, and labour and parts per job | S4, S3 | role defaults | A technician can't bill or see other technicians' jobs, if the owner sets it so | Database: role checks. Unit: reports |
| S11 | M | Optional: recurring maintenance. A job template with its next due date, a reminder in Home's briefing, and a new job made from it | S4 | `hangtag_job_plans` | Due jobs appear on their date | Unit and e2e |

### Acceptance scenario: laptop repair
| Step | Delivered by | Checked by |
|------|--------------|------------|
| Receive a laptop: customer, make, model, serial, charger handed over, scratch on the lid | S4 | The job sheet prints all of it; the job is "intake" |
| Record the complaint ("doesn't boot") and assign a technician | S4 | History: created, assigned, with who and when |
| Diagnose ("SSD failed") and issue an estimate: SSD 512 GB from stock, ₹4,500 (HSN 8471, 18%); OS installation, ₹800 (service, SAC 998713, 18%) | S1, S2, S5 | The estimate is a quotation linked to the job; its GST is right |
| Obtain approval (by phone, recorded) | S5 | The quotation becomes a sales order; the job is "in progress"; history says who approved and how |
| Replace the SSD from stock | S6 | That SSD's serial is held for the job and can't be sold at the counter |
| Charge for OS installation and record payment (UPI) | S2, S7 | One bill: the SSD line (stock −1, serial sold to this customer) and the service line (no stock); payment recorded; the job "completed" |
| Hand the laptop back | S7 | "Delivered", with the receiver's name |
| Keep the repair history | S8 | The laptop's serial shows this job, its bill and "warranty until" |

The scenario becomes `tests/e2e/laptop-repair.test.mjs` once S1–S8 are in, run against the real schema like the other
browser suites.

### Risks
- **Services in old app versions.** An app from before S1 treats a service as goods and shows negative stock for it.
  The app updates itself on its next start online. Until then, nothing is written wrongly, because bills don't write
  stock records. The release notes say so.
- **GST for services:**
  - SAC codes and the 18% default need the owner's accountant to confirm per service;
  - e-invoices need `IsServc`;
  - GSTR-1's HSN summary reports services without a quantity unit.
- **Device data is personal data.** Serials, IMEIs and complaints belong to customers: they are never logged as text,
  and passcodes are never stored.
- **Two phones on one job.** The version check sends the loser to review. Events are insert-only, so no history is lost.
- **Held parts.** Holding stock adds a reader to every availability check. The store's holding function is the one
  extended, and tested.
- **Tax on a mixed bill with a bill discount.** It is spread over lines as today, so a service line's GST follows its own
  rate. Tested in S2.

---

## Overall order
1. **Part A, the owner's steps** (`RELEASE.md`): keys, staging, migrations through 3za, function deploys, then promote.
2. **Part A, recommended hardening:** I4 and I10.
3. **Part B,** in its order above.
4. **Part C:** S1–S3 (service items, mixed invoices, revenue split) are small and independent of Part B, and can come
   as early as the owner wants. Jobs (S4–S10) follow; the laptop scenario closes it.
