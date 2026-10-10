# Hangtag audit log

The running checklist of the code audit: what was checked, what was fixed (each with a regression test), what is left.
Newest session first. Production data and services were never touched (no migration run, no function deployed); code is
pushed only on the owner's word.

## 2026-10-10 (fourth session: any kind of product, without code changes)

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 32 | Product model (audit) | **Already generic:** variants (up to 3 options of any name, 100 values each, 400 variants), each variant with its own SKU, barcode, price, cost and stock; SKU and barcode unique per shop in the database; tracking chosen per product (none, serial/IMEI, batch, batch + expiry), with business types only setting default capabilities; stock always the sum of stock records. **Missing:** fields of the shop's own (only fixed fields and a free-text description); units were a fixed list of nine, enforced by CHECKs on products, bill, return and order lines; the import read an option column only if it was one of 13 built-in names; the template was fixed, and there was no export | Audited |
| 33 | Custom fields | Nothing let a shop describe a product in its own words | Added — `domain/catalog/attributes.js`: seven kinds, choices, required, lowest/highest, decimals, unit after the number, longest text, limited to categories; values per product (`attrs`); names of built-in fields refused with where they live (Price, Stock, SKU, IMEI, Expiry…). Database section 3z: `hangtag_attributes`, each value checked against its field's kind, a field in use kept (kind fixed, archived not removed), row security as products, the plan-ended guard. Settings → Products & Inventory → Product fields; the editor's folded "More details"; the product view; search. Tests: `attributes.test.mjs` (49), `supabase/tests/custom-fields.test.mjs` (44) |
| 34 | Variants from fields | Variant options were free text per product | Added — a product option can take its values from a field (`opts[i].a`, `options.opts[].attr`). The editor offers the shop's fields first, with their choices one tap away. A choice renamed in Settings is renamed on every product using it, values and variants alike (ids, stock and codes kept; renames apply at once, so a swap works). Tests: `shop-fields-sync.test.mjs` (21), the e2e |
| 35 | Units | A unit outside the nine (roll, pair, sq ft…) was refused by the app and the database | Fixed — the shop's own units (`hangtag_units`: code, name, decimals 0–3, counted or measured, GST unit code). One registry in `units.js` lets all 51 modules that read units know them, including the GST exports. The database takes any unit code, also in sections 3k and 3p, so `schema.sql` re-runs. Report row 36 flags a code the shop doesn't have. A code this device hasn't downloaded keeps its code instead of becoming pieces. Stock count, supplier-bill import and code intake list the shop's units too |
| 36 | Import and export | (a) A column such as "Wattage" was dropped silently, though the template's notes said any option name works. (b) No custom data could be imported. (c) No export | Fixed — a column named as a field imports into it. The same value on every row of a product is the product's; a value that differs makes its rows variants (linked to the field; a date, yes/no or several-choices field can't, said plainly). Required fields are checked per category. A column with no field is listed with the kind its values suggest, and "Add as fields" makes it one and reads the file again. The template has the shop's option names and a column per field. The export uses the same columns and reads back as the same products, values and variants. Tests: `product-import-fields.test.mjs` (27); the 31 + 44 earlier import checks still pass |
| 37 | Sync, backups | — | Fields and units sync as commerce-batch records (kinds `at`, `un`; live updates; team members' poll). A product's upload waits for the fields it uses (`need`); a full upload sends units and fields first; backups carry and restore them |
| 38 | Plan-ended guard (latent) | Section 3t puts the guard on the tables that exist when it runs, so a table made by a later section has none unless it adds its own. The upgrade test's report row 76 caught it | Fixed for 3z's tables; any future section with a new table must attach the guard |
| 39 | Touch targets (pre-existing) | The variant editor's value chips (14 px and 22 px) and the variant table's checkboxes (18 px) were under 24 px on phones, found by the new e2e's phone check | Fixed — larger on touch screens |
| 40 | Editor regression caught | Redrawing the whole editor when the category box lost focus swallowed the tap that moved the focus (`pos-variants` e2e) | Fixed — only "More details" is redrawn |

### Demonstrated without code changes (`tests/e2e/custom-fields.test.mjs`, 33 checks, in Chrome against the real schema)
An owner with no template for their products:
- makes Wattage (one choice), Spectrum (one choice) and Warranty months (0–60) in Settings; IMEI is refused, pointing to serial numbers;
- makes a unit, Sq ft (2 decimals, GST SQF);
- adds an LED grow light whose variants come from Wattage, with its spectrum and warranty, and a hand-knotted rug sold by the square foot (24.5 in stock);
- finds the light by "bloom", sees its details, and is stopped by a warranty of 72;
- imports bar lights by Wattage with a Lumens column the shop had no field for, makes Lumens a field in one tap, and exports the catalog;
- sells a 100 W light (stock 5 → 4), renames 100 W to 100 Watt (same variants and stock, on every product) and archives Spectrum (values kept).

The database holds every step, and the new screens pass the phone layout checks.

### Test results (run, not assumed)
- `npm run check`: `sw.js` current (458 files, `hangtag-3031e0e5c1`), 420 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- Full suite: **160/160 test files passed** (78 unit, 27 database, 4 eval, 51 browser) on Windows with Chrome.
  - The run before it failed two browser suites. `pos-variants` caught the editor regression (item 40, fixed). `google-signin` hit a 30 s navigation timeout while the machine was busy; it passed alone and in the final run.
- **New suites:**
  - unit: `attributes` 49, `shop-fields-sync` 21, `product-import-fields` 27;
  - database: `custom-fields` 44, `upgrade-live-database` 20 (3x, 3y and 3z on the previous release's database, which still has the fixed unit list; report 80/80);
  - browser: `custom-fields` 33.
- **Existing suites kept passing:** the import checks (31 + 44), `options` 49, the responsive matrix 427, and the team-tenancy leak sweep, now covering the two new tables (155).
- **Tests that failed first:**
  - the new phone check failed on the chips and checkboxes (item 39);
  - `pos-variants` failed on the regression (item 40);
  - the suggestion test failed on free text offered as a choice;
  - `attributes` caught `.map(tidy)` passing the index as a length.
- **Not run:** a hosted Supabase project (the new section ran on PGlite only, PostgreSQL 18.3), and a real phone (puppeteer's touch emulation).

### Committed (local, not pushed)
On `ux-productization` after `b1f66cc`: `63b48d9` (rules and database section 3z), `dd2216a` (the app, import and export, the e2e), and this log in the commit after them.

### Supported, and what is not
- **Supported for any product:** the shop's own fields of seven kinds, in any category; variants from any field or free option names; per-variant SKU, barcode, price, cost and stock; tracking chosen per product (serial, batch, expiry or none); the shop's own units; import and export with all of it; search by field values. All of it is checked, shop-isolated and kept through archiving.
- **Not done:**
  - **Per-variant values:** a variant has only its options, SKU, barcode, price and cost; a field value per variant (each variant's own model number) needs the field as an option.
  - **Tracking by import:** import doesn't set a product's tracking or take serial numbers or batches. Tracked stock comes in through Stock in or Purchases, as before.
  - **Updating by import:** import still adds new products only.
  - **Unit conversions:** units convert only by repack between products. There's no box-of-12 purchase conversion, and a shop unit can't be read from a scale.
  - **Fields elsewhere:** values aren't printed on bills or stickers and aren't filters in reports (search only). There's no drag-to-reorder for fields (new ones go last). Field permissions follow `manage_products`.
- **Built-in names still used, outside core workflows:**
  - example catalogues and placeholder names per business type;
  - the draft assistant's guess of Size, Colour or Storage;
  - Colour and Size treated specially for swatches, the "pieces by size" report and the database's old colour/size columns;
  - the list of suggested option names.

  None of these stops another kind of product from being made, stocked, sold, imported or exported.
- **The live database** needs section 3z (`20261012120000_hangtag_custom_fields_units.sql`), after 3x and 3y; report rows 36 and 91–93. Until then the app sends field values only for products that have some, so every other product still syncs.

## 2026-10-10 (third session: release readiness)

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 28 | Build (`sw.js`) | The cache name hashed the app's files byte for byte. Git stores them with LF (all 449 text files in the shell are `i/lf`) and checks them out with CRLF on Windows (`core.autocrlf=true`, set by Git for Windows) and LF on Linux, while this working tree was mixed (105 CRLF, 344 LF). So each checkout of the same commit computed its own name: on `f090c70` a fresh Windows clone gave `hangtag-e4a3197d42`, a Linux-style (LF) clone `hangtag-756745c4f5`, the committed `sw.js` said `hangtag-1b40e9a88a`, and both clones failed `npm run check` / `build.test` with "sw.js is out of date" | Fixed — `scripts/sw-cache.mjs` (the file list and hash, moved out of `build.mjs`) hashes text with CRLF read as LF and pictures byte for byte (git's own NUL test for binary). `tests/unit/sw-cache.test.mjs` computes the name from the real files as an LF and a CRLF checkout would have them: 3 failures before the fix (the two names above against `1b40e9a88a`, and the order below), 8/8 after. `sw.js` regenerated: `hangtag-756745c4f5`, one line changed |
| 29 | Build (latent) | The file list was sorted by system path. Windows' `\` sorts after digits and capitals, `/` before them, so a folder such as `src/ui/` next to `src/ui2/` or `src/uiB.css` would be listed in another order on Linux (another `sw.js`, another test-hook module order). None of today's 437 files hit it | Fixed — sorted by URL; the same test |
| 30 | Migrations 3x, 3y (validation) | The suites ran each migration only on top of a `schema.sql` that already holds it. The upgrade a live database goes through had not been run | Checked, no defect — `supabase/tests/upgrade-3x-3y.test.mjs` (renamed `upgrade-live-database.test.mjs` in the fourth session, which added 3z to it) builds the previous release's database (today's `schema.sql` without 3x, 3y and their 4 report rows is exactly `9623601`'s, checked with `git diff`) with a shop, a cashier, bills (one cancelled, one with a return) and a console admin; shows its bug (a re-sent cancelled bill comes back); runs 3x then 3y, each twice, and 3y then 3x on a second copy. Report 77/77 ok, every row of the 67 tables unchanged, 3y holds for the old bills, 3x lists and opens the old shop and refuses its owner. Without 3y, 6 of its checks fail. PostgreSQL 18.3 (PGlite 0.5.8) with Supabase stand-ins; a hosted non-production project was not available (below) |
| 31 | `extract-bill` with the real Claude API | Needs a key. There is none in this environment (the function reads `ANTHROPIC_API_KEY` from the Supabase project's secrets, not from this machine), and no Deno or Docker to serve the function locally | **Blocked** — added `npm run eval:extract-bill`: the function's own provider, request (schema, thinking, effort, fallback) and answer code on a made-up PDF bill, with only the HTTP call replaced by `fetch`. Skipped without a key. `extract-bill-provider-plumbing.test.mjs` proves its plumbing against a local stand-in for the Messages API (headers, fallback beta, streaming, JSON-schema format, a well-formed PDF, a split stream, a refused schema failing): 7/7 |

### Pushed and deployed (on the owner's word, 2026-10-10)
- `git push origin ux-productization`: `9623601..f090c70` (the eight commits of 2026-10-10). Scanned first: no `.env`, keys, tokens, logs, screenshots or `dist/` in the 103 files.
- Vercel builds each push of the branch (`npm ci`, `npm run build`, `dist/site`). It built `f090c70` as a **Preview** (GitHub status "Deployment has completed", 14:06 UTC). The preview sits behind Vercel's sign-in (HTTP 302), so its pages weren't checked from here. Vercel's **Production** is still `6af8cc2` (2026-10-07). Promoting is done from the owner's Vercel account; this machine has no Vercel CLI login.
- No migration was run and no Edge Function deployed. `main` (GitHub Pages) was not touched.

### Test results (run, not assumed)
- `npm run check` (this working tree): sw.js current (453 files, `hangtag-756745c4f5`), 415 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- Full suite on the working tree with every change of this session: **155/155 test files passed** (75 unit, 26 database, 4 eval, 50 browser) on Windows with Chrome.
- Clean checkouts of `ed806ad`, one a fresh Windows clone (CRLF) and one an LF clone (the bytes Linux and Vercel check out):
  - `npm run check` passes in both with the same `hangtag-756745c4f5`;
  - unit, database and eval suites pass 105/105 in each;
  - `npm run build` leaves `sw.js` as it is (`git status` clean), so Vercel's build produces the committed file;
  - the service-worker browser test (`offline-queue-sw`) passes from the Windows clone.
- Before the fix the regression test failed 3 of 8 checks; after, 8/8. The upgrade test fails 6 checks without 3y.
- Not run: the real Claude API (no key), a hosted non-production database (none available), a Linux machine (the LF clone stands in for its checkout).

### Committed (local, not pushed)
On `ux-productization` after the pushed `f090c70`: `1eb8788` (items 28–29, the `sw.js` fix), `97df853` (item 30, the upgrade test), `ed806ad` (item 31, the real-API evaluation and its plumbing test), and this log in the commit after them.

### Release blockers
- **Live database**: sections 3x (`20261010120000_hangtag_platform_operations.sql`) and 3y (`20261011120000_hangtag_billing_integrity.sql`), in that order (the other order also works). Then run the report at the end of `schema.sql`: 77 rows, every one ok. If an earlier section (3u, 3v, 3w) was never run there, its rows say so; run it first.
- **`extract-bill`**: run `HANGTAG_EVAL_ANTHROPIC_KEY=<key> npm run eval:extract-bill` once, then redeploy the function (items 16–20 live there).
- **Vercel production**: promote a preview only after the two steps above. The Console's new pages need 3x; bill upload needs the redeployed function.
- **Hosted staging**: the migrations have run only on PGlite. The one Supabase project this checkout is linked to (`supabase/.temp`) is the live one, so nothing was run there. A staging project (or a branch database) would close this.
- Open from earlier sessions: updating known products by import; `hangtag_cap_on` callable for any shop; the console shop list's cost at scale; an unbundled first load; HSTS / nosniff on GitHub Pages.

## 2026-10-09 (second session: bill upload, product import, billing, Home, responsiveness)

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 16 | Upload bill (root cause) | The extraction schema had 19 nullable (`anyOf`) fields; the Claude API compiles at most 16 and refuses the rest with "Schema is too complex for compilation" — every real reading failed (the e2e stubs the function, so it never showed) | Fixed — text not on the bill is `""`, only the 6 numbers nullable; `extract-bill` unit test counts union and optional fields against the limits |
| 17 | Upload bill | A long bill could pass Supabase's 150 s wait for a first byte (504) | Fixed — the function answers 200 at once and streams spaces until the JSON; failures in the body, mapped by the app; unit + e2e |
| 18 | Upload bill | The original was uploaded to the cloud before reading started (a large photo went up twice before anything happened) | Fixed — kept on the device first, cloud copy in the background; e2e holds the upload and checks the reading went ahead |
| 19 | Upload bill | A PDF or photo the picker gives no type was refused or stored as `application/octet-stream` (the bucket rejects it); an undecodable picture failed with a vague message; error advice was said twice | Fixed — type from the name, original sent when the browser can't shrink it, HEIC said plainly; unit + e2e |
| 20 | Upload bill | The new rate limit refused every reading on a database without section 3t | Fixed — reads without a limit there (as before), refuses on any other limiter failure; unit |
| 21 | Product import | Template technical ("Option 1 name / value"), no instructions; row numbers in errors didn't match the sheet when it had blank rows; Excel's damage (8.9E+12 barcodes, lost leading zeros, ANSI "CSV") not caught; a re-import of known products blocked the whole file with no way past | Fixed — plain columns (Colour, Size…), notes and examples (left out if kept), the sheet's own row numbers, errors in the file's own column names, Excel damage explained, "leave them out" for known products, the file downloadable with its problems written in; `product-import` unit test + new e2e |
| 22 | Billing integrity | A till re-sending a bill (lost answer, or "upload every bill") overwrote `is_void`: a bill cancelled on another till came back — its stock out again, its money back in the books | Fixed in schema section 3y (migration `20261011120000`): an upload may cancel, never un-cancel; Restore stays the one way back; DB test (fails without the fix) |
| 23 | Billing integrity | A bill with a return could still be cancelled by a till that hadn't seen the return (its refund then left the cash book though the cash went out); an exchange's new bill could be cancelled, losing the customer's credit | Fixed — section 3y trigger refuses the cancel (an upload leaves the bill as it is); the app refuses an exchange bill and doesn't offer Cancel; DB + e2e |
| 24 | Payments | A second tap on "New QR"/link while the old one was being closed made two payment requests at the provider (one could take money that never reached the bill) | Fixed — one request per part while it is being made; unit test (fails without the guard) |
| 25 | Layout (app-wide) | A leftover `.sm{margin-top:14px}` (old stock list) pushed every small button, thumbnail and small avatar 14 px down | Fixed — removed; `tests/unit/css-modifiers.test.mjs` refuses a modifier class styled on its own |
| 26 | Responsive | Stock's barcode field squeezed to ~10 px on phones; product editor's code-type choices 18 px targets on touch; purchase search unnamed | Fixed — the matrix now also checks overlap, cards over cards, clipped controls, controls stuck under the tab bar and squeezed fields, on 33 screens × 4 sizes (16 forms and sheets added); `layout-checks` e2e proves each check fires |
| 27 | Home | Cluttered: four banners before any figure, the same UPI fact five times, a "why" panel opening by itself, ten equal tiles | Redesigned — one header with a large New sale, four headline figures, compact money / owed rows, reasons on a tap, briefing folded, side column for bank, agent and trend; `home` and `business-today` e2e check the new layout and that nothing opens by itself |

### Test results (run, not assumed)
- `npm run check`: sw.js current, 415 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- Full suite: **152/152 test files passed** (74 unit, 25 database, 3 eval, 50 browser) on Windows with Chrome. The first run failed only `business-today` (it still expected a figure's reasons to open by themselves, removed on purpose); updated and passing.
- Each fix's test was checked to fail without the fix (schema 3y upload and cancel, the QR double tap, the `.sm` rule, the layout checks on a page made to break them).
- Not run: the real Claude API or a deployed Edge Function (the schema fix follows the documented limits; the function's request is unit-tested).

### Committed (2026-10-10, local, not pushed)
One commit per piece of work, on `ux-productization` after `9623601`: Phase 56 `4cbd12e`; audit round 1 (items 1–15) `53e3aa8`; upload bill (16–20) `ffc9341`; product import (21) `4876b63`; billing and payments (22–24) `56bbb48`; Home (27) `5ebc4b3`; layout and responsiveness (25–26) `af72653`; this log in the commit after them. Each commit built cleanly and passed its own unit, database and browser tests when it was made. The one exception is Phase 56's commit, which keeps `9623601`'s `phase1_foundation` failure (the 3w migration's missing marker); the next commit fixes it.

### Not done / next
- The live database needs section 3y (`20261011120000_hangtag_billing_integrity.sql`) after 3r; report row 90 must say 2.
- `extract-bill` needs redeploying for items 16–20 to reach the live app (the schema fix is in the function).
- Products already in the shop can be left out of an import, not updated by it (prices / stock by file would be a feature).
- ~~`sw.js`'s cache name hashes the app's files byte for byte, line endings included~~: fixed 2026-10-10 (item 28).

## 2026-10-09

### Checklist (priority order)

| # | Area | Finding | Status |
|---|------|---------|--------|
| 1 | Data integrity / migrations | The 3w and 3x migrations lacked `-- Requires: supabase/schema.sql`, so the Phase 1 foundation suite ran them on an empty database and failed | Fixed — `tests/unit/migrations.test.mjs` |
| 2 | Data integrity / migrations | Nothing checked that a migration said to be "exactly section N of schema.sql" still is | Fixed — the same test compares all 7 byte for byte (3r and 3s may add only their declared row-security block) |
| 3 | Security / supply chain | Edge Functions imported `npm:@supabase/supabase-js@2` (any new 2.x on the next deploy) | Fixed — pinned to 2.117.2, the app's own version; `tests/unit/function-imports.test.mjs` |
| 4 | Test infrastructure | e2e browser path hard-coded to Windows Chrome | Fixed — Chrome, Chromium or Edge found on Windows, macOS and Linux (or `CHROME_PATH`); as root on Linux started with `--no-sandbox` |
| 5 | Test infrastructure | A missing browser was reported as an app failure | Fixed — the runner reports browser suites as skipped for the environment (exit 77); `TEST_STRICT=1` fails instead |
| 6 | Test infrastructure | Database suites ran one after another (slow; long runs timed out); a hung file blocked the run | Fixed — unit and database suites run side by side (`TEST_JOBS`), 25 DB suites in 55 s; per-file `TEST_TIMEOUT_MS` (20 min) |
| 7 | Build | esbuild installed for another platform (node_modules copied from Windows to Linux) crashed the build at import | Fixed — the build says it is the environment and to run `npm ci` |
| 8 | Console (Phase 56) | Hard-coded `₹` in the console's domain text (currency rule) | Fixed — formatter passed in; `currency-hardcoding` test |
| 9 | Console (Phase 56) | Double-clicking a row opened its panel and the second click closed it; a second panel could stack | Fixed — e2e `platform-console` check |
| 10 | Tenant isolation (shared device) | Four per-shop keys stayed with the device when another account signed in: the bill-number series (`hangtag_till`: the next shop could number its bills in a stray series), a pending AutoPay approval, the last full sync time (could hide the next account's "not in the cloud yet" warning for 6 h) and the backup log (could hide its backup reminder) | Fixed — kept per account, sync time re-read on switch; `DEVICE_KEYS` names what deliberately stays; `tests/unit/account-keys.test.mjs` fails on any new key that is neither |
| 11 | Cost abuse | `extract-bill` (paid AI per call, reachable from a free trial) had no rate limit | Fixed — 6/min and 60/day per user, 12/min and 150/day per shop (settable), on the Agent's limiter with separate counters; refuses if the limit can't be checked; `extract-bill` unit test |
| 12 | Test infrastructure | The runner missed CommonJS and helper-driven e2e suites (13 of 48), so they ran in the parallel pool | Fixed — every `tests/e2e` file, and any file loading puppeteer, is a browser suite |
| 13 | Security (clickjacking) | `vercel.json` sends `frame-ancestors 'none'` / `X-Frame-Options`, but a host that sends no headers (GitHub Pages serving the repo) left the shop app and the console frameable | Fixed — `src/app/frame-guard.js` stops both before they boot inside another site's frame (own-site frames still work; public store/order/receipt pages untouched); unit test + real-browser check in `platform-console` e2e |
| 14 | Linux build | Windows and macOS ignore letter case in import paths, Linux doesn't | Checked: 3,919 relative imports all exact — kept as `tests/unit/import-case.test.mjs`. The lockfile carries the Linux/macOS binaries of esbuild and the Supabase CLI, so `npm ci` on Linux works; node_modules copied from Windows is the environment (the build now says so) |
| 15 | Accessibility | Products' search box (placeholder only) and category filter had no name for screen readers; nothing checked control names | Fixed — named; the responsive matrix now fails any control without a name a screen reader can say, on 17 screens × 4 sizes (Products added) |
| — | Security scan | SECURITY DEFINER functions callable without sign-in: 6, all token-gated public endpoints by design (store/table ordering, sign-in methods); public order prices, stock and quantities are checked server-side; every table has row security | No defect |
| — | Security scan | Webhooks verify HMAC signatures before parsing, in constant time; outbound webhooks refuse private/loopback addresses; receipt links are token-only | No defect |

### Test results (run, not assumed)
- `npm run build`: 415 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- Full suite after the fixes: **148/148 test files passed** (unit, 25 database, 3 eval, 48 browser) in 17 m 52 s on Windows with Chrome.
- The double-click check then switched from `clickCount` (ignored by puppeteer-core 25) to `count: 2`: with the fix turned off it fails, with it on `platform-console` passes 55/55.
- Not run here: a Linux machine (the Linux fixes are verified by their unit tests and by simulating a machine without a browser).

### Also checked, no defect
- Public store/order/receipt pages build their markup with `textContent` (no injected HTML); the app's own templates escape data (a scan of every interpolation in markup found none unescaped).
- Bill originals: a private bucket, each shop confined to its own folder by `hangtag_shop_id()`, permission-gated, 15 MB and file types limited.
- A plan that ends (HT402) keeps every unsent bill queued until renewal; nothing is dropped.
- The CDN script carries an integrity hash; `vercel.json` sends CSP, HSTS, nosniff, `frame-ancestors 'none'`.

### Not done / next
- `hangtag_cap_on(owner, cap)` can be called by any signed-in account for any shop (reads one yes/no setting, needs the shop's UUID). Low risk; it runs inside triggers as the writer, so restricting it needs a schema section and those triggers checked.
- Console shop list computes stock and errors for every shop on each request: fine at today's scale, index or cache it beyond a few thousand shops.
- The app loads ~415 ES modules unbundled on first visit (the service worker caches them after). A production bundle would cut first-load time on slow networks; it is a build change, not a fix.
- If the live site is GitHub Pages (no `vercel.json` headers): HSTS and `nosniff` don't apply there; clickjacking is now covered by the frame guard.
