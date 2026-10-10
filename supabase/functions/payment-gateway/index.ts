// Supabase Edge Function "payment-gateway": UPI QR and card-link payments through Razorpay, for the signed-in shop.
// - Keys live only in this function's secrets (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET); PAYMENT_ALLOWED_USERS says who
//   may take provider payments (unset = off, like SEND_ALLOWED_USERS).
// - Intents are written only here (hangtag_payment_intents is read-only for the app). "verified" is written only from
//   the provider's own record of the payment (core.js qrView / linkView / nextIntent), never because a QR was shown.
// - Actions: config · create · status · cancel · verify (match a UPI payment checked by hand) · refund_return (send a
//   return's refund back onto the bill's verified payment, once) · unmatched · resolve.
// - A shop's team member takes payments for the shop: the shop is what the database says (hangtag_shop_id() with the
//   caller's session and device key, forwarded as x-hangtag-device), never the caller's own id; each action needs the
//   member's permission (core.js ACTION_PERMISSIONS).
// Deploy with JWT verification on (the default). Payments that arrive later are caught by ../payment-webhook as well.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { planGate } from "../_shared/plan-gate.js";
import { LIMITS, allowedToPay, apiUrl, basicAuth, configView, createLinkBody, createQrBody, expiresAt, intentReply, linkView,
  matchManual, nextIntent, permissionFor, qrView, razorpayConfig, validateRequest } from "./core.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const env = () => Deno.env.toObject();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  const auth = req.headers.get("Authorization");
  if (!auth) return reply(401, { ok: false, error: "unauthorized", message: "Sign in first." });
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // the caller's own session (and device key, for a team member): row security decides what it can read
  const device = req.headers.get("x-hangtag-device");
  const db = createClient(url, anon, { global: { headers: { Authorization: auth, ...(device ? { "x-hangtag-device": device } : {}) } }, auth: { persistSession: false } });
  const { data: who } = await db.auth.getUser();
  const user = who && who.user;
  if (!user) return reply(401, { ok: false, error: "unauthorized", message: "Sign in again." });

  let body: unknown;
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: "bad_request", message: "Send the request as JSON." }); }
  const r = validateRequest(body);
  if (!r.ok) return reply(r.status, { ok: false, error: r.error, message: r.message });
  // the shop this account works for, as the database sees it: an owner's own account, or a team member's shop (only
  // from an enrolled device). Every intent below belongs to the shop, never to the caller's own id.
  const { data: shopData, error: shopErr } = await db.rpc("hangtag_shop_id");
  if (shopErr && shopErr.code !== "PGRST202") { console.error("payment-gateway: couldn't read the shop:", shopErr.message); return reply(503, { ok: false, error: "server_error", message: "Try again." }); }
  const shopId: string | null = shopErr ? user.id : shopData;   // (PGRST202: a database without section 3i yet, where every account is its own shop)
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const owner = !shopId ? null : shopId === user.id ? user : ((await admin.auth.admin.getUserById(shopId)).data || { user: null }).user;
  const cfg = razorpayConfig(env()), allowed = !!shopId && allowedToPay(user, env(), owner);
  if (r.action === "config") return reply(200, configView(cfg, allowed));
  if (!cfg || !allowed || !shopId) return reply(503, { ok: false, error: "not_configured", message: "Verified payments aren't set up for this shop yet." });
  const shop: string = shopId;
  // the shop's Hangtag plan: a shop whose trial or plan has ended can't use this by calling it directly either
  const gate = await planGate(admin, shop);
  if (gate) return reply(gate.status, gate.body);
  const need = permissionFor(r.action);
  if (shop !== user.id && need) {
    const { data: can } = await db.rpc("hangtag_can", { p: need });
    if (can !== true) return reply(403, { ok: false, error: "forbidden", message: "This account isn't allowed to do that." });
  }
  const T = () => admin.from("hangtag_payment_intents");
  const rz = async (path: string, init: RequestInit = {}) => {
    try {
      const res = await fetch(apiUrl(path), { ...init, headers: { Authorization: basicAuth(cfg), "Content-Type": "application/json", ...(init.headers || {}) } });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, json };
    } catch { return { ok: false, status: 0, json: { error: { description: "Razorpay couldn't be reached." } } }; }
  };
  const providerError = (x: { json: any; status: number }) =>
    reply(502, { ok: false, error: "provider_error", message: (x.json && x.json.error && x.json.error.description) || `Razorpay answered ${x.status}.` });
  /* Asks Razorpay about an intent and saves what changed */
  const refresh = async (row: any) => {
    if (row.kind === "match") return row;
    let view;
    if (row.kind === "link") {
      const x = await rz("/payment_links/" + encodeURIComponent(row.provider_intent_id));
      if (!x.ok) return row;
      view = linkView(x.json);
    } else {
      const [q, p] = await Promise.all([rz("/payments/qr_codes/" + encodeURIComponent(row.provider_intent_id)),
        rz("/payments/qr_codes/" + encodeURIComponent(row.provider_intent_id) + "/payments")]);
      if (!q.ok) return row;
      view = qrView(q.json, p.ok && p.json && Array.isArray(p.json.items) ? p.json.items : []);
    }
    const patch = nextIntent(row, view), now = new Date().toISOString();
    if (!patch) { await T().update({ checked_at: now }).eq("id", row.id).eq("owner_id", shop); return row; }
    // only from the state it was read in: a webhook that got there first wins, and the change is made once
    const { data } = await T().update({ ...patch, checked_at: now, updated_at: now }).eq("id", row.id).eq("owner_id", shop).eq("status", row.status).select("*").maybeSingle();
    if (data) return data;
    const again = await T().select("*").eq("id", row.id).eq("owner_id", shop).maybeSingle();
    return again.data || row;
  };
  const own = async (id: string) => (await T().select("*").eq("id", id).eq("owner_id", shop).maybeSingle()).data;

  try {
    if (r.action === "create") {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const { count } = await T().select("id", { count: "exact", head: true }).eq("owner_id", shop).gte("created_at", since);
      if (count != null && count >= LIMITS.perHour) return reply(429, { ok: false, error: "rate_limited", message: "Too many payment requests in the last hour." });
      const id = crypto.randomUUID(), now = Date.now(), until = expiresAt(r.method, r.expiryMin, now);
      const x = r.method === "upi"
        ? await rz("/payments/qr_codes", { method: "POST", body: JSON.stringify(createQrBody({ amount: r.amount, note: r.note, closeBy: until, intentId: id, saleId: r.saleId })) })
        : await rz("/payment_links", { method: "POST", body: JSON.stringify(createLinkBody({ amount: r.amount, note: r.note, expireBy: until, intentId: id, saleId: r.saleId })) });
      if (!x.ok || !x.json || !x.json.id) return providerError(x);
      const row = { id, owner_id: shop, client_sale_id: r.saleId, amount: r.amount, method: r.method, kind: r.method === "upi" ? "qr" : "link",
        provider: cfg.name, provider_intent_id: String(x.json.id), reference: String(x.json.id), status: "pending",
        qr_url: r.method === "upi" ? x.json.image_url || null : null, link_url: r.method === "card" ? x.json.short_url || null : null,
        expires_at: new Date(until).toISOString() };
      const { error } = await T().insert(row);
      if (error) { console.error("payment-gateway: couldn't save the intent:", error.message); return reply(503, { ok: false, error: "server_error", message: "The payment couldn't be started. Try again." }); }
      return reply(200, intentReply({ ...row, created_at: new Date(now).toISOString() }));
    }
    if (r.action === "status") {
      const row = await own(r.id);
      if (!row) return reply(404, { ok: false, error: "not_found", message: "That payment wasn't found." });
      return reply(200, intentReply(row.status === "pending" || row.status === "created" ? await refresh(row) : row));
    }
    if (r.action === "cancel") {
      const row = await own(r.id);
      if (!row) return reply(404, { ok: false, error: "not_found", message: "That payment wasn't found." });
      if (row.status === "pending" || row.status === "created") {
        const pid = encodeURIComponent(row.provider_intent_id);
        await (row.kind === "link" ? rz("/payment_links/" + pid + "/cancel", { method: "POST" }) : rz("/payments/qr_codes/" + pid + "/close", { method: "POST" }));
        const seen = await refresh(row);     // paid just before the close? then it's verified, not cancelled
        if (seen.status === "pending" || seen.status === "created") {
          const { data } = await T().update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", row.id).eq("owner_id", shop).eq("status", seen.status).select("*").maybeSingle();
          return reply(200, intentReply(data || seen));
        }
        return reply(200, intentReply(seen));
      }
      return reply(200, intentReply(row));
    }
    if (r.action === "verify") {
      // the payment as saved in the cloud (with the caller's session): a UPI part checked by hand
      const { data: pay } = await db.from("hangtag_payments").select("id,sale_id,method,amount,reference,verification,t").eq("id", r.paymentId).maybeSingle();
      if (!pay) return reply(404, { ok: false, error: "not_found", message: "That bill isn't in the cloud yet." });
      if (pay.verification === "verified") return reply(200, { ok: true, status: "verified", paymentId: null });
      if (pay.method !== "upi") return reply(422, { ok: false, error: "bad_request", message: "Only UPI payments can be verified this way." });
      const from = Math.floor(+pay.t / 1000) - 6 * 3600, to = Math.floor(+pay.t / 1000) + 6 * 3600;
      let found = null;
      for (let skip = 0; skip < 300 && !found; skip += 100) {
        const x = await rz(`/payments?from=${from}&to=${to}&count=100&skip=${skip}`);
        if (!x.ok) return providerError(x);
        const items = Array.isArray(x.json.items) ? x.json.items : [];
        found = matchManual(items, { amount: pay.amount, reference: r.reference || pay.reference });
        if (items.length < 100) break;
      }
      if (!found) return reply(200, { ok: true, status: "not_found" });
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const ins = await T().insert({ id, owner_id: shop, client_sale_id: pay.sale_id, amount: pay.amount, method: "upi", kind: "match", provider: cfg.name,
        provider_intent_id: String(found.id), provider_payment_id: String(found.id), reference: String(found.id), status: "verified",
        paid_amount: +found.amount / 100, ...(found.fee != null && Number.isFinite(+found.fee) && +found.fee >= 0 ? { provider_fee: Math.round(+found.fee) / 100 } : {}), checked_at: now });
      if (ins.error) return reply(409, { ok: false, error: "conflict", message: "That UPI payment is already matched to another bill." });
      const up = await admin.from("hangtag_payments").update({ verification: "verified", intent_id: id, provider_payment_id: String(found.id) })
        .eq("owner_id", shop).eq("id", pay.id);
      if (up.error) { await T().delete().eq("id", id).eq("owner_id", shop); console.error("payment-gateway: verify:", up.error.message); return reply(503, { ok: false, error: "server_error", message: "Couldn't save the verification." }); }
      return reply(200, { ok: true, status: "verified", paymentId: String(found.id), intentId: id });
    }
    if (r.action === "refund_return") {
      // the return and its bill's verified payment as saved in the cloud (the caller's own rows)
      const { data: ret } = await db.from("hangtag_returns").select("id,sale_id,refund_amount,refund_method,provider_refund_id").eq("id", r.returnId).maybeSingle();
      if (!ret) return reply(404, { ok: false, error: "not_found", message: "That return isn't in the cloud yet. Try again once it has uploaded." });
      if (ret.provider_refund_id) return reply(200, { ok: true, status: "refunded", refundId: ret.provider_refund_id, already: true });
      if (!(+ret.refund_amount > 0) || !["upi", "card"].includes(ret.refund_method)) return reply(422, { ok: false, error: "bad_request", message: "This return has no UPI or card refund." });
      const { data: pay } = await db.from("hangtag_payments").select("provider_payment_id,verification,amount").eq("sale_id", ret.sale_id).eq("method", ret.refund_method).maybeSingle();
      if (!pay || pay.verification !== "verified" || !pay.provider_payment_id) return reply(422, { ok: false, error: "bad_request", message: "The bill wasn't paid through the payment provider, so refund it by hand." });
      if (+ret.refund_amount > +pay.amount) return reply(422, { ok: false, error: "bad_request", message: "The refund is more than was paid this way." });
      const x = await rz("/payments/" + encodeURIComponent(pay.provider_payment_id) + "/refund", { method: "POST", body: JSON.stringify({ amount: Math.round(+ret.refund_amount * 100), notes: { return_id: ret.id } }) });
      if (!x.ok || !x.json || !x.json.id) return providerError(x);
      const { error } = await admin.from("hangtag_returns").update({ provider_refund_id: String(x.json.id) }).eq("owner_id", shop).eq("id", ret.id).is("provider_refund_id", null);
      if (error) console.error("payment-gateway: couldn't keep the refund id:", error.message);
      return reply(200, { ok: true, status: "refunded", refundId: String(x.json.id) });
    }
    if (r.action === "unmatched") {
      const { data } = await T().select("*").eq("owner_id", shop).eq("status", "unmatched").order("created_at", { ascending: false }).limit(100);
      // verified money that no bill has used 30 minutes on (the sale was abandoned) is listed too
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      const { data: ver } = await T().select("*").eq("owner_id", shop).eq("status", "verified").neq("kind", "match").lt("created_at", since).order("created_at", { ascending: false }).limit(100);
      const ids = (ver || []).map((x: any) => x.id);
      const { data: used } = ids.length ? await admin.from("hangtag_payments").select("intent_id").eq("owner_id", shop).in("intent_id", ids) : { data: [] };
      const taken = new Set((used || []).map((x: any) => x.intent_id));
      return reply(200, { ok: true, items: [...(data || []), ...(ver || []).filter((x: any) => !taken.has(x.id))].map(intentReply) });
    }
    if (r.action === "resolve") {
      const row = await own(r.id);
      if (!row || (row.status !== "unmatched" && row.status !== "verified")) return reply(404, { ok: false, error: "not_found", message: "That receipt wasn't found." });
      if (row.status === "verified") {
        const { data: onBill } = await admin.from("hangtag_payments").select("id").eq("owner_id", shop).eq("intent_id", row.id).limit(1);
        if ((onBill || []).length) return reply(409, { ok: false, error: "conflict", message: "That payment is on a bill already." });
      }
      if (row.resolution && row.resolution !== "open") return reply(200, intentReply(row));
      let refundId = null;
      if (r.resolution === "refund") {
        if (!row.provider_payment_id) return reply(422, { ok: false, error: "bad_request", message: "This receipt has no provider payment to refund." });
        const x = await rz("/payments/" + encodeURIComponent(row.provider_payment_id) + "/refund", { method: "POST", body: JSON.stringify({ amount: Math.round(+row.paid_amount * 100), notes: { intent_id: row.id } }) });
        if (!x.ok || !x.json || !x.json.id) return providerError(x);
        refundId = String(x.json.id);
      }
      const { data } = await T().update({ status: "unmatched", resolution: r.resolution === "allocated" ? "allocated" : "refunded", resolution_note: r.note || null, refund_id: refundId,
        resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", row.id).eq("owner_id", shop).select("*").maybeSingle();
      return reply(200, intentReply(data || row));
    }
    return reply(400, { ok: false, error: "bad_request", message: "Unknown action." });
  } catch (e) {
    console.error("payment-gateway:", e instanceof Error ? e.message : e);
    return reply(500, { ok: false, error: "server_error", message: "The payment check failed. Try again." });
  }
});
