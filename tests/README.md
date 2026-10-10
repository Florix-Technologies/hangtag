# Hangtag tests and evaluations

Every suite is a plain Node script that prints `PASS …` / `FAIL …` lines and exits non-zero on failure.
`node tests/run.mjs <folders or files>` runs them and prints a summary: unit and database suites side by side (`TEST_JOBS`), browser suites one at a time, each file stopped after `TEST_TIMEOUT_MS` (20 minutes).

| Command | What runs |
|---|---|
| `npm test` | everything below except the real-provider evaluation |
| `npm run test:unit` | `tests/unit` — pure rules and services in Node |
| `npm run test:db` | `supabase/tests` — the real `schema.sql` in PGlite (row security, RPCs, triggers, the check report) |
| `npm run test:eval` | `tests/eval` — the Agent evaluations (Node and in-app) |
| `npm run test:e2e` | `tests/e2e` — the app in Chrome against PGlite behind a PostgREST stand-in |
| `npm run eval:agent:provider` | the Agent against a **real** AI provider (needs `HANGTAG_EVAL_ANTHROPIC_KEY`; costs money; skipped without a key) |

Browser suites need Chrome, Chromium or Edge (found where Windows, macOS or Linux installs it, or set `CHROME_PATH`) and serve the app on `localhost:3210`. Without a browser they are reported as skipped, not failed (`TEST_STRICT=1` fails instead).

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
- **`responsive-matrix.test.mjs`**: 33 screens, sheets and forms on four sizes. `SHOTS=1` also saves a picture of each one (`tests/.artifacts/rm-<size>-<screen>.png`) to look at by eye.

To add a scenario, open devices with `startShop` / `openDevice`, seed with `seedShop`, and drive the network with `device.net`. Check what the server holds (`S.sql`) and what a freshly downloaded device shows.
