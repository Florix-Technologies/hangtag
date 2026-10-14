# Hangtag tests and evaluations

Every suite is a plain Node script that prints `PASS …` / `FAIL …` lines and exits non-zero on failure.
`node tests/run.mjs <folders or files>` runs them and prints a summary: unit and database suites side by side (`TEST_JOBS`), browser suites one at a time, each file stopped after `TEST_TIMEOUT_MS` (20 minutes).

| Command | What runs |
|---|---|
| `npm test` | everything below except the real-provider evaluations (the database suites twice: PostgreSQL 18 and 17) |
| `npm run test:unit` | `tests/unit` — pure rules and services in Node |
| `npm run test:db` | `supabase/tests` — the real `schema.sql` in PGlite (row security, RPCs, triggers, the check report) |
| `npm run test:db:pg17` | the same suites on PostgreSQL 17, the live Supabase project's major version (the default PGlite is 18, so SQL only 18 has would pass `test:db`): `tests/helpers/postgres17.mjs` points `@electric-sql/pglite` at `pglite-pg17`. `postgres-versions.test.mjs` fails when the live project moves to another major version |
| `npm run test:eval` | `tests/eval` — the Agent evaluations (Node and in-app) |
| `npm run test:e2e` | `tests/e2e` — the app in Chrome against PGlite behind a PostgREST stand-in |
| `npm run eval:agent:provider` | the Agent against a **real** AI provider (needs `HANGTAG_EVAL_ANTHROPIC_KEY`; costs money; skipped without a key) |
| `npm run eval:extract-bill` | bill reading (`extract-bill`) against the **real** Claude API: the function's own request and reading of the answer, on a made-up PDF bill (same key; costs money; skipped without a key; its plumbing is proven without one by `extract-bill-provider-plumbing.test.mjs`) |
| `npm run preflight:live` | not a test: a read-only check of a Supabase project (the linked one, or `-- --project-ref <ref>`) before a release. For every Edge Function: deployed, not older than its code, deployed with the JWT setting its README gives, and the secrets `supabase/functions/deploy.json` lists for it set (names only; values and digests are never printed). Exit code 1 when something needs doing. `tests/unit/release-preflight.test.mjs` keeps `deploy.json` in step with the settings the functions' code reads |

Browser suites need Chrome, Chromium or Edge (found where Windows, macOS or Linux installs it, or set `CHROME_PATH`) and serve the app on `localhost:3210`. Without a browser they are reported as skipped, not failed (`TEST_STRICT=1` fails instead).

The database suites check the report at the end of `schema.sql` against `supabase/tests/report-rows.mjs` (`REPORT_ROWS`): when a section adds report rows, change that one number. A suite that runs an older migration on top of `schema.sql` also runs the later migrations that re-create its functions, in their real order (3y, 3z and 3za re-create functions of earlier sections).

## Shared helpers (`tests/helpers`)

- **`report.mjs`**: the reporter. It provides `check(name, ok, info)`, `section(title)`, `problem(text)` (a failure outside a check, such as a page error) and `done(cleanup)`.
- **`app.mjs`**: the browser harness. `startShop({ report, uid, email, shop, users, functions })` starts one shop's cloud: PGlite with the real schema, row security on, and Edge Function stubs passed by path. `openDevice({ viewport, who })` opens a signed-in device with:
  - `run`, `until`, `text`, `vis`, `click`, `type`, `choose` and `go`;
  - `queued`, `review` and `sync` for the upload queue;
  - `net`, the network as that device sees it:
    - `offline()` / `online()`: the device knows it is offline, while the app's own files still load (as the installed app's cache serves them);
    - `down()`: unreachable while the device thinks it is online;
    - `failing(503)`;
    - `dropAfterSave(pred)`: the database saves the request but the answer never arrives.
  - `VIEWPORTS`: phone, phoneLarge, tablet, desktop.
- **`shop-fixtures.mjs`**: declared shops, built through the app's own functions (editor, customer and supplier forms, purchases, checkout), never by writing records directly. Each fixture states its `truth`, the figures read off its bills by hand. `BOUTIQUE` is the standard shop.
- **`responsive.mjs`**: `layoutIssues(page, { touch })` checks a screen as drawn:
  - the page never scrolls sideways;
  - no control sits off-screen;
  - sheets fit the screen or scroll inside;
  - on touch screens, targets are at least 24 px;
  - every control has a name a screen reader can say (its text, an aria-label, a <label> or a title; a placeholder alone is not one).
  - no two controls, and no two cards, are drawn over each other (a field's own voice or clear button, and a chip scrolled out of its row, don't count);
  - no control is cut off by a box that hides overflow;
  - no text field is squeezed under 80 px.

  `coveredAtEnd(page)` scrolls to the very end and reports any control still under a bar fixed to the bottom (the phone's tab bar). `layout-checks.test.mjs` runs the overlap, clipped, narrow-field and covered checks on a page made to break each once, and on look-alikes that must pass (a field's own voice button, folded content, a chip scrolled out of its row).
- **`tenancy.mjs`**: `readLeaks` and `writeLeaks` sweep every shop table for rows of one shop that others can see, change, delete or add. Every write attempt is rolled back.
- **`pg-rest.mjs`** and **`env.mjs`**: the PostgREST and Auth stand-in, and paths.
- **`isolation.cjs`**: the network isolation below.

## Network isolation (every test)

Tests reach this computer only, never the live Supabase project. `tests/helpers/isolation.cjs` is installed by the runner for
every file (`--import tests/helpers/isolation-hook.mjs`) and by `env.cjs`, which every browser test loads:

- **Node:** a socket to anything but this computer is refused before it connects (`ETESTISOLATION`): fetch, http, https,
  WebSocket clients and database drivers.
