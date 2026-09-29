// Supabase Edge Function "extract-bill": reads a supplier bill (PDF or photo) and returns its product lines for review.
// The Anthropic API key lives only here, as a function secret (ANTHROPIC_API_KEY) - never in the app.
// Deploy with JWT verification on (the default): only signed-in Hangtag users can call it.
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { validateUpload } from "./core.js";
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
  if (!req.headers.get("Authorization")) return reply(401, { ok: false, error: "unauthorized", message: "Sign in first." });
  let body: unknown;
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_request", message: "Send the bill as JSON." }); }
  const up = validateUpload(body);
  if (!up.ok) return reply(up.status, { ok: false, error: up.error, message: up.message });
  const p = provider();
  if (!p) return reply(503, { ok: false, error: "not_configured", message: "Reading bills isn't set up yet (no API key on the server)." });
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
