// The payment-gateway Edge Function's logic, in plain JS so it runs (and is tested) in Node as in Deno: index.ts only
// reads the request and the secrets, makes the clients and adds the CORS headers.
// - Every payment is taken on the shop's OWN Razorpay account (connect: its keys, checked with Razorpay, then kept only
//   sealed); there are no Hangtag keys for shops' customers' payments. Without a connected account nothing is offered.
// - Intents are written only here and by ../payment-webhook (hangtag_payment_intents is read-only for the app; every new
//   one names the account it was made on). "verified" is written only from the provider's own record of the payment,
//   read with that account (core.js qrView / linkView / nextIntent), never because a QR was shown.
// - Actions: config · connect · disconnect · create · status · cancel · verify (match a UPI payment checked by hand) ·
//   refund_return (send a return's refund back onto the bill's verified payment, once) · unmatched · resolve.
// - A shop's team member takes payments for the shop: the shop is what the database says (hangtag_shop_id() with the
//   caller's session and device key, forwarded as x-hangtag-device), never the caller's own id; each action needs the
//   member's permission (core.js ACTION_PERMISSIONS). PAYMENT_ALLOWED_USERS names the shops a gateway is switched on
//   for (unset = off).
import { planGate } from "../_shared/plan-gate.js";
import { LIMITS, accountConfig, accountsKey, allowedToPay, apiUrl, basicAuth, checkKeys, configView, createLinkBody, createQrBody, expiresAt, intentReply,
  linkView, liveAllowed, matchManual, newHookId, nextIntent, permissionFor, qrView, refundState, reusable, seal, unseal, validateRequest } from "./core.js";

const out = (status, body) => ({ status, body });
const OFF = { ok: false, error: "not_configured", message: "Payments through a gateway aren't switched on for this shop." };
/* the database's answer "no such table / function" (this project's database doesn't have the shop payments migration) */
const missing = (e) => !!e && ["42P01", "PGRST205", "PGRST202", "42883"].includes(e.code);

/* req: { method, auth (the Authorization header or null), device (x-hangtag-device or null), json() → the body };
   deps: { env, userDb(auth, device) → a client AS the caller, admin() → the service-role client, fetch, now() → ms,
   newId() → a random id, log } */