- **Chrome:** every launch gets `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1],
  EXCLUDE cdn.jsdelivr.net, EXCLUDE fonts.googleapis.com, EXCLUDE fonts.gstatic.com` and `--no-proxy-server`. No other host
  name resolves (IP literals included), so nothing reaches another host — WebSockets included, which request interception
  never sees. A test can't set its own proxy or name resolution, and a browser started without the rules is refused.
- **Tripwire:** every browser target is watched over CDP. A response from the network or a WebSocket handshake from any
  other host is a violation, and so is a Supabase request that left the test's own handlers (it is then refused at name
  resolution). The app's realtime socket is the exception: the stand-in has no realtime, so it is refused and counted.
- A violation is printed (`ISOLATION VIOLATION …`) and the file exits with 1. The runner shows each browser file's count:
  `· isolated: 303 answered here, 2 refused, 0 violations`.
- Test configuration can't get around it. A launch is refused when a test sets the name resolution or a proxy in any
  spelling Chrome reads (`--`, `-`, `/`, any case). It is also refused when the browser's own command line
  (`Browser.getBrowserCommandLine`) lacks the rules, as with a wrapper given as the browser, or when a canary to a reserved
  name (`http://isolation-canary.test/`) doesn't fail at name resolution, as with a proxy forced by a machine policy.
  A browser context can't have its own proxy (through puppeteer or the protocol). `puppeteer.connect` is refused, by CDP or
  WebDriver BiDi. A host given by its IP address is refused by the same rule. Node processes and worker threads a test starts
  are isolated too, through the runner or when a file is run on its own (`NODE_OPTIONS`; a worker from code gets the guard as
  its first line, since its code runs before an `--import` loads). What remains is code written to get around this: raw UDP
  or DNS to a chosen server, Node's internal socket bindings, a child with its environment scrubbed, a program other than
  Node or Chrome, WebRTC to an IP address, a hand-made DevTools connection. A network answer the tripwire sees still fails
  the file.

Writing a browser test: answer every Supabase request (the stand-in's `pg.handle(r)`) or abort it, never `r.continue()` one. A
page that has to run the app without request interception (a service-worker test: interception bypasses the worker) is
declared with `iso.noBackend(page)`. Proven by `tests/unit/test-isolation.test.mjs` and `tests/e2e/network-isolation.test.mjs`.

## The Agent evaluation (`tests/eval`)

One dataset (`tests/eval/agent/datasets.mjs`), scored by one evaluator (`evaluator.mjs`), at three levels:

| Level | File | Runs on |
|---|---|---|
| Node, deterministic | `agent-local.test.mjs` | the Agent's own answers through the real tool host and governance, on `agent/shop.mjs` (the boutique's truth as tool data) |
| In the app | `agent-app.test.mjs` | the boutique built in Chrome, asked on the Agent page; a second shop in the same database for isolation |
| Real provider | `agent-provider.eval.mjs` | each case straight into the provider loop, called exactly as the agent Edge Function calls it (`supabase/functions/agent/core.js`) |

The provider path's plumbing and scoring are proven without a key by `agent-provider-plumbing.test.mjs`, which uses a local stand-in for the Messages API.

The categories are:
- **facts**: true figures, and the right route or tools.
- **security**: declined, nothing claimed, nothing changed.
- **injection**: instructions hidden in a customer's name are never obeyed.
- **roles**: the role policy as written, plus questions asked under each role.
- **tenancy**: nothing of another shop appears.

A figure the tools never gave counts as a hallucination. A sum or difference of two given figures is accepted as derived.

To add a case, append it to the right list in `datasets.mjs` with an `expect`:
- `route`: the Agent's own route, such as `'sales'` or `'tool:open_bill'`;
- `tools`: what a provider may call;
- `facts`: paths into the truth, numbers or texts;
- `refuse`;
- `forbidAmounts` / `forbidText`.

When the answer depends on new data, update both `agent/shop.mjs` and the fixture's truth.

## Scenario suites (`tests/e2e`)

- **`sync-scenarios.test.mjs`**: offline sales, offline UPI (never shown as verified), a save whose answer is lost (no duplicate), 503s and an unreachable server, two tills offline at once (distinct bill numbers), the same customer edited on both tills (both changes kept), an offline return, a double tap on Pay, and every device converging.
- **`vercel-site.test.mjs`**: what Vercel serves. Exactly the files of `dist/site` (`siteFiles` in `scripts/sw-cache.mjs`), with `vercel.json`'s headers, on its own port (3219), Supabase blocked (`config.js` names the live project). The shop app, the receipt, order and store pages and the Platform Console open with no Content-Security-Policy violation, page error or missing file, and the service worker installs every file under the committed cache name. The other browser suites load the repository through a test page with a loosened policy, so they can't see any of this.
- **`responsive-matrix.test.mjs`**: 33 screens, sheets and forms on four sizes. `SHOTS=1` also saves a picture of each one (`tests/.artifacts/rm-<size>-<screen>.png`) to look at by eye.
- **`custom-fields.test.mjs`**: an owner with no template for their products (LED grow lights, a rug sold by the square foot) does everything without a code change:
  - makes fields and a unit in Settings;
  - adds products whose variants come from a field;
  - imports a sheet with a column the shop had no field for, and exports the catalog;
  - sells, renames a choice and archives a field.

  Each step is checked in the database, and the new screens on a phone. The rules are in `tests/unit/attributes.test.mjs`, `product-import-fields.test.mjs` and `shop-fields-sync.test.mjs`; the database in `supabase/tests/custom-fields.test.mjs`.

To add a scenario, open devices with `startShop` / `openDevice`, seed with `seedShop`, and drive the network with `device.net`. Check what the server holds (`S.sql`) and what a freshly downloaded device shows.
