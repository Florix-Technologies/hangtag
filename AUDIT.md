# Hangtag audit log

The running checklist of the code audit: what was checked, what was fixed (each with a regression test), what is left.
Newest session first. The audit never changed production data or services (no migration run, no function deployed). On
2026-10-13 the live project's catalog and query statistics were read through the Supabase CLI, which creates a
short-lived login role (`cli_login_postgres`) to connect. Code is pushed only on the owner's word.

## 2026-10-14 (ninth session: the diagnostics fix pushed; the tests cut off from the live project)

The owner's brief: push `2827a20` once checked; make the browser tests unable to reach the live project (fail closed, with
regression tests, never running browser tests against it while doing so); a Preview of the diagnostics change; the
remaining diagnostics, the historical kept apart from the current. No production change.

| # | Area | Finding | Status |
|---|------|---------|--------|
| 100 | `2827a20` | Its diff is the diagnostics (3 files), `sw.js`'s cache name, AUDIT.md and the described tests. Every operation the diagnostics keep is a literal app table name (4 × `table:hangtag_meta`, and `sbFetchAll`'s literal tables), and only `table:`/`rpc:` + `hangtag_` + letters is kept | **Pushed** (`40cf202..2827a20`, 16:29 UTC). Preview `hangtag-7v182xuei-florixtechnologies-projects.vercel.app` (Vercel: success). Not yet tested in the Preview: the owner signs in |
| 101 | Browser tests reached the live project | **Confirmed.** Realtime WebSockets from every owner-mode test (request interception never sees them), and HTTP from five files that passed Supabase requests through: `accounts-isolation`, `offline-queue-sw`, `signin-tabs`, `shop-setup-settings`, `google-signin` (auth settings, profiles, sign-in methods, the status check, Edge Functions, the Google sign-in redirect, and one deliberate fetch of the auth settings) | Fixed: `tests/helpers/isolation.cjs` (`tests/README.md`, "Network isolation"). The five answer or refuse every Supabase request themselves. The Google check now checks the app's part (the sign-in address it sends the browser to); the service-worker check uses another origin on this computer. Tests: `tests/unit/test-isolation.test.mjs`, `tests/e2e/network-isolation.test.mjs` |
| 102 | The proposed `MAP *.supabase.co 127.0.0.1` | Not enough. It sends those names to this computer (anything listening on 443 here would answer) instead of refusing them; it leaves every other host open (`supabase.co` itself, `supabase.com`, payment providers, IP literals); and a proxy resolves names itself, past the rule | Used instead: no name resolves except this computer and three static hosts (`MAP * ~NOTFOUND` + 6 `EXCLUDE`, IP literals included), `--no-proxy-server`, and the tripwire. This computer has no proxy |
| 103 | `fn:subscription` | **Current.** Still not deployed: 9 functions are live, neither `subscription` nor `subscription-webhook`; the preflight answers 404 (15:36 UTC). In Chrome (isolated, preflight answered 404 as live): the call never leaves, "connection failed (fn:subscription)" is noted as a warning, and Plans & Billing still shows the plan, the trial and the prices, with "Online payment isn't set up yet. Contact Hangtag support to choose a plan." | Left undeployed: the owner's word, after reviewing the function |
| 104 | `auth:token` ×6 | **Historical; none of the six reached Supabase** (read-only log queries, 2026-10-15, counts and status codes only). In 15:30–18:30 UTC on 10-13 the API gateway saw 3 refresh POSTs: 16:20:55, 17:21:24 and 18:21:21 UTC (21:50:55, 22:51:24, 23:51:21 IST). All three were 200, with no refresh-token reuse; Auth logged them 200 in about 0.3 s, with no error or warning; the audit log has 3 `token_refreshed` and 3 `token_revoked` (rotation). Over the 24 h the report covers, 22 token POSTs reached the gateway (18 refresh, 4 PKCE), all 200. So the six failed before reaching Supabase (the device's network, sleep, or a request the browser stopped). Which of these is **not established**: the report's own times are still needed. Also seen: the earlier, un-isolated test runs (headless Chrome) reached the live project at 16:00–16:20 and 18:20 UTC, realtime included (item 101) | Needs the owner: "Download report" in the browser that recorded them; then each failure's time can be set against the gateway's quiet minutes |
| 106 | The isolation, under test configuration | **Confirmed gaps, closed.** Before pushing `b107b32`, these were found: a browser context with its own proxy (through puppeteer or the protocol); a proxy on this computer, which is allowed, then resolves names itself; a wrapper given as the browser could drop the rules, because only the spawn arguments were checked; spellings Chrome reads but the check didn't (`/proxy-server`, any case); a machine policy forcing a proxy past `--no-proxy-server`; `puppeteer.connect` to a browser the guard never configured; Node processes started by a test | Closed in a third commit: each refused, and tested in `tests/unit/test-isolation.test.mjs` (+5) and `tests/e2e/network-isolation.test.mjs` (+4). Not prevented: a bypass written on purpose (a hand-made DevTools connection, another program); a network answer still fails the file |
| 107 | The isolation, reviewed again (red team of four) | Every way through test configuration is closed. Found and fixed: the static "no connect" check flagged the isolation test itself; `iframe` added to the watched targets (a later review found puppeteer 25 reports iframe targets as `other`, already watched: no gap there); a worker thread from code (eval) runs its code before an `--import` loads, so it wasn't guarded, through the runner or not; a file run on its own didn't pass the guard to its Node processes. Confirmed: a host given by its IP address is refused (192.0.2.1, reserved, by HTTP and WebSocket). Not prevented: code written to get around it (raw UDP or DNS, internal socket bindings, a scrubbed child, another program, WebRTC to an IP, a hand-made DevTools connection) | Fixed in a fourth commit. Tests: `test-isolation` (15), `network-isolation` (16) |
| 108 | `subscription` and `subscription-webhook`, reviewed (not deployed) | Authentication and authorization are sound: the shop always comes from the token, owner-only actions are enforced in the database, the database sets every amount, and the webhook's signature check is correct (HMAC-SHA256 of the raw body, constant time, before parsing). Before they go live: **high:** AutoPay can start before the webhook can record charges (monthly charges with no paid time added). **Medium:** a failed lookup in the webhook is acknowledged instead of retried; a halted mandate is forgotten when AutoPay is set up again; Razorpay test keys are accepted on the one shared project; `autopay_enabled` has no readiness interlock; direct calls to the checkout RPC can tie up a capped offer. **Low:** event order and replays; promo-code probing; `verify_jwt` not pinned in a `config.toml`; `deploy.json` under-declares the webhook's secrets; consent recorded before the plan check; a suspended shop can pay; no throttle on Razorpay calls; CORS `*` | Left undeployed (owner's word). Full findings and the before-deploying list: the review of 2026-10-15 |
| 105 | Slow calls: the page's time or the network's? | **Still a hypothesis** (item 97). To settle it, a slow call now carries the network's own time as the browser measured it (Resource Timing through a PerformanceObserver, as the 250-entry buffer fills with the app's own files), as a band, and "page hidden" when the page was hidden at any time during the call; a failed connection carries "page hidden" too. Matched in memory by operation and start time; only names, bands and a flag are kept. In Chrome: a page busy 3.5 s with a quick answer gives "slow call (…) · 3–10 s · network under 1 s"; a 3.5 s answer "· network 3–10 s"; a hidden page "· page hidden". Review (no privacy issue) found and a fifth commit fixed: two calls of one operation within 100 ms could take each other's network time (now: the closest timing, used once, and none when two started together); a call waiting at unload was lost (now noted at `pagehide`; the wait is 3 s, not 10); the entry was stamped when the timing came, not the answer (now the answer's time); a failing timing could turn an answer into an error (now the notes can't touch the call) | Not deployed to Production. Tests: `tests/unit/diagnostics-events.test.mjs` (+9), `tests/e2e/slow-call-timing.test.mjs` (new) |

### Test results (run, not assumed)
- With every test isolated: `npm test` **170/170 files**, then **30/30 database files on PostgreSQL 17**; `npm run check` clean
  (`b107b32`). With the instrumentation (item 105): **171/171**, then **30/30**; 57 browser files, 10,367 requests answered
  by the tests, 266 refused at name resolution, 0 violations; `npm run check` clean, `sw.js` cache `hangtag-9b4a5bcb7d`.
- The first isolated run failed 5 browser files on their requests to the live project (item 101), 4 of them with every
  check passing; after their fix, all pass. The tripwire is itself tested: a test-only name mapped to this computer is
  caught (HTTP and WebSocket); a public host and the live project's REST, Auth, Functions, Storage and realtime addresses
  are refused at name resolution — checked in that order, the live addresses only after the public host was refused.
- No browser test ran against the live project while this was built.

## 2026-10-14 (eighth session: the remaining production errors, diagnosed)

The owner's brief: find the cause of each remaining code in the report printed 2026-10-14 13:45 IST (`PGRST116`,
`PGRST205`, `auth:token`, `fn:subscription`, slow status checks), reproduce, fix only app bugs, and change nothing in
production. Read-only on live: the catalog, `pg_stat_statements`, the schema cache, the backup list. All 20 entries that
print lists are dated 2026-10-13; nothing new was recorded on 10-14.