export async function handlePayment(req, { env, userDb, admin, fetch: http = fetch, now = () => Date.now(), newId = () => crypto.randomUUID(), log = console }) {
  if (req.method !== "POST") return out(405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  if (!req.auth) return out(401, { ok: false, error: "unauthorized", message: "Sign in first." });
  // the caller's own session (and device key, for a team member): row security decides what it can read
  const db = userDb(req.auth, req.device);
  const { data: who } = await db.auth.getUser();
  const user = who && who.user;
  if (!user) return out(401, { ok: false, error: "unauthorized", message: "Sign in again." });

  let body;
  try { body = await req.json(); } catch { return out(400, { ok: false, error: "bad_request", message: "Send the request as JSON." }); }
  const r = validateRequest(body);
  if (!r.ok) return out(r.status, { ok: false, error: r.error, message: r.message });
  // the shop this account works for, as the database sees it: an owner's own account, or a team member's shop (only
  // from an enrolled device). Every intent and account below belongs to the shop, never to the caller's own id.
  const { data: shopData, error: shopErr } = await db.rpc("hangtag_shop_id");
  if (shopErr && shopErr.code !== "PGRST202") { log.error("payment-gateway: couldn't read the shop:", shopErr.message); return out(503, { ok: false, error: "server_error", message: "Try again." }); }
  const shopId = shopErr ? user.id : shopData;   // (PGRST202: a database without section 3i yet, where every account is its own shop)
  const sr = admin();
  const owner = !shopId ? null : shopId === user.id ? user : ((await sr.auth.admin.getUserById(shopId)).data || { user: null }).user;
  const allowed = !!shopId && allowedToPay(user, env, owner);
  const key = await accountsKey(env);
  const A = () => sr.from("hangtag_payment_accounts"), T = () => sr.from("hangtag_payment_intents");
  // the shop's connected account (read with the service role: no app account can read the table)
  const got = shopId ? await A().select("*").eq("owner_id", shopId).eq("status", "connected").maybeSingle() : { data: null, error: null };
  if (got.error && !missing(got.error)) { log.error("payment-gateway: couldn't read the account:", got.error.message); return out(503, { ok: false, error: "server_error", message: "Try again." }); }
  const migrated = !got.error, account = got.data || null;
  const may = async (p) => !p || shopId === user.id || (await db.rpc("hangtag_can", { p })).data === true;
  if (r.action === "config") {
    const manage = allowed && await may("manage_settings");
    return out(200, configView(account, { allowed, available: !!key && migrated, manage, supabaseUrl: env.SUPABASE_URL }));
  }
  if (!shopId || !allowed || !key || !migrated) return out(503, OFF);
  const shop = shopId;
  // the shop's Hangtag plan: a shop whose trial or plan has ended can't use this by calling it directly either
  const gate = await planGate(sr, shop);
  if (gate) return out(gate.status, gate.body);
  const need = permissionFor(r.action);
  if (shop !== user.id && need && !(await may(need))) return out(403, { ok: false, error: "forbidden", message: "This account isn't allowed to do that." });

  /* Razorpay with one account's keys */
  const call = async (cfg, path, init = {}) => {
    try {
      const res = await http(apiUrl(path), { ...init, headers: { Authorization: basicAuth(cfg), "Content-Type": "application/json", ...(init.headers || {}) } });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, json };
    } catch { return { ok: false, status: 0, json: { error: { description: "Razorpay couldn't be reached." } } }; }
  };
  const providerError = (x) => out(502, { ok: false, error: "provider_error", message: (x.json && x.json.error && x.json.error.description) || `Razorpay answered ${x.status}.` });
  /* an account's provider keys, opened, or null (disconnected, or its box doesn't open) */
  const opened = async (acct) => {
    if (!acct || acct.status !== "connected") return null;
    const secret = await unseal(key, acct.secret_box, acct.id, "secret");
    return secret ? accountConfig(acct, secret) : null;
  };
  /* the keys of the account an intent was made on (an intent from before accounts — none — is the connected one's only
     when it has no account at all: there are none, the migration came with this code) */
  const cfgFor = async (row) => {
    if (!row || !row.account_id) return null;
    if (account && row.account_id === account.id) return opened(account);
    const { data } = await A().select("*").eq("owner_id", shop).eq("id", row.account_id).maybeSingle();
    return opened(data);
  };
  const iso = (ms) => new Date(ms).toISOString();
  /* Asks Razorpay about an intent (with its own account) and saves what changed */
  const refresh = async (row) => {
    if (row.kind === "match") return row;
    const cfg = await cfgFor(row);
    if (!cfg) return row;
    let view;
    if (row.kind === "link") {
      const x = await call(cfg, "/payment_links/" + encodeURIComponent(row.provider_intent_id));
      if (!x.ok) return row;
      view = linkView(x.json, now());
    } else {
      const [q, p] = await Promise.all([call(cfg, "/payments/qr_codes/" + encodeURIComponent(row.provider_intent_id)),
        call(cfg, "/payments/qr_codes/" + encodeURIComponent(row.provider_intent_id) + "/payments")]);
      if (!q.ok) return row;
      view = qrView(q.json, p.ok && p.json && Array.isArray(p.json.items) ? p.json.items : [], now());
    }
    const patch = nextIntent(row, view), at = iso(now());
    if (!patch) { await T().update({ checked_at: at }).eq("id", row.id).eq("owner_id", shop); return row; }
    // only from the state it was read in: a webhook that got there first wins, and the change is made once
    const { data } = await T().update({ ...patch, checked_at: at, updated_at: at }).eq("id", row.id).eq("owner_id", shop).eq("status", row.status).select("*").maybeSingle();
    if (data) return data;
    const again = await T().select("*").eq("id", row.id).eq("owner_id", shop).maybeSingle();
    return again.data || row;
  };
  const own = async (id) => (await T().select("*").eq("id", id).eq("owner_id", shop).maybeSingle()).data;
  /* Disconnects an account: what is still open on it is closed at the provider first (nobody pays a QR the shop can no
     longer check), then its secrets are dropped. → null when done, else the reply */
  const disconnect = async (acct) => {
    const cfg = await opened(acct);
    const { data: open } = await T().select("*").eq("owner_id", shop).eq("account_id", acct.id).in("status", ["pending", "created"]);
    for (const row of open || []) {
      if (cfg) {
        const pid = encodeURIComponent(row.provider_intent_id);
        await (row.kind === "link" ? call(cfg, "/payment_links/" + pid + "/cancel", { method: "POST" }) : call(cfg, "/payments/qr_codes/" + pid + "/close", { method: "POST" }));
      }
      const seen = await refresh(row);     // paid just before the close? then it's verified, not cancelled
      if (seen.status === "pending" || seen.status === "created")
        await T().update({ status: "cancelled", updated_at: iso(now()) }).eq("id", row.id).eq("owner_id", shop).eq("status", seen.status);
    }
    const at = iso(now());
    const { error } = await A().update({ status: "disconnected", secret_box: null, webhook_box: null, disconnected_at: at, updated_at: at }).eq("owner_id", shop).eq("id", acct.id);
    if (error) { log.error("payment-gateway: couldn't disconnect:", error.message); return out(503, { ok: false, error: "server_error", message: "The account couldn't be disconnected. Try again." }); }
    return null;
  };

  try {
    if (r.action === "connect") {
      const k = checkKeys(r, liveAllowed(env));
      if (!k.ok) return out(k.status, { ok: false, error: k.error, message: k.message });
      // Razorpay accepts the keys? (one payment read: changes nothing at the provider)
      const probe = await call({ id: k.keyId, secret: k.keySecret }, "/payments?count=1");
      if (probe.status === 401 || probe.status === 403)
        return out(422, { ok: false, error: "keys_refused", message: "Razorpay didn't accept these keys. Copy the Key Id and Key Secret again from Razorpay → Account & Settings → API Keys." });
      if (!probe.ok) return providerError(probe);
      if (account) { const d = await disconnect(account); if (d) return d; }   // the account connected before, if any
      const id = newId(), at = iso(now());
      const row = { id, owner_id: shop, provider: "razorpay", mode: k.mode, key_id: k.keyId, secret_box: await seal(key, k.keySecret, id, "secret"),
        webhook_box: await seal(key, k.webhookSecret, id, "webhook"), hook_id: newHookId(), status: "connected", card_link: true, checked_at: at,
        connected_by: user.id, created_at: at, updated_at: at };
      const { error } = await A().insert(row);
      if (error) { log.error("payment-gateway: couldn't save the account:", error.message); return out(503, { ok: false, error: "server_error", message: "The account couldn't be connected. Try again." }); }
      return out(200, configView(row, { allowed, available: true, manage: true, supabaseUrl: env.SUPABASE_URL }));
    }
    if (r.action === "disconnect") {
      if (account) { const d = await disconnect(account); if (d) return d; }
      return out(200, configView(null, { allowed, available: true, manage: true, supabaseUrl: env.SUPABASE_URL }));
    }
    /* a new payment, or a match with Razorpay's payments, needs the shop's connected account (what was taken on an
       account before — its status, its unmatched money settled by hand — doesn't) */
    const current = async () => {
      if (!account) return { reply: out(503, { ok: false, error: "not_configured", message: "Connect your Razorpay account first (Settings → Payments & Banks)." }) };
      const c = await opened(account);
      if (c) return { cfg: c };
      log.error("payment-gateway: the connected account's keys don't open (PAYMENT_ACCOUNTS_KEY changed?)");
      return { reply: out(503, { ok: false, error: "not_configured", message: "Connect your Razorpay account again (Settings → Payments & Banks)." }) };
    };

    if (r.action === "create") {
      const cur = await current();
      if (cur.reply) return cur.reply;
      const cfg = cur.cfg;
      // the same bill part asked for again while its QR / link is still open: that one, never a second one to pay
      const { data: open } = await T().select("*").eq("owner_id", shop).eq("account_id", account.id).eq("client_sale_id", r.saleId).eq("method", r.method)
        .in("status", ["pending", "created"]).order("created_at", { ascending: false }).limit(5);
      const again = (open || []).find((x) => reusable(x, { accountId: account.id, saleId: r.saleId, method: r.method, amount: r.amount }, now()));
      if (again) return out(200, intentReply(await refresh(again)));
      const since = iso(now() - 3600_000);
      const { count } = await T().select("id", { count: "exact", head: true }).eq("owner_id", shop).gte("created_at", since);
      if (count != null && count >= LIMITS.perHour) return out(429, { ok: false, error: "rate_limited", message: "Too many payment requests in the last hour." });
      if (r.method === "card" && !cfg.cardLink) return out(422, { ok: false, error: "bad_method", message: "Card payment links are off for this account." });
      const id = newId(), t0 = now(), until = expiresAt(r.method, r.expiryMin, t0);
      const x = r.method === "upi"
        ? await call(cfg, "/payments/qr_codes", { method: "POST", body: JSON.stringify(createQrBody({ amount: r.amount, note: r.note, closeBy: until, intentId: id, saleId: r.saleId })) })
        : await call(cfg, "/payment_links", { method: "POST", body: JSON.stringify(createLinkBody({ amount: r.amount, note: r.note, expireBy: until, intentId: id, saleId: r.saleId })) });
      if (!x.ok || !x.json || !x.json.id) return providerError(x);
      const row = { id, owner_id: shop, account_id: account.id, client_sale_id: r.saleId, amount: r.amount, method: r.method, kind: r.method === "upi" ? "qr" : "link",
        provider: "razorpay", provider_intent_id: String(x.json.id), reference: String(x.json.id), status: "pending",
        qr_url: r.method === "upi" ? x.json.image_url || null : null, link_url: r.method === "card" ? x.json.short_url || null : null,
        expires_at: iso(until), created_at: iso(t0) };
      const { error } = await T().insert(row);
      if (error) {
        // not recorded: close it at the provider, so nobody can pay a QR Hangtag doesn't know
        await (row.kind === "link" ? call(cfg, "/payment_links/" + encodeURIComponent(row.provider_intent_id) + "/cancel", { method: "POST" })
          : call(cfg, "/payments/qr_codes/" + encodeURIComponent(row.provider_intent_id) + "/close", { method: "POST" }));
        log.error("payment-gateway: couldn't save the intent:", error.message);
        return out(503, { ok: false, error: "server_error", message: "The payment couldn't be started. Try again." });
      }
      return out(200, intentReply(row));
    }
    if (r.action === "status") {
      const row = await own(r.id);
      if (!row) return out(404, { ok: false, error: "not_found", message: "That payment wasn't found." });
      return out(200, intentReply(row.status === "pending" || row.status === "created" ? await refresh(row) : row));
    }
    if (r.action === "cancel") {
      const row = await own(r.id);
      if (!row) return out(404, { ok: false, error: "not_found", message: "That payment wasn't found." });
      if (row.status === "pending" || row.status === "created") {
        const c = await cfgFor(row), pid = encodeURIComponent(row.provider_intent_id);
        if (c) await (row.kind === "link" ? call(c, "/payment_links/" + pid + "/cancel", { method: "POST" }) : call(c, "/payments/qr_codes/" + pid + "/close", { method: "POST" }));
        const seen = await refresh(row);     // paid just before the close? then it's verified, not cancelled
        if (seen.status === "pending" || seen.status === "created") {
          const { data } = await T().update({ status: "cancelled", updated_at: iso(now()) }).eq("id", row.id).eq("owner_id", shop).eq("status", seen.status).select("*").maybeSingle();
          return out(200, intentReply(data || seen));
        }
        return out(200, intentReply(seen));
      }
      return out(200, intentReply(row));
    }
    if (r.action === "verify") {
      const cur = await current();
      if (cur.reply) return cur.reply;
      const cfg = cur.cfg;
      // the payment as saved in the cloud (with the caller's session): a UPI part checked by hand
      const { data: pay } = await db.from("hangtag_payments").select("id,sale_id,method,amount,reference,verification,t").eq("id", r.paymentId).maybeSingle();
      if (!pay) return out(404, { ok: false, error: "not_found", message: "That bill isn't in the cloud yet." });
      if (pay.verification === "verified") return out(200, { ok: true, status: "verified", paymentId: null });
      if (pay.method !== "upi") return out(422, { ok: false, error: "bad_request", message: "Only UPI payments can be verified this way." });
      const from = Math.floor(+pay.t / 1000) - 6 * 3600, to = Math.floor(+pay.t / 1000) + 6 * 3600;
      let found = null;
      for (let skip = 0; skip < 300 && !found; skip += 100) {
        const x = await call(cfg, `/payments?from=${from}&to=${to}&count=100&skip=${skip}`);
        if (!x.ok) return providerError(x);
        const items = Array.isArray(x.json.items) ? x.json.items : [];
        found = matchManual(items, { amount: pay.amount, reference: r.reference || pay.reference });
        if (items.length < 100) break;
      }
      if (!found) return out(200, { ok: true, status: "not_found" });
      const id = newId(), at = iso(now());
      const ins = await T().insert({ id, owner_id: shop, account_id: account.id, client_sale_id: pay.sale_id, amount: pay.amount, method: "upi", kind: "match", provider: "razorpay",
        provider_intent_id: String(found.id), provider_payment_id: String(found.id), reference: String(found.id), status: "verified",
        paid_amount: +found.amount / 100, ...(found.fee != null && Number.isFinite(+found.fee) && +found.fee >= 0 ? { provider_fee: Math.round(+found.fee) / 100 } : {}), checked_at: at });
      if (ins.error) return out(409, { ok: false, error: "conflict", message: "That UPI payment is already matched to another bill." });
      const up = await sr.from("hangtag_payments").update({ verification: "verified", intent_id: id, provider_payment_id: String(found.id) }).eq("owner_id", shop).eq("id", pay.id);
      if (up.error) { await T().delete().eq("id", id).eq("owner_id", shop); log.error("payment-gateway: verify:", up.error.message); return out(503, { ok: false, error: "server_error", message: "Couldn't save the verification." }); }
      return out(200, { ok: true, status: "verified", paymentId: String(found.id), intentId: id });
    }
    if (r.action === "refund_return") {
      // the return and its bill's verified payment as saved in the cloud (the caller's own rows)
      const { data: ret } = await db.from("hangtag_returns").select("id,sale_id,refund_amount,refund_method,provider_refund_id").eq("id", r.returnId).maybeSingle();
      if (!ret) return out(404, { ok: false, error: "not_found", message: "That return isn't in the cloud yet. Try again once it has uploaded." });
      if (ret.provider_refund_id) return out(200, { ok: true, status: "refunded", refundId: ret.provider_refund_id, already: true });
      if (!(+ret.refund_amount > 0) || !["upi", "card"].includes(ret.refund_method)) return out(422, { ok: false, error: "bad_request", message: "This return has no UPI or card refund." });
      const { data: pay } = await db.from("hangtag_payments").select("provider_payment_id,verification,amount,intent_id").eq("sale_id", ret.sale_id).eq("method", ret.refund_method).maybeSingle();
      if (!pay || pay.verification !== "verified" || !pay.provider_payment_id) return out(422, { ok: false, error: "bad_request", message: "The bill wasn't paid through the payment provider, so refund it by hand." });
      if (+ret.refund_amount > +pay.amount) return out(422, { ok: false, error: "bad_request", message: "The refund is more than was paid this way." });
      // the refund goes back through the account that took the payment
      const c = await cfgFor(pay.intent_id ? await own(pay.intent_id) : null);
      if (!c) return out(422, { ok: false, error: "account_disconnected", message: "The Razorpay account that took this payment isn't connected any more: refund it from your Razorpay dashboard." });
      // the return is claimed before the provider is asked, so two taps (or two phones) can't refund it twice; a refund
      // the provider refuses releases it
      const claim = "pending:" + newId();
      const cl = await sr.from("hangtag_returns").update({ provider_refund_id: claim, provider_refund_status: "pending" }).eq("owner_id", shop).eq("id", ret.id)
        .is("provider_refund_id", null).select("id");
      if (cl.error) { log.error("payment-gateway: couldn't claim the refund:", cl.error.message); return out(503, { ok: false, error: "server_error", message: "Try again." }); }
      if (!cl.data || !cl.data.length) {
        const { data: now2 } = await sr.from("hangtag_returns").select("provider_refund_id").eq("owner_id", shop).eq("id", ret.id).maybeSingle();
        return out(200, { ok: true, status: "refunded", refundId: (now2 && now2.provider_refund_id) || null, already: true });
      }
      const x = await call(c, "/payments/" + encodeURIComponent(pay.provider_payment_id) + "/refund", { method: "POST", body: JSON.stringify({ amount: Math.round(+ret.refund_amount * 100), notes: { return_id: ret.id } }) });
      if (!x.ok || !x.json || !x.json.id) {
        await sr.from("hangtag_returns").update({ provider_refund_id: null, provider_refund_status: null }).eq("owner_id", shop).eq("id", ret.id).eq("provider_refund_id", claim);
        return providerError(x);
      }
      const { error } = await sr.from("hangtag_returns").update({ provider_refund_id: String(x.json.id), provider_refund_status: refundState(x.json.status) })
        .eq("owner_id", shop).eq("id", ret.id).eq("provider_refund_id", claim);
      if (error) log.error("payment-gateway: couldn't keep the refund id:", error.message);
      return out(200, { ok: true, status: "refunded", refundId: String(x.json.id), refundStatus: refundState(x.json.status) });
    }
    if (r.action === "unmatched") {
      const { data } = await T().select("*").eq("owner_id", shop).eq("status", "unmatched").order("created_at", { ascending: false }).limit(100);
      // verified money that no bill has used 30 minutes on (the sale was abandoned) is listed too
      const since = iso(now() - 30 * 60_000);
      const { data: ver } = await T().select("*").eq("owner_id", shop).eq("status", "verified").neq("kind", "match").lt("created_at", since).order("created_at", { ascending: false }).limit(100);
      const ids = (ver || []).map((x) => x.id);
      const { data: used } = ids.length ? await sr.from("hangtag_payments").select("intent_id").eq("owner_id", shop).in("intent_id", ids) : { data: [] };
      const taken = new Set((used || []).map((x) => x.intent_id));
      return out(200, { ok: true, items: [...(data || []), ...(ver || []).filter((x) => !taken.has(x.id))].map(intentReply) });
    }
    if (r.action === "resolve") {
      const row = await own(r.id);
      if (!row || (row.status !== "unmatched" && row.status !== "verified")) return out(404, { ok: false, error: "not_found", message: "That receipt wasn't found." });
      if (row.status === "verified") {
        const { data: onBill } = await sr.from("hangtag_payments").select("id").eq("owner_id", shop).eq("intent_id", row.id).limit(1);
        if ((onBill || []).length) return out(409, { ok: false, error: "conflict", message: "That payment is on a bill already." });
      }
      if ((row.resolution && row.resolution !== "open") || row.refund_id) return out(200, intentReply(row));
      let refundId = null, refundStatus = null, claim = null;
      if (r.resolution === "refund") {
        if (!row.provider_payment_id) return out(422, { ok: false, error: "bad_request", message: "This receipt has no provider payment to refund." });
        const c = await cfgFor(row);
        if (!c) return out(422, { ok: false, error: "account_disconnected", message: "The Razorpay account that took this payment isn't connected any more: refund it from your Razorpay dashboard." });
        // claimed first, as a return's refund is: one refund however often it is asked for
        claim = "pending:" + newId();
        const { data: cl } = await T().update({ refund_id: claim, refund_status: "pending", updated_at: iso(now()) }).eq("id", row.id).eq("owner_id", shop)
          .eq("resolution", "open").is("refund_id", null).select("id");
        if (!cl || !cl.length) return out(200, intentReply((await own(row.id)) || row));
        const x = await call(c, "/payments/" + encodeURIComponent(row.provider_payment_id) + "/refund", { method: "POST", body: JSON.stringify({ amount: Math.round(+row.paid_amount * 100), notes: { intent_id: row.id } }) });
        if (!x.ok || !x.json || !x.json.id) {
          await T().update({ refund_id: null, refund_status: null }).eq("id", row.id).eq("owner_id", shop).eq("refund_id", claim);
          return providerError(x);
        }
        refundId = String(x.json.id); refundStatus = refundState(x.json.status);
      }
      const at = iso(now()), done = T().update({ status: "unmatched", resolution: r.resolution === "allocated" ? "allocated" : "refunded", resolution_note: r.note || null,
        refund_id: refundId, refund_status: refundStatus, resolved_at: at, updated_at: at }).eq("id", row.id).eq("owner_id", shop).eq("resolution", "open");
      const { data } = await (claim ? done.eq("refund_id", claim) : done.is("refund_id", null)).select("*").maybeSingle();
      return out(200, intentReply(data || (await own(row.id)) || row));
    }
    return out(400, { ok: false, error: "bad_request", message: "Unknown action." });
  } catch (e) {
    log.error("payment-gateway:", e instanceof Error ? e.message : e);
    return out(500, { ok: false, error: "server_error", message: "The payment check failed. Try again." });
  }
}
