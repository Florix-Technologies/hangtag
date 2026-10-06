// The shop's Hangtag plan, checked by every Edge Function that does business work for a shop (the Agent, reading supplier
// bills, sending receipts, verified payments). A shop whose trial or plan has ended can't use them by calling them
// directly either: the app shows the lock screen, the database refuses the shop's writes (HT402), and these refuse with
// 402 before any provider call or write. A database without the plans update (schema.sql section 3t, so no
// hangtag_access_ok yet) has no plans to enforce: nothing is refused there. Pure: unit-tested in Node.
export const PLAN_ENDED = Object.freeze({ ok: false, error: "subscription_inactive", message: "This shop's Hangtag plan has ended. Renew it in Settings → Plans & Billing." });
const MISSING = ["PGRST202", "42883"];   // the function isn't there (the plans update isn't applied)

/* admin: a service-role Supabase client; shopId: the shop (its owner's id). → null (go ahead) or { status, body } */
export async function planGate(admin, shopId){
  let r;
  try{ r = await admin.rpc("hangtag_access_ok", { p_owner: shopId }); }
  catch{ return { status: 503, body: { ok: false, error: "server_error", message: "The shop's plan couldn't be checked. Try again." } }; }
  const { data, error } = r || {};
  if(error){
    if(MISSING.includes(error.code)) return null;
    return { status: 503, body: { ok: false, error: "server_error", message: "The shop's plan couldn't be checked. Try again." } };
  }
  return data === true ? null : { status: 402, body: PLAN_ENDED };
}
