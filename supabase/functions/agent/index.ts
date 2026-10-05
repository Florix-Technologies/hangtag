// Supabase Edge Function "agent": the Hangtag Agent's optional AI provider, for the signed-in shop.
// - The provider's key lives only in this function's secrets (ANTHROPIC_API_KEY; AGENT_MODEL optional);
//   AGENT_ALLOWED_USERS says who may use it (unset = off, like PAYMENT_ALLOWED_USERS).
// - Stateless: each "step" sends the question, the tools the app offers (only those in core.js ALLOWED_TOOLS) and the
//   conversation so far; the answer is either tool calls for the app to run on the device, or the final text. The
//   function reads no shop data and writes nothing.
// - Who: the owner, or a team member with view_reports (hangtag_can, with the phone's x-hangtag-device key forwarded).
// Deploy with JWT verification on (the default).
import { createClient } from "npm:@supabase/supabase-js@2";
import { agentConfig, allowedToUse, anthropicRequest, configView, rateDecision, rateLimits, readAnthropic, validateRequest } from "./core.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  const auth = req.headers.get("Authorization");
  if (!auth) return reply(401, { ok: false, error: "unauthorized", message: "Sign in first." });
  const env = Deno.env.toObject();
  const url = env.SUPABASE_URL, anon = env.SUPABASE_ANON_KEY, service = env.SUPABASE_SERVICE_ROLE_KEY;
  const device = req.headers.get("x-hangtag-device");
  const db = createClient(url, anon, { global: { headers: { Authorization: auth, ...(device ? { "x-hangtag-device": device } : {}) } }, auth: { persistSession: false } });
  const { data: who } = await db.auth.getUser();
  const user = who && who.user;
  if (!user) return reply(401, { ok: false, error: "unauthorized", message: "Sign in again." });

  let body: unknown;
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_request", message: "Send the request as JSON." }); }
  const r = validateRequest(body);
  if (!r.ok) return reply(r.status, { ok: false, error: r.error, message: r.message });

  // the shop this account works for (an owner's own, or a team member's from an enrolled phone)
  const { data: shopData, error: shopErr } = await db.rpc("hangtag_shop_id");
  if (shopErr && shopErr.code !== "PGRST202") { console.error("agent: couldn't read the shop:", shopErr.message); return reply(503, { ok: false, error: "server_error", message: "Try again." }); }
  const shopId: string | null = shopErr ? user.id : shopData;
  if (!shopId) return reply(403, { ok: false, error: "forbidden", message: "This account isn't part of a shop." });
  if (shopId !== user.id) {
    const { data: can } = await db.rpc("hangtag_can", { p: "view_reports" });
    if (can !== true) return reply(403, { ok: false, error: "forbidden", message: "Your role can't use the Hangtag Agent." });
  }
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const owner = shopId === user.id ? user : ((await admin.auth.admin.getUserById(shopId)).data || { user: null }).user;
  const cfg = agentConfig(env), allowed = allowedToUse(user, env, owner);
  if (r.action === "config") return reply(200, configView(cfg, allowed));
  if (!cfg || !allowed) return reply(503, { ok: false, error: "not_configured", message: "The Hangtag Agent's AI isn't set up for this shop." });

  // the server-side rate limit, per user and per shop (counted only for requests that go ahead; refused before any
  // provider call). If the limit can't be checked, nothing is sent: the limit protects the provider's cost.
  const { data: take, error: takeErr } = await admin.rpc("hangtag_agent_take", { p_user: user.id, p_shop: shopId, ...rateLimits(env) });
  if (takeErr) { console.error("agent: rate limit unavailable:", takeErr.code); return reply(503, { ok: false, error: "server_error", message: "The Hangtag Agent can't answer right now. Try again later." }); }
  const limit = rateDecision(take);
  if (!limit.ok) return reply(429, limit.body, limit.headers);

  const call = anthropicRequest(cfg, r);
  let res: Response;
  try { res = await fetch(call.url, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) }); }
  catch { return reply(502, { ok: false, error: "provider_error", message: "The AI service couldn't be reached. Try again." }); }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("agent: provider answered", res.status, json && json.error && json.error.type);
    return reply(502, { ok: false, error: "provider_error", message: res.status === 429 ? "The AI service is busy. Try again in a minute." : "The AI service didn't answer. Try again." });
  }
  const out = readAnthropic(json, r.tools.map((t: { name: string }) => t.name));
  if (out.type === "error") return reply(502, { ok: false, error: "provider_error", message: "The AI service's answer wasn't understood." });
  return reply(200, { ok: true, ...out });
});
