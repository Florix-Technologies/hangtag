# agent (Supabase Edge Function)

The **Hangtag Agent's optional AI provider**. Without it the Agent still answers everyday questions by itself, from the
shop's data on the device (sales, profit, payments, dues, stock, reorders, orders, GST, bills …). With it, questions the
Agent doesn't recognise go to an AI model that may only use the Agent's tools.

- **Keys stay here.** `ANTHROPIC_API_KEY` is a secret of this function, never in the app. `AGENT_MODEL` (optional,
  default `claude-opus-5-5`), `AGENT_MAX_TOKENS` (optional, 256–4096, default 1024).
- **Who may use it:** `AGENT_ALLOWED_USERS` — user ids or emails, comma-separated, or `*` for everyone. Unset = off
  (an AI provider costs money). A team member is allowed when listed or when the shop's owner is, and needs
  `view_reports` (checked with `hangtag_can`, from an enrolled phone).
- **The tools are the boundary** (`core.js` `ALLOWED_TOOLS`, the same names as `src/domain/agent/agent-tools.js`):
  11 read tools (today's sales, the trend, low stock, what to reorder, customer dues, recent bills, payment
  reconciliation, orders, gross profit, GST, the business profile), 4 open tools (a bill, product, customer or report
  — shown only after the person taps) and 2 draft tools (a reorder list, a purchase order — saved only when the person
  confirms, as a draft, never sent). There is no tool for SQL, sending, payments, stock, prices or deleting.
- **The function reads no shop data.** The tools run on the shop's device with the person's role
  (`src/features/assistant/services/agent-tools.js`); the app sends the model the question and the tool results it
  needs (figures, names of customers or products where the question needs them). The model is told to use only those
  figures and to say so when it can't tell.
- **Stateless:** `{ action: "config" }` → `{ available, provider, model }`; `{ action: "step", question, tools,
  transcript }` → `{ type: "tool_calls", calls }` or `{ type: "answer", text }`. Calls to tools that weren't offered
  are dropped. Limits in `core.js` `LIMITS`.

- **Rate limit (server-side):** after the allow-list and role checks and before any provider call, the function counts
  the request in the database (`hangtag_agent_take`, schema.sql section 3t, service role only — the app can't call or reset
  it): per person per minute (`AGENT_RATE_PER_MINUTE`, default 10) and per day (`AGENT_RATE_PER_DAY`, 200), per shop per
  minute (`AGENT_SHOP_RATE_PER_MINUTE`, 30) and per day (`AGENT_SHOP_RATE_PER_DAY`, 600); `0` switches a window off.
  Over a limit → HTTP 429 `{ ok: false, error: "rate_limited", limit, retry_after, message }` with a `Retry-After` header.
  A refused request isn't counted, so it never extends the wait; another person or shop is never affected. If the limit
  can't be checked (e.g. the migration isn't applied yet) nothing is sent to the provider.

Deploy (JWT verification on, the default):

```
supabase functions deploy agent
supabase secrets set ANTHROPIC_API_KEY=… AGENT_ALLOWED_USERS=owner@example.com   # optional: AGENT_MODEL, AGENT_RATE_PER_MINUTE …
```

Unit tests (Node, no network): `tests/unit/agent.test.mjs`, `tests/unit/agent-rate-limit.test.mjs`; the counting: `supabase/tests/agent-rate.test.mjs`.
