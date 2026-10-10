// Supabase Edge Function "extract-bill": reads a supplier bill (PDF or photo) and returns its product lines for review.
// The Anthropic API key lives only here, as a function secret (ANTHROPIC_API_KEY) - never in the app.
// Deploy with JWT verification on (the default): only signed-in Hangtag users can call it.
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { planGate } from "../_shared/plan-gate.js";
import { extractRateLimits, rateSubject, validateUpload } from "./core.js";
import { rateDecision } from "../agent/core.js";
import { createClaudeProvider } from "./providers/claude.js";
import { createMockProvider } from "./providers/mock.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function provider() {
  const name = (Deno.env.get("EXTRACT_PROVIDER") || "claude").toLowerCase();
  if (name === "mock") return createMockProvider();
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return null;
  return createClaudeProvider(new Anthropic(), { model: Deno.env.get("EXTRACT_MODEL") || undefined });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  const auth = req.headers.get("Authorization");
  if (!auth) return reply(401, { ok: false, error: "unauthorized", message: "Sign in first." });
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: who } = await db.auth.getUser();
  const user = who && who.user;
  if (!user) return reply(401, { ok: false, error: "unauthorized", message: "Sign in again." });
  const { data: shopData, error: shopErr } = await db.rpc("hangtag_shop_id");
  const shopId: string | null = shopErr ? user.id : shopData;   // (PGRST202: a database without section 3i, where every account is its own shop)
  if (!shopId) return reply(403, { ok: false, error: "forbidden", message: "This account isn't connected to a shop." });
  const admin = createClient(url, service, { auth: { persistSession: false } });
  // the shop's Hangtag plan: a shop whose trial or plan has ended can't use this by calling it directly either
  const gate = await planGate(admin, shopId);
  if (gate) return reply(gate.status, gate.body);
  let body: unknown;
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_request", message: "Send the bill as JSON." }); }
  const up = validateUpload(body);
  if (!up.ok) return reply(up.status, { ok: false, error: up.error, message: up.message });
  const p = provider();
  if (!p) return reply(503, { ok: false, error: "not_configured", message: "Reading bills isn't set up yet (no API key on the server)." });
  // the rate limit, per user and per shop, before the paid AI service is called (counted only for requests that go ahead);
  // if it can't be checked, nothing is sent: the limit protects the provider's cost
  const { data: take, error: takeErr } = await admin.rpc("hangtag_agent_take", { p_user: await rateSubject(user.id), p_shop: await rateSubject(shopId),
    ...extractRateLimits(Deno.env.toObject()) });
  if (takeErr) { console.error("extract-bill: rate limit unavailable:", takeErr.code); return reply(503, { ok: false, error: "busy", message: "Reading bills isn't available right now. Try again later." }); }
  const limit = rateDecision(take);
  if (!limit.ok) return new Response(JSON.stringify(limit.body), { status: 429, headers: { ...CORS, "Content-Type": "application/json", ...limit.headers } });
  try {
    const r = await p.extract({ data: up.data, mimeType: up.mimeType, fileName: up.fileName });
    if (!r.ok) return reply(r.status, { ok: false, error: r.error, message: r.message });
    return reply(200, r.result);
  } catch (e) {
    // typed SDK errors: rate limits and overload are worth retrying; anything else is reported plainly (no file content logged)
    const status = e instanceof Anthropic.APIError ? e.status : undefined;
    console.error("extract-bill failed:", status ?? "", e instanceof Error ? e.message : String(e));
    if (e instanceof Anthropic.RateLimitError || status === 529) return reply(503, { ok: false, error: "busy", message: "The reading service is busy. Try again in a minute." });
    return reply(502, { ok: false, error: "provider_error", message: "The bill couldn't be read right now. Try again, or enter the lines by hand." });
  }
});
