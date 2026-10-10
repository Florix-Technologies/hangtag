# Hangtag audit log

The running checklist of the code audit: what was checked, what was fixed (each with a regression test), what is left.
Newest session first. Production was never touched; nothing was deployed or pushed.

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
- `sw.js`'s cache name hashes the app's files byte for byte, line endings included (`scripts/build.mjs`). Built on this Windows working tree, a checkout with other line endings (Linux, or a fresh Windows clone) reports "sw.js is out of date" in `npm run check` and `build.test`. Hashing the text with line endings normalised would make it the same everywhere; this was found while splitting the commits and has not been changed yet.

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