| # | Area | Finding | Status |
|---|------|---------|--------|
| 94 | `PGRST116` ×5 (20:49–21:00 IST, 10-13) | **Confirmed, historical.** The settings read (`maybeSingle`, no shop filter: row security scopes it) got one row per shop while the six open policies stood (item 76). supabase-js 2.117.2 makes `PGRST116` itself after the server's 200 (item 76 said PostgREST: corrected). The app's single-row reads are right: three `maybeSingle` (settings, logo, profile by id), no `.single()`. The old diagnostics kept only the code, so "settings, not logo" is inferred from code order. Live now: 1 `settings` and 1 `logo` row per shop | Fixed (diagnostics only): a database event names its table, "more than one row (table:hangtag_meta)", kept only in the app's own shape (`table:`/`rpc:` + a `hangtag_` name of letters). Tests: `tests/unit/diagnostics-events.test.mjs` (+4), `tests/e2e/open-policies-incident.test.mjs` (new: the incident and its containment end to end) |
| 95 | `PGRST205` "database update needed ×4" (10:41, 14:16, 20:09) | **Confirmed, historical.** `fetchBiz` reads `hangtag_attributes` and `hangtag_units` (section 3z) on every full download; 3z reached live at 20:39:56. Two tables × two downloads within a minute = ×4. Live now: all 43 tables the app names are in the schema cache | Same fix: the next one says which table. Trade-off: two missing tables now make two entries per download, not one merged |
| 96 | `auth:token` "connection failed" ×6 (21:01–midnight IST, 10-13) | **Cause not established.** "Connection failed" means no answer reached the page (an answer the browser blocked looks the same); 20 of 26 refreshes that day succeeded; none failed on 10-14. Needs: the report's download (each entry's time) and the dashboard's Auth logs (`auth.audit_log_entries` is empty on this project) | No app defect: `tests/e2e/session-refresh.test.mjs` (new) drops two refreshes: supabase-js retries, the app stays signed in, both drops noted, no token in diagnostics; signing out clears the session and no refresh follows (a tick that refreshes a present session passes) |
| 97 | `fn:subscription`; slow `rpc:hangtag_subscription_status` | `subscription` still isn't deployed (preflight 404, 13:57 IST): item 80. Database time of the status check: 664 calls since 2026-09-23, mean 18.3 ms, max 83.9 ms. The max was the same at 21:22 IST on 10-13, so the slow calls after it (up to 5.2 s) weren't slow in the database. Locally, calls made while the app starts are recorded at ~10× their network time (124 vs 12 ms). That this explains 1–5 s in production is a **hypothesis** | No change. Proposed: record the network time (Resource Timing, through a PerformanceObserver: the default buffer of 250 fills with the app's own files) and whether the page was hidden |
| 98 | Tests: realtime goes to the live project | **Confirmed (pre-existing).** Owner-mode browser tests open a realtime WebSocket to the live project: Puppeteer's interception doesn't cover WebSockets (seen with the host mapped to 127.0.0.1: 3 attempts in 4 s). The stand-in's token is unsigned, so the live service should refuse it (not observed) | Not changed (every browser test; needs the owner's word). Proposed: launch test browsers with `--host-resolver-rules=MAP *.supabase.co 127.0.0.1` |
| 99 | The database repair (item 91) | **Blocked: no verified backup.** 0 physical backups and PITR off (re-checked 2026-10-14 08:38 UTC) | Not run. First the owner's own `pg_dump` (or a plan with backups), verified by a restore |

