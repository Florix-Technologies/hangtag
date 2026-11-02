// The payment-webhook Edge Function's logic, in plain JS so it runs (and is tested) in Node as in Deno: index.ts only reads
// the request and makes the service-role client.
// - Each shop's own Razorpay account calls its own address: ?a=<the account's random hook id>. The notification is
//   checked with THAT account's webhook secret (opened from its sealed box) before its body is read as JSON; another
//   account's signature, a changed body or an unknown address is refused, and nothing is written.
// - Kept once per account and event (x-razorpay-event-id): the same notification again is answered "duplicate" and
//   changes nothing. A notification that couldn't be recorded is answered 500, so Razorpay sends it again.
// - Payments: only an intent of that account and shop is changed, through core.js nextIntent (idempotent; money for a
//   cancelled or expired intent, or of another amount, becomes an unmatched receipt). Refunds: the outcome is kept on the
//   return or the receipt it was made for.
import { accountsKey, eventIdOf, nextIntent, unseal, verifySignature, webhookTarget } from "../payment-gateway/core.js";

const out = (status, body) => ({ status, body });
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

/* req: { method, hookId (?a=), signature (X-Razorpay-Signature), eventId (X-Razorpay-Event-Id), text() → the raw body };
   deps: { env, admin() → the service-role client, now() → ms, log } */
export async function handleWebhook(req, { env, admin, now = () => Date.now(), log = console }) {
  if (req.method !== "POST") return out(405, { ok: false });
  const key = await accountsKey(env);
  if (!key) return out(503, { ok: false, error: "not_configured" });
  const hook = str(req.hookId);
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(hook)) return out(404, { ok: false, error: "unknown_account" });
  const raw = await req.text();
  if (raw.length > 200_000) return out(413, { ok: false, error: "too_large" });
  const sr = admin();
  const { data: acct, error: acctErr } = await sr.from("hangtag_payment_accounts").select("*").eq("hook_id", hook).maybeSingle();
  if (acctErr) { log.error("payment-webhook: couldn't read the account:", acctErr.message); return out(500, { ok: false }); }   // Razorpay retries
  if (!acct) return out(404, { ok: false, error: "unknown_account" });
  if (acct.status !== "connected") return out(410, { ok: false, error: "disconnected" });
  const secret = await unseal(key, acct.webhook_box, acct.id, "webhook");
  if (!secret || !(await verifySignature(raw, req.signature || "", secret))) return out(400, { ok: false, error: "bad_signature" });
  let event;
  try { event = JSON.parse(raw); } catch { return out(400, { ok: false, error: "bad_request" }); }
  const t = now(), at = new Date(t).toISOString(), shop = acct.owner_id;
  const eventId = await eventIdOf(req.eventId, raw);
  const target = webhookTarget(event, t);
  // the notification is claimed first: the same one again (or at the same moment) finds it taken
  const E = () => sr.from("hangtag_payment_events");
  const { data: claimed, error: claimErr } = await E().upsert({ owner_id: shop, account_id: acct.id, provider: "razorpay", event_id: eventId,
    event: str(event && event.event).slice(0, 60) || "unknown", outcome: "received", received_at: at }, { onConflict: "account_id,event_id", ignoreDuplicates: true }).select("id");
  if (claimErr) { log.error("payment-webhook: couldn't record the notification:", claimErr.message); return out(500, { ok: false }); }
  if (!claimed || !claimed.length) return out(200, { ok: true, duplicate: true });
  const evId = claimed[0].id, note = (patch) => E().update(patch).eq("id", evId).eq("owner_id", shop);
  await sr.from("hangtag_payment_accounts").update({ last_event_at: at }).eq("owner_id", shop).eq("id", acct.id);
  try {
    if (!target) { await note({ outcome: "ignored" }); return out(200, { ok: true, ignored: true }); }
    if (target.kind === "refund") {
      // a refund this shop made through Hangtag: an unmatched receipt's, or a return's
      const i = await sr.from("hangtag_payment_intents").update({ refund_status: target.state, updated_at: at }).eq("owner_id", shop).eq("account_id", acct.id)
        .eq("refund_id", target.refundId).select("id");
      const rt = await sr.from("hangtag_returns").update({ provider_refund_status: target.state }).eq("owner_id", shop).eq("provider_refund_id", target.refundId).select("id");
      if (i.error || rt.error) throw new Error((i.error || rt.error).message);
      const hit = (i.data || []).length + (rt.data || []).length;
      await note({ outcome: hit ? "refund" : "ignored", refund_id: target.refundId.slice(0, 64), to_status: hit ? target.state : null, intent_id: (i.data || [])[0] ? i.data[0].id : null });
      return out(200, { ok: true, ...(hit ? { refund: target.state } : { ignored: true }) });
    }
    // only an intent of this account (and so of this shop)
    const { data: row, error: rowErr } = await sr.from("hangtag_payment_intents").select("*").eq("owner_id", shop).eq("account_id", acct.id)
      .eq("provider_intent_id", target.providerIntentId).maybeSingle();
    if (rowErr) throw new Error(rowErr.message);
    if (!row) { await note({ outcome: "ignored" }); return out(200, { ok: true, ignored: true }); }   // not one of Hangtag's (another integration's QR)
    const patch = nextIntent(row, target.view);
    if (!patch) { await note({ outcome: "unchanged", intent_id: row.id, from_status: row.status, to_status: row.status }); return out(200, { ok: true, unchanged: true }); }
    // only from the state it was read in: a status check that got there first wins, and the change is made once
    const { data: up, error: upErr } = await sr.from("hangtag_payment_intents").update({ ...patch, checked_at: at, updated_at: at })
      .eq("owner_id", shop).eq("id", row.id).eq("status", row.status).select("id");
    if (upErr) throw new Error(upErr.message);
    const changed = !!(up && up.length);
    await note({ outcome: changed ? "changed" : "unchanged", intent_id: row.id, from_status: row.status, to_status: changed ? patch.status : row.status });
    return out(200, { ok: true, status: changed ? patch.status : row.status, ...(changed ? {} : { unchanged: true }) });
  } catch (e) {
    // not recorded: forget the claim, so Razorpay's next try is processed
    await E().delete().eq("id", evId).eq("owner_id", shop);
    log.error("payment-webhook:", e instanceof Error ? e.message : e);
    return out(500, { ok: false });
  }
}
