// Supabase Edge Function "receipt": the public view of ONE bill behind a secure invoice link (hangtag_invoice_links),
// for receipt.html. The token is the only key: a wrong, revoked or expired token all get the same "not found", and the
// answer holds just that bill's figures, the shop's details and logo — nothing else of the shop.
// The page calls it with the project's publishable key, so deploy it WITHOUT JWT verification:
//   supabase functions deploy receipt --no-verify-jwt
// Views are counted on the link. The figures come from the saved bill (send-receipt/core.js billView): nothing is
// recalculated here.
import { createClient } from "npm:@supabase/supabase-js@2";
import { ITEM_COLUMNS, PAYMENT_COLUMNS, PROFILE_COLUMNS, RETURN_COLUMNS, SALE_COLUMNS, billView, liveLink } from "../send-receipt/core.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const gone = () => reply(404, { ok: false, error: "not_found", message: "This invoice link isn't valid any more. Ask the shop for a new one." });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" });
  let body: { token?: unknown };
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_request" }); }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return gone();
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: link } = await admin.from("hangtag_invoice_links").select("token,owner_id,sale_id,expires_at,revoked_at,views").eq("token", token).maybeSingle();
  if (!liveLink(link)) return gone();
  const own = (t: string) => admin.from(t).select("*").eq("owner_id", link.owner_id);
  const { data: sale } = await admin.from("hangtag_sales").select(SALE_COLUMNS).eq("owner_id", link.owner_id).eq("id", link.sale_id).maybeSingle();
  if (!sale) return gone();
  const [items, payments, profile, customer, logo, rets, settings] = await Promise.all([
    admin.from("hangtag_sale_items").select(ITEM_COLUMNS).eq("owner_id", link.owner_id).eq("sale_id", sale.id).order("line_no").limit(500),
    admin.from("hangtag_payments").select(PAYMENT_COLUMNS).eq("owner_id", link.owner_id).eq("sale_id", sale.id).order("id"),
    admin.from("hangtag_profiles").select(PROFILE_COLUMNS).eq("id", link.owner_id).maybeSingle(),
    sale.customer_id ? admin.from("hangtag_customers").select("name").eq("owner_id", link.owner_id).eq("id", sale.customer_id).maybeSingle() : Promise.resolve({ data: null }),
    own("hangtag_meta").eq("key", "logo").maybeSingle(),
    admin.from("hangtag_returns").select(RETURN_COLUMNS).eq("owner_id", link.owner_id).eq("sale_id", sale.id).limit(100),
    own("hangtag_meta").eq("key", "settings").maybeSingle(),
  ]);
  if (items.error || payments.error) { console.error("receipt: couldn't read the bill:", (items.error || payments.error)!.message); return reply(503, { ok: false, error: "unavailable" }); }
  await admin.from("hangtag_invoice_links").update({ views: (link.views || 0) + 1, last_viewed_at: new Date().toISOString() }).eq("token", token);
  const data = (logo as { data?: { value?: { data?: string } } }).data;
  const logoUrl = data && data.value && typeof data.value.data === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(data.value.data) ? data.value.data : null;
  // the shop's region (settings.region): the invoice in its currency and time zone, as its messages are (India when not set)
  const sv = (settings as { data?: { value?: { region?: unknown } } }).data, region = sv && sv.value && typeof sv.value.region === "string" ? sv.value.region : "IN";
  return reply(200, { ok: true, bill: billView({ sale, items: items.data || [], payments: payments.data || [], returns: (rets as { data?: unknown[] }).data || [], shop: profile.data || {}, customer: customer.data, region }),
    cancelled: !!sale.is_void, logo: logoUrl, expiresAt: link.expires_at });
});