### Test results (run, not assumed)
- `npm test`: **168/168 files passed** (unit, database, eval, browser), then **30/30 database files on PostgreSQL 17**;
  `npm run check`: clean, `sw.js` cache `hangtag-f075904626`.
- The new checks of the fix fail on the code before it: the op label and kind (2 unit, 2 browser checks), the op guard
  (1 unit check). The two new browser tests' weak
  checks found by review were made real: the server's 200 with 2 rows is observed; B's bill is shown to arrive before its
  removal is checked; with sign-out skipped, the "no refresh after sign-out" check fails (4 refreshes).
- Nothing was verified on a Preview or on the live project: this is not pushed.

## 2026-10-13 (seventh session: the Diagnostics & Health report — reliability before features)

The owner's brief: stop the Cashfree work and all new features; start from the latest Diagnostics & Health report
(printed 21:01 IST, app build `hangtag-80042738a2` = `acee306`, a Preview); find the real causes in code, configuration
and deployed state; no production change without the owner's word.

The paused work (Cashfree sandbox plan payments, the shop's own UPI QR picture) is on the local branch
`paused/cashfree-sandbox` (`e62d23c`), not pushed. `ux-productization` went back to `acee306`.

### How the deployed state was read (read-only)
- `npm run preflight:live`: functions, their JWT setting and secret names (names only).
- Public REST probes with the publishable key: zero rows asked, no function run.
- `supabase db query --linked`: function bodies as MD5 fingerprints, columns, triggers, policies, indexes, constraints,
  and `pg_stat_statements`. No table row was read. The CLI's connection creates `cli_login_postgres` (21:16 IST).
- `supabase migration list --linked`: the live migration history.

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 76 | "Pull from Supabase failed", "Pull settings failed" (5 from 20:49) | **Confirmed.** At 20:44:53 IST the first migration (`20260923102731`) ran again on the live project and put back its six "Public access to …" policies (`USING (true) WITH CHECK (true)`) on `hangtag_meta`, `_sales`, `_sale_items`, `_products`, `_images`, `_sizes`. Policies are OR-ed, so the app's single-row reads of the shop's `settings` and `logo` get one row per shop: the server answers 200 with them all and supabase-js refuses them itself (`PGRST116`; corrected 2026-10-14, item 94), the app reports UNKNOWN, and every download stops at the settings | Repository: the first migration no longer makes those policies on a database that keeps shops apart; report row 96 counts tables open to everyone. Test: `supabase/tests/live-recovery.test.mjs`. **Live: needs the owner** (`RELEASE.md` §0a: six `DROP POLICY` lines, then the whole `schema.sql`) |
| 77 | Security: every shop's rows open to every account | **Confirmed, critical.** Since 20:44 IST any signed-in account can read and change every shop's settings, bills, bill lines, products, pictures and sizes. Realtime also delivers other shops' new bills and products to every connected device; `onRemoteSaleEvent` adds a bill without checking its shop. Devices replace their copy at the next full download, which today stops at the settings (item 76) | **Live: needs the owner** (as item 76). The app's own check of the shop on live events: proposed, not made (not the cause; a wrong shop check would hide a team member's own bills) |
| 78 | 18 functions in older versions | **Confirmed.** After the whole `schema.sql` (20:39:56) the section files ran newest-first (3za … 3r). Each older file put its older functions back: `hangtag_save_sales` (3r: no 3y cancel guard), `hangtag_import_stock` (3z: no 3za locks), the subscription functions (3t instead of 3w), `hangtag_mobile_catalog` (3r: the store doesn't close when a plan ends; no 3z units), the console dashboard (3w). Rebuilt that way on PGlite, all 162 live functions match byte for byte | **Live: needs the owner:** the whole `schema.sql` once. Rehearsed in `live-recovery.test.mjs`: every function current again, no open table, report all 83 ok, **every shop row unchanged** |
| 79 | "database update needed ×4" (10:41, 14:16, 20:09) | **Confirmed.** Sections 3y, 3z and 3za first reached the live database at 20:39:56 (statement statistics); before that the `acee306` app asked for their tables and functions | Their tables exist now; what is left is item 78 |
| 80 | `fn:subscription` "connection failed" | **Confirmed.** `subscription` (and `subscription-webhook`) aren't deployed. Supabase answers the browser's preflight with 404 and doesn't allow `content-type`, so the browser reports a network failure. Only when the owner opens Plans & Billing; the app then shows online payment as not available | No code change. Owner's choice: deploy `subscription` (it answers "not set up" without payment keys), or leave it until subscriptions go live |
| 81 | Bill reading `NOT_CONFIGURED` | **Confirmed.** The live project has no `ANTHROPIC_API_KEY` secret, and `extract-bill` (v1, 2026-10-02) predates its fixes of 10-10 | No code change and no other provider. **Owner:** the key (`RELEASE.md` §4), then redeploy `extract-bill` |
| 82 | Slow calls (`hangtag_subscription_status` 786 ms, `hangtag_profiles` 715 ms, `auth:token` 845 ms) | **Not the database or the network.** Inside the database `hangtag_subscription_status` takes 18 ms on average (589 calls since 2026-09-23, max 84 ms); profile reads 1–2.5 ms, the last-seen update 4 ms. The project is in ap-south-1 (Mumbai); from this computer a TCP connection takes ~20 ms and a whole request 0.07–0.23 s. 76 status checks a day is the design (on connect, back on screen, every 10 minutes). **Hypothesis:** the app's timer counts until its own thread takes the answer, and these calls run when the app starts or comes back | No change. Measuring the network time alone (Resource Timing) would settle it |
| 83 | Diagnostics: "erro[amount]js:20" | **Confirmed.** The amount filter took "rs." (of errors.js) for rupees: any "rs." or "inr." inside a word was mangled | Fixed: ₹, or Rs / INR starting a word, then a number. Test: `tests/unit/diagnostics.test.mjs` |
| 84 | Diagnostics: "Problem · error" with no code | **Confirmed.** The panel showed an entry's code and HTTP status only when it had a source file. Database events have none, so the five errors hid `PGRST116` | Fixed: code and status shown for every entry. Test: `tests/unit/diagnostics.test.mjs` |
| 85 | The line-number migration of 2026-09-23 | Run again on a current database, it would number every bill's lines anew by their random ids (and bring back an index across shops). It ran once, on 2026-09-23 (statistics), not on 10-13 | Guarded: it changes nothing once the per-shop line key exists. Test: `live-recovery.test.mjs` |
| 86 | `RELEASE.md` | It told the owner to run the section files. That way can't remove the six policies (only `schema.sql`'s last part does), and it said the Phase 1 design was unapplied: the live migration history shows it applied on 2026-09-25 | Rewritten: the whole `schema.sql`, never older files; §0a with today's state and the containment |
| 87 | The live database's load | Supabase Realtime's change polling is 96% of the database's execution time (1.34 million calls since 2026-09-23). The app listens to about 25 tables | Observation only. It slows nothing measurable today (item 82) |

Not done (each needs the owner's word): the six `DROP POLICY` lines and the whole `schema.sql` on the live project;
the functions' redeploys and secrets (`npm run preflight:live`: 11 of 11 need something); a push for a Preview of these
fixes. A Preview uses the live database, so the database part can only be seen there after the owner's run.

### Later the same night: containment (on the owner's word) and the repair, prepared
| # | Area | Finding | Status |
|---|------|---------|--------|
| 88 | The six open tables (item 77), before acting | Every intended shop policy on them was present and identical to `schema.sql` (24 of 24: read, add, change and delete on all six); the six "Public access" ones were the only always-true policies in the whole database; signed-out users had no privileges on those tables, signed-in users all four. As two real shops' owners (counts only, no id printed): A saw 103 other products, 49 bills, 121 bill lines, 17 settings rows; B likewise | Containment safe: dropping the six leaves the designed state |
| 89 | Containment, 2026-10-13 23:45:55 IST | Six `DROP POLICY IF EXISTS` in one transaction (`RELEASE.md` §0a). Verified on live: 24 shop policies left, identical to `schema.sql`; no always-true policy anywhere; as both owners, 0 rows of other shops visible in all six tables, changing or deleting the other's rows reached 0 rows, adding a row as the other was refused by row security, own changes worked (every write rolled back); 1 `settings` and 1 `logo` row each; 401 signed out | **Done.** Not yet seen in the app: a device's next full sync (after the push) |
| 90 | Other ways in | Views (Phase 1's two) are `security_invoker`; the one Storage bucket (`hangtag-bills`) is private and per-shop-folder; no public table without row security is granted; the app uses Realtime only for database changes, which Realtime checks against each subscriber's row security (`realtime.apply_rls`, present). No live subscription at the time to observe | No other exposure found. Realtime's own delivery was not observed live (no connected device) |
| 92 | The pushed commits and their Preview (2026-10-14) | `origin/ux-productization` = `ee76f74` (pushed by the owner); Vercel built Preview `hangtag-axut0xoup-florixtechnologies-projects.vercel.app` (GitHub status "Vercel: success", 06:26 UTC). The app inside it was **not** opened here: the browser extension wasn't connected and signing in to the owner's account is the owner's step. Instead, as two real owners at the database: a full sync's reads over all 61 shop tables return 0 rows of other shops (A 704 own rows, B 234); 10 tables refuse direct reads by design (42501, as `schema.sql` grants) | The in-app checks (build `hangtag-45f5fb3c06`, "Last full sync", the codes in Diagnostics) wait for the owner's browser |
| 93 | The repair's preflight (2026-10-14, read-only) | Live database identified (ref, PostgreSQL 17.6, system identifier); dry run all 0; catalog unchanged since containment; migration history unchanged; data fingerprint 61 tables / 4,205 rows; **no platform backup** (0 physical backups, PITR off); the Management API takes the 819 KB script | Ready for the owner's decision. Undo captured and rehearsed: `supabase/checks/2026-10-13-repair-undo.sql`; two more checks: `data-fingerprint.sql`, `sync-read-isolation.sql` (all under test in `live-recovery.test.mjs`) |
| 91 | The repair (item 78), prepared | Object-by-object comparison after containment: only the 18 function bodies and 3 redundant indexes differ (grants, columns, defaults, triggers, policies identical); older harmless drift stays (owner FK names, a CHECK's printing, a fee check covered by the shape check). `schema.sql`'s 26 data changes, counted on live: **0 rows each**. It has no transaction control or non-transactional statement, so an explicit `BEGIN … COMMIT` makes it all-or-nothing | Prepared, **not run**: `RELEASE.md` §3 and four checks in `supabase/checks/` (each under test in `live-recovery.test.mjs`). Needs the owner's word |

### Test results (run, not assumed)
- `npm test`: **166/166 files passed** (unit, database, eval, browser), then **30/30 database files on PostgreSQL 17.5**.
- New: `supabase/tests/live-recovery.test.mjs` (21 checks, on both versions). Changed: `tests/unit/diagnostics.test.mjs`
  (+2 checks; both fail on the code before the fix).
- `npm run check`: clean, `sw.js` cache `hangtag-45f5fb3c06`.
- Nothing was verified on a Preview or on the live project after the fixes: neither has them yet.

## 2026-10-12 (sixth session: the roadmap, release fixes for stock and units, function sign-in)

The owner's brief:
- **Part A:** production readiness first.
- **Part B:** universal products and inventory.
- **Part C:** products and services, with a laptop repair as the first scenario.

`PLAN.md` now holds all three. `RELEASE.md` is the owner's runbook for the live project.

### State at the start
- `ux-productization` had 12 local commits (`1eb8788` … `db47975`).
- The owner said "push the current work".
- Local `main` (1 ahead, `4e4b215`, already in this branch) was left alone: it deploys to GitHub Pages.

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 63 | Pushing the local commits (A2) | The 87 files and 4,936 added lines were reviewed before pushing:<br>- no keys or tokens, only placeholders such as `<key>` and `sk-ant-…`;<br>- `.env.local`, the Google client secret and `supabase/.temp/` are git-ignored and untracked;<br>- `config.js` has only the URL and the publishable key;<br>- no logs or build output | Pushed `f090c70..db47975` to `ux-productization` (not `main`). Vercel built the Preview (status "success") |
| 64 | A product's unit (items 52, 58) | — | Fixed `7a372f9` (I1):<br>- the unit is pinned once the product has stock records, bills, an open order or an open purchase order, and the editor locks "Sold by" with the reason;<br>- a changed count with more decimals than its unit is refused in the stock box, Stock in, Adjust and batch counts, never rounded;<br>- an unchanged 12.5 pieces from before is no change.<br>Tests: `unit-safety` 24, `units-weighing` (browser) +1 |
| 65 | Repack (item 60) | — | Fixed `451ded6` (I20):<br>- the output is q × per exactly; one the target's unit can't hold is refused, with the nearest amounts in stock that fit;<br>- per is kept to 3 decimals, as the database keeps it.<br>Tests: +5, including a sweep of 3,240 plans: every one accepted fits `hangtag_repacks_qty_check`, and every suggestion is accepted |
| 66 | Supplier bills in boxes (item 59) | — | Fixed `93308e2` (I19):<br>- the review keeps the bill's unit; a line in another unit than its product's needs the base quantity, and the plan refuses it until that is entered;<br>- stock is the base quantity at the cost spread over it, while the purchase keeps the bill's own quantity and cost, so its money stays exact;<br>- one new product, one unit.<br>Tests: `bill-import` unit suite +8, browser +5 (a "5 box" bill end to end) |
| 67 | Races and the database's own guards (items 53, 54, 58; 52 at the database) | — | Fixed `ea09567`, section 3za (migration `20261013120000_hangtag_stock_guards.sql`):<br>- a new serial's insert takes a row only from a write-off, and is refused when another device's insert won;<br>- supplier bills lock on their file and invoice number before the duplicate check, and keep field values;<br>- products and variants keep a database-maintained `updated_at`;<br>- the database refuses a unit change under history;<br>- report rows 94 and 95; `REPORT_ROWS` = 82 in one place (`supabase/tests/report-rows.mjs`).<br>Tests: `stock-guards` (20, on PostgreSQL 18 and 17). PGlite has one session, so the races are checked in the functions' text, as row 94 checks them live |
| 68 | Saved stock records (item 55, re-checked) | **Item 55 was wrong:**<br>- section 3n's `hangtag_tracking_shape` already refuses a change of a saved record's serials, batch or expiry;<br>- a serial record's quantity must equal its serial count;<br>- batch quantities are read from the records.<br>A quantity correction by the owner or a manager is allowed and logged by design, and "Combine colours" re-points records. A guard refusing every change was tried: three suites failed on exactly those designed paths, so it was not kept | Corrected. `0b60613` pins the right behaviour in `stock-guards` (+4). PLAN.md's T3 is dropped |
| 69 | `team` and `webhook-dispatch` sign-in (A5) | **The app's key is a publishable key (`sb_publishable_…`), not a JWT.** With JWT verification on, as on the live project, the gateway refuses both before they run:<br>- a phone redeeming a team QR (it has no session yet);<br>- the scheduler calling the dispatcher with its secret.<br>Both are designed for `--no-verify-jwt` and check callers themselves. `team` lets only `enroll_redeem` run without a session; its single-use, expiring token is marked used in one conditional update. Every other action needs `getUser()`, and managing the team also needs `hangtag_role()` = owner. `webhook-dispatch` compared its secret with a plain string comparison | `7dff39f`: both gates are explicit and tested; the dispatcher now compares in constant time and refuses everything while its secret is unset. Live redeploy with `--no-verify-jwt`: owner (`RELEASE.md` §5). Not tested against deployed functions: deploying is the owner's step, and nothing was sent to the live project |
| 70 | A browser suite crashed once in a full run | `business-capabilities`: "Node is detached from document". Home re-rendered between finding a button and clicking it | Fixed `4c6726a`: the shared click helper looks the element up again on that error only. 3 runs of 3 then passed (48 checks) |
| 71 | The Vercel Preview (A6) | Built from `db47975`. It sits behind Vercel's sign-in, the browser tools weren't connected here, and a Preview uses live data | **Not inspected.** Items 47 and 72 stand in; the owner opens it (`RELEASE.md` §1) |
| 72 | Production's app on the new database (the rollback in `RELEASE.md`) | `6af8cc2` (Vercel Production) ran its own 44 browser suites against today's `schema.sql` (3x to 3za and everything before): **43 of 44 passed.** `subscription` failed 13 checks, every one on a number section 3w changed on purpose: a 30-day trial instead of 7, a 12-month plan, new prices. The old app showed the database's new values correctly; no check failed on an error | Supports rolling the app back without the database (`RELEASE.md` §6). 3w's new defaults are what the old app shows if it is restored |
| 73 | Staging (A4) | Unchanged: no staging project, and creating one is a billing decision | **Blocked.** Planned once it exists: Previews pointed at staging through Vercel environment variables (PLAN.md R1), so testing a Preview never touches live data |
| 74 | The real Claude API (A3) | Unchanged: no key here | **Blocked.** How to set `ANTHROPIC_API_KEY` safely (an env file outside the repository, a spend limit, rotation): `RELEASE.md` §4 |
| 75 | The roadmap | Parts A–C with dependencies, acceptance criteria, risks and tests. **Services:** catalog items with no stock. **Repairs:** a job record of its own (asset, complaint, diagnosis, technician, status machine, append-only history), whose money goes through quotation → sales order → bill. The laptop scenario is mapped step by step | `PLAN.md`. A design workflow was started for Part C; its agents hit the session usage limit before returning anything, so the design was done directly from the code |

Items 56, 57, 61 and 62 stay open, in PLAN.md as I4, I10, I21, I12 and I22.

### Test results (run, not assumed)
- **Each fix:** its own suites ran before it was committed:
  - unit-safety, bill-import, commerce-batch;
  - every database suite, on both PostgreSQL versions for `stock-guards`;
  - the unit, bill-import and store browser suites.
- **Full suite on `7a372f9`** (I1, in a clean Windows checkout): **164/164** test files, then **28/28** database suites on PostgreSQL 17.5.
- **Full suite on `93308e2`** (I19): 163/164; the one failure was item 70, fixed and re-run.
- **Full suite on the final code (`0b60613`)**, in a clean Windows checkout: `npm run check` clean (`sw.js` current, `hangtag-80042738a2`, 0 architecture violations, lint 0/0). **165/165** test files (80 unit, 29 database, 4 eval, 52 browser), then **29/29** database suites on PostgreSQL 17.5.
- **Not run:**
  - the real Anthropic API;
  - a hosted staging database;
  - the deployed Edge Functions (nothing was sent to the live project);
  - the Preview itself;
  - a real phone.

### Committed
On `ux-productization` after `db47975` (pushed), all local:
- `7a372f9` I1;
- `451ded6` I20;
- `93308e2` I19;
- `ea09567` 3za;
- `7dff39f` function gates;
- `4c6726a` click helper;
- `0b60613` item 68;
- then this log, `PLAN.md` and `RELEASE.md`.

### Release blockers (each needs the owner)
1. **An Anthropic key:** for the real check and for the live secret (item 74).
2. **A staging project,** or the decision to release without one (item 73).
3. **The word to push** the commits above, for a Preview with them.
4. **The live project, in `RELEASE.md`'s order:**
   - backups;
   - sections up to 3za, with the report at 82 rows ok;
   - secrets;
   - function deploys, `team` and `webhook-dispatch` with `--no-verify-jwt`;
   - promotion.

## 2026-10-11 and 12 (fifth session: release verification, then the plan for import updates and unit conversions)

### State at the start (inspected, nothing discarded)
- `ux-productization` was clean, 7 commits ahead of `origin/ux-productization` (`f090c70`, pushed 2026-10-10): `1eb8788`, `97df853`, `ed806ad`, `b1f66cc` (third session) and `63b48d9`, `dd2216a`, `760f2e0` (fourth session). This session adds 5 more (under Committed), so 12 are local.
- Local `main` is 1 ahead of `origin/main` (`4e4b215`, Wave 2, already part of this branch's history). Other local branches and the old workflow worktrees were left as they are.

### Checklist
| # | Area | Finding | Status |
|---|------|---------|--------|
| 41 | `extract-bill`, the request | Checked against the current Messages API reference:<br>- model `claude-opus-5-5`, adaptive thinking;<br>- effort set explicitly (Opus 5.5 defaults to medium);<br>- JSON through `output_config.format`, not the deprecated `output_format`;<br>- the fallback header `server-side-fallback-2026-07-01` with `fallbacks: "default"` (the matching pair);<br>- streaming with `finalMessage()`;<br>- refusals and truncation handled;<br>- the PDF block before the text | No defect |
| 42 | `extract-bill`, the real API | No Anthropic credentials on this machine: `ANTHROPIC_API_KEY` and `HANGTAG_EVAL_ANTHROPIC_KEY` unset; no Anthropic CLI or profile | **Blocked** — `HANGTAG_EVAL_ANTHROPIC_KEY=<key> npm run eval:extract-bill`, once a key is available |
| 43 | The live project's Edge Functions (read-only: the functions list and secret names through the Supabase CLI, no values) | - **No `ANTHROPIC_API_KEY` secret.** Bill reading answers 503 "Reading bills isn't set up yet" whatever version is deployed. The Agent's AI is off too; it also needs `AGENT_ALLOWED_USERS`.<br>- **Stale deploys.** `extract-bill` v1 (2026-10-02) predates its fixes (items 16–20), and every deployed function predates the 2026-10-10 changes (pinned imports and more).<br>- **Wrong JWT setting.** `team` and `webhook-dispatch` run with JWT verification, though their READMEs deploy them with `--no-verify-jwt`: a phone redeeming a team QR has no session yet, and `webhook-dispatch` checks its own secret.<br>- **Not deployed:** `subscription` and `subscription-webhook`.<br>- **No provider secrets** for payments or the webhooks (UPI is checked by hand without them) | Found. The fixes are secrets and deploys on the live project, left to the owner (release order below) |
| 44 | Release preflight | Nothing could see how a project is set up | Added — `supabase/functions/deploy.json` lists, per function, the JWT setting and the required, provider and optional secrets (names only). `npm run preflight:live` is read-only and exits 1 while anything is needed. `tests/unit/release-preflight.test.mjs` (41) keeps `deploy.json` in step with the settings the code reads. Its first live run read the CLI's epoch-millisecond times as text and so never found a stale deploy; two checks for that failed before the fix |
| 45 | Migrations on the live version | The live project runs PostgreSQL 17.6, but every database suite ran on PGlite's 18.3, so SQL only 18 has would pass and then fail live | Fixed — `npm run test:db:pg17` runs the suites on `pglite-pg17` (PGlite 0.4.6, PostgreSQL 17.5) through a resolve hook, and `npm test` runs it too. All 28 suites pass on 17.5, including 3x, 3y and 3z on the previous release's database. `postgres-versions.test.mjs` fails when the live project moves to another major version. A table defaulting to `uuidv7()` passes on 18.3 and fails on 17.5 |
| 46 | Hosted staging | The Supabase account has four projects: `hangtag` (the live one, linked), `ecommerce` (another app) and two paused ones. None is a Hangtag staging database, and there's no Docker here for a local Supabase | **Blocked** — needs a staging project (the owner's call: it may need a paid plan or pausing a project). Runbook below |
| 47 | What Vercel serves | Every browser suite loads the repository through a test page with a loosened Content-Security-Policy | Added — `tests/e2e/vercel-site.test.mjs` (15) serves `dist/site`'s files with `vercel.json`'s headers, Supabase blocked. Checks:<br>- the shop app, the receipt, order and store pages and the Platform Console open with no CSP violation, page error or missing file;<br>- the service worker installs all 458 files under the committed cache name.<br>Vercel's build was reproduced from a fresh LF clone of `b818098`: `npm ci` and `npm run build` left `git status` clean with the same `hangtag-2af8ebe5c8`, and the test passed in that clone |
| 48 | Receipt and order pages (found by 47) | No icon link, so each receipt or order link a customer opened also asked for `/favicon.ico`, which the site doesn't have | Fixed — both name `icon.svg`, as `store.html` does |
| 49 | Vercel Preview | The commits are local, and a Preview needs a push, which needs the owner's word. Previews run `config.js`, which names the live Supabase project, so signing in on a Preview uses live data (and the fields screens need 3z there) | **Blocked** on the owner's word to push. Until then, item 47 and the clone build stand in for it |
| 50 | The shop's own units in the database (3z, not yet released; found while auditing the importer) | The database knew only Hangtag's nine units:<br>- a supplier bill refused 24.5 sq ft ("too many decimal places"): every unit of the shop's own was taken as whole numbers;<br>- a quotation or order saved 2.5 rolls: units outside the nine weren't checked at all;<br>- the online store refused 2.5 sq ft, and its + button stepped a shop's unit by 0.001, because the page never learned the unit's decimals | Fixed in 3z, before its release:<br>- `hangtag_unit_decimals(owner, unit)` gives Hangtag's nine as `units.js` keeps them, the shop's unit as saved (archived too), and 3 for an unknown code (as the app reads one);<br>- `hangtag_save_order`, `hangtag_import_stock` and `hangtag_place_mobile_order` are re-created in 3z as exact copies, with only that check changed;<br>- the store's catalog gives the shop's units (`units`: id, label, decimals), and `store.js` hands them to `setShopUnits`;<br>- report row 93 checks all of it (10).<br>8 checks: `custom-fields` 4, `mobile-store` (database) 2, the store's unit test 1, the store in Chrome 1. The 4 run before the fix failed (3 in `custom-fields`, 1 in `mobile-store`); the Chrome check fails with the old `store.js` |
| 51 | The online store's Add (found by 50) | Add puts the unit's smallest step in the cart: 0.001 kg, 0.01 m, and now 0.01 sq ft for a shop's 2-decimal unit, so a customer has to type the quantity. Released behaviour (Wave 12), not part of 3z | Found, not fixed: the owner's call (Add could put 1, or what is left when that's less) |
| 52 | Changing a product's unit | A product with stock can change unit, and its stock is then re-rounded into the new unit with an ADJUST: switching 12.5 kg to pcs writes +0.5 (`save-product.js:60-62`). The database doesn't stop it either | Confirmed in the code. Plan I1 (the app) and I3 (the database) |
| 53 | Two devices adding the same new serial | `hangtag_track_move` inserts a new serial with `ON CONFLICT … DO UPDATE` and no status check (`schema.sql:3238-3242`). If another device added the serial in between, the second insert silently takes it over | Confirmed in the code, not raced in a test. Plan I2 |
| 54 | The same supplier bill on two devices | The duplicate-file and duplicate-invoice checks are plain SELECTs with no lock, and the file-hash index isn't unique (`schema.sql:668`). Two devices confirming the same bill at once can both add its stock | Confirmed in the code, not raced. Plan I2 |
| 55 | A saved stock record sent again | Stock records are upserted by id, and a role with `manage_inventory` may update one (`schema.sql:1881-1883`). The serial and batch registers follow only inserts and deletes (`AFTER INSERT OR DELETE`, `schema.sql:3278`), so a rewritten quantity or serial list leaves them out of step | ~~Confirmed in the code.~~ **Corrected in item 68: not a defect.** Section 3n already freezes a saved record's serials and batch, and a quantity correction is a logged, designed capability |
| 56 | Stock records of the wrong shape | Only `hangtag_import_stock` checks that a serial-tracked line has serials, and a batch line its batch. `hangtag_save_purchase` and the outbox insert whatever they are sent | Confirmed in the code. Plan I4 |
| 57 | A product edit after a delete elsewhere | `patchProduct` falls back to a whole upsert when the row is missing (`cloud-gateway.js:142`). An edit queued on one device brings back a product deleted on another | Confirmed in the code. Plan I10 |
| 58 | Checking a product before updating it | `updated_at` on products and variants is whatever the client sends; no trigger sets it. So it can't tell an update from a file whether the product changed since. The audit's first design assumed it could, and its own verifier refuted that | Confirmed in the code. Plan I3 adds the trigger; I10 uses it |
| 59 | Supplier bills in boxes | `extract-bill` returns each line's printed unit (`core.js:33,56`), but the review lines drop it (`bill-import.js:42-57`). "5 box @ ₹600" becomes 5 of a pcs product at ₹600 each, and "Update cost prices" can then set a wrong cost | Confirmed in the code. Plan I19 (such a line needs its base quantity first), then I24–I26 (conversions, packs) |
| 60 | Repacking into a whole-number unit | `repackOutput` rounds the output to the target unit's decimals (`repack.js:19`). Opening 1 kg into pieces at 2.5 a kg makes 3 pieces on the device | Confirmed in the code, not run. Plan I20 |
| 61 | Bill and return lines | `saleItemRows` doesn't send the unit sold (`mappers.js:66-70`). The database fills it from the product's current unit, so a bill uploaded after a unit change gets the new unit | Confirmed in the code. Plan I21 |
| 62 | Smaller findings (reported by the audit, not re-checked) | - Opening stock from a product file has no cost (`product-import.js:348`).<br>- "Received today" counts opening stock that has a cost (`business-today.js:96`).<br>- Serial and batch history calls any record with an import id "Purchased" (`tracking.js:110,147`).<br>- Purchase line money rounds differently from sales (`purchase.js:47-49` against `paise.js:9`).<br>- Low-stock levels are whole numbers (`stock-levels.js:5`, `mappers.js:90`) | Plan I12 and I22 |

### The plan for the next feature
`PLAN.md`: 30 increments in dependency order, for updating products from a file (variants, fields, opening stock, batches and expiry, serials) and for unit conversions (box to piece, kg to g) that don't corrupt stock or cost. Each increment lists its scope, database change, safety and tests. Items 52–62 above map onto them.
- **Order:**
  1. stop today's corruption (I1, I19, I20);
  2. database guards (I2, I3);
  3. updating from a file (I5–I11);
  4. stock from files (I12–I18);
  5. units and costing (I21–I26).
- **Not started.** Per the brief, it waits until the release blockers below are cleared, or the owner says to go ahead.

### Release order (dependency order; the owner's steps change the live project)
1. **Staging** (when a project exists): the runbook below. Until then, items 45 and 30 stand in for it.
2. **Live database** (owner, SQL editor):
   - run the report at the end of `schema.sql` first;
   - then run whichever of 3u, 3v, 3w it flags, followed by 3x, 3y and 3z, in that order;
   - run the report again: 80 rows, every one ok.
3. **Secrets** (owner): `npx supabase secrets set ANTHROPIC_API_KEY=… --project-ref wcorlmgkwcahyfastjoz`, plus `AGENT_ALLOWED_USERS` if the Agent's AI is wanted. Payment, subscription and webhook secrets are needed only when those go live.
4. **Functions** (owner):
   - redeploy every function, `team`, `webhook-dispatch`, `payment-webhook`, `delivery-status` and `receipt` with `--no-verify-jwt` as their READMEs say;
   - deploy `subscription` and `subscription-webhook` when subscriptions go live.
5. **Check:** `npm run preflight:live` should leave only providers deliberately not set up. Then `HANGTAG_EVAL_ANTHROPIC_KEY=… npm run eval:extract-bill` with the same key.
6. **Push** `ux-productization` (owner's word). Vercel builds a Preview; open it signed in to Vercel and don't make changes there while it runs on live data.
7. **Promote** the Preview to Production in the Vercel dashboard (owner). Live updates need 3z first, because the app's realtime channel names the two new tables. That ordering is not verified here: there's no hosted Realtime to test against.

### Staging runbook (for when a staging project exists)
- **Never run `supabase db push` in this checkout.** `supabase/migrations` also holds the unapplied Phase 1 design (`20260925180000_phase1_foundation.sql`), which it would apply. Paste files into the SQL editor instead.
- **Keep this checkout linked to the live project.** Run CLI commands for staging with `--project-ref <staging-ref>` rather than re-linking.
- **Steps:**
  1. Load the schema the live app was built on: `git show 6af8cc2:supabase/schema.sql` (the Vercel Production build).
  2. Add a shop with products, a bill and a return through a local copy of the app whose `config.js` names staging.
  3. Run the migrations in order, then each one a second time (they must be re-runnable): `20261007120000_hangtag_return_reasons.sql` (3u), `20261008120000_hangtag_delivery_reports.sql` (3v), `20261009120000_hangtag_plans_autopay_platform.sql` (3w), `20261010120000_hangtag_platform_operations.sql` (3x), `20261011120000_hangtag_billing_integrity.sql` (3y), `20261012120000_hangtag_custom_fields_units.sql` (3z).
  4. Run the report from the current `schema.sql`: 80 rows, every one ok.
  5. Check that the shop's data is unchanged, and that a field and a unit can be made and used by the app.
- **What staging adds over items 30 and 45:** Supabase's real roles and grants, PostgREST's schema cache picking up `attrs`, the realtime publication, and 17.6 itself.

### Test results (run, not assumed)
- `npm run check`: `sw.js` current (458 files, `hangtag-740e26b846`), 420 modules, 0 architecture violations, bundle ok, lint 0 errors / 0 warnings.
- `npm test` passed:
  - **163/163 test files** (79 unit, 28 database, 4 eval, 52 browser) on Windows with Chrome;
  - then **28/28 database suites again on PostgreSQL 17.5**.
- **New suites:** unit `release-preflight` 41, database `postgres-versions` 3, browser `vercel-site` 15.
- **Grown for item 50:** `custom-fields` (database) 44 → 48, `mobile-store` (database) 16 → 18, `mobile-store` (unit) 5 → 6, `store` (browser) 40 → 41.
- **Tests that failed first:**
  - the preflight's two checks of the CLI's epoch-millisecond times (item 44);
  - `vercel-site` on `/favicon.ico` (item 48);
  - the unit decimals (item 50): 3 checks in `custom-fields` and 1 in `mobile-store`, and the Chrome store check against the old `store.js`.
  - The first full run after item 50 failed 3 database suites: `bank-accounts`, `commerce-batch`, `subscriptions`. Each runs an older migration on top of `schema.sql`, which brings back the older store catalog or checkout, and report row 93 now notices. They now run the 3z migration after it, as `commerce-batch` already did for 3y ("in the real order it runs after this one").
- **Not run:** the real Anthropic API (item 42), a hosted staging project (item 46), a Vercel Preview (item 49), a real phone.

### Committed (local, not pushed)
On `ux-productization` after `760f2e0`:
- `b3a4d44`: the database suites on PostgreSQL 17 (item 45);
- `3e5fc91`: the read-only release preflight (items 43–44);
- `b818098`: what Vercel serves, and the receipt and order page icons (items 47–48);
- `d23941f`: the shop-unit decimals in the database and the store (item 50);
- this log and `PLAN.md`, in the commit after it.

### Release blockers (each needs the owner)
1. **An Anthropic key.** With it, `HANGTAG_EVAL_ANTHROPIC_KEY=… npm run eval:extract-bill` checks the real API (item 42). The same key is the `ANTHROPIC_API_KEY` secret the live project lacks (item 43).
2. **A staging project** (item 46), or the decision to release without one; items 30 and 45 stand in.
3. **The word to push** `ux-productization`, so Vercel builds a Preview (item 49). 12 commits are local.
4. **The live project, in the release order above:**
   - the schema sections the report flags, up to 3z;
   - the secrets;
   - the function deploys, with the JWT settings their READMEs give.
5. **Not a blocker:** item 51, the store's Add, is a product decision.

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
