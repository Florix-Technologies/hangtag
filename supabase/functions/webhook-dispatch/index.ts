// Supabase Edge Function "webhook-dispatch": sends the shop owners' outbound webhooks (schema.sql section 3r).
// - Runs on a schedule (Supabase cron / scheduled function, e.g. every minute) or when called with the dispatch secret.
//   It never runs for a browser: the caller must send `Authorization: Bearer <WEBHOOK_DISPATCH_SECRET>`.
// - It claims due deliveries (RPC hangtag_webhook_claim: a 2-minute lease, so a crashed run is retried), signs each body
//   with its endpoint's secret (core.js signature: HMAC-SHA256 over "<timestamp>.<body>"), POSTs it with a 10 s timeout,
//   and records the result (RPC hangtag_webhook_result): delivered, retried later with back-off, or failed for good.
// - The same event id goes out on every retry (receivers drop repeats); secrets are read here with the service role only.
// - Addresses that resolve to private, loopback or link-local networks are refused (no requests into Supabase's network).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by Supabase), WEBHOOK_DISPATCH_SECRET (set it yourself).
// Deploy with JWT verification off (the dispatch secret is the guard): supabase functions deploy webhook-dispatch --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { TIMEOUT_MS, afterAttempt, checkUrl, deliveryHeaders, eventBody, privateAddress, signature } from "./core.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function resolvesPrivate(host: string): Promise<boolean> {
  if (privateAddress(host)) return true;
  try {
    const [a, aaaa] = await Promise.all([Deno.resolveDns(host, "A").catch(() => []), Deno.resolveDns(host, "AAAA").catch(() => [])]);
    const all = [...a, ...aaaa] as string[];
    return !all.length || all.some((ip) => privateAddress(String(ip).toLowerCase()));
  } catch (_e) { return true; }
}

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const want = env.WEBHOOK_DISPATCH_SECRET || "";
  if (!want || (req.headers.get("authorization") || "") !== `Bearer ${want}`) return reply(401, { ok: false, error: "unauthorized" });
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return reply(503, { ok: false, error: "not_configured" });
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: due, error } = await db.rpc("hangtag_webhook_claim", { p_limit: 25 });
  if (error) return reply(500, { ok: false, error: "claim_failed", message: error.message });
  const results = [];
  for (const d of due || []) {
    let status = 0, err = "", refused = false;
    const u = checkUrl(d.url);
    if (u.error || await resolvesPrivate(new URL(d.url).hostname.replace(/^\[|\]$/g, ""))) {
      // an address that isn't (any more) on the public internet: never retried
      refused = true; err = u.error || "The address isn't on the public internet.";
    } else {
      const body = eventBody({ id: d.event_id, type: d.type, payload: d.payload, created_at: d.event_created_at });
      const ts = Math.floor(Date.now() / 1000), sig = await signature(d.secret, ts, body);
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const r = await fetch(d.url, { method: "POST", headers: deliveryHeaders({ id: d.event_id, type: d.type, timestamp: ts, sig }), body, redirect: "manual", signal: ctl.signal });
        status = r.status;
        if (status < 200 || status >= 300) err = `HTTP ${status}`;
        await r.body?.cancel();
      } catch (e) {
        err = e instanceof Error && e.name === "AbortError" ? "Timed out" : "Couldn't connect";
      } finally { clearTimeout(timer); }
    }
    const out: { status: string; retryIn?: number } = refused ? { status: "failed" } : afterAttempt(d.attempts, status);
    await db.rpc("hangtag_webhook_result", { p_delivery: d.delivery_id, p_status: out.status, p_http: status || null, p_error: err || null, p_retry_in: out.retryIn ?? null });
    results.push({ id: d.delivery_id, status: out.status });
  }
  return reply(200, { ok: true, sent: results.length, results });
});
