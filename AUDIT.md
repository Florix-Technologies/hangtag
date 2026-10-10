# Hangtag audit log

The running checklist of the code audit: what was checked, what was fixed (each with a regression test), what is left.
Newest session first. Production was never touched; nothing was deployed or pushed.

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
