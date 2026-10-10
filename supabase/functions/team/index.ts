// Supabase Edge Function "team": the shop owner's team — staff accounts, their roles, and the devices they may use.
// - Deployed with --no-verify-jwt, because a phone scanning an enrollment QR has no session yet. Every other action
//   checks the caller itself: a session the auth server accepts (getUser), and for managing the team, the database's
//   own answer that the caller is the shop's owner (hangtag_role() = 'owner' with the caller's session). A shop id or a
//   role in the request is never trusted.
// - Writes with the service role (members, devices and enrollment tokens are read-only for the app).
// - Actions: create_member · update_member · reset_access · remove_member · enroll_start (owner) · enroll_redeem (the new
//   phone, no session: token → device key + one-time sign-in) · register_device (a member just signed in with a
//   password) · revoke_device · remove_device (owner). See README.md.
// - Every change records who made it (changed_by / created_by: the owner, or the member adding its own phone), so the
//   audit log names a person although the service role writes. Reset, revoke and switch-off end the member's sign-ins
//   (hangtag_end_sessions) and move access_reset_at on: a phone is added again only after a later password sign-in.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { BAN_FOREVER, LIMITS, accessResetPatch, deviceRow, enrollmentRow, freshSession, jwtClaims, latest, memberRow, newDeviceId, newDeviceKey,
  newPassword, newToken, publicMember, redeemable, revokePatch, sha256Hex, shopCode, staffEmail, validateRequest } from "./core.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hangtag-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const refuse = (status: number, error: string, message: string) => reply(status, { ok: false, error, message });
const unavailable = () => refuse(503, "server_error", "The team couldn't be changed right now. Try again.");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return refuse(405, "method_not_allowed", "Use POST.");
  let body: unknown;
  try { body = await req.json(); } catch { return refuse(400, "bad_request", "Send the request as JSON."); }
  const r: any = validateRequest(body);
  if (!r.ok) return refuse(r.status, r.error, r.message);
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const members = () => admin.from("hangtag_members");
  const devices = () => admin.from("hangtag_devices");
  const memberOf = async (shopId: string, userId: string) =>
    (await members().select("*").eq("shop_id", shopId).eq("user_id", userId).maybeSingle()).data;
  const activeDevices = async (shopId: string, userId: string) => {
    const { count, error } = await devices().select("id", { count: "exact", head: true }).eq("owner_id", shopId).eq("user_id", userId).eq("status", "active");
    return error || count == null ? null : count;
  };
  /* A new device for a member: the key is returned once and only its hash is kept */
  const addDevice = async (m: any, r: any) => {
    const n = await activeDevices(m.shop_id, m.user_id);
    if (n == null) return { error: unavailable() };
    if (n >= LIMITS.devicesPerMember) return { error: refuse(409, "too_many_devices", `This person has ${n} devices already. Remove one in Settings → Team & Devices first.`) };
    const deviceId = newDeviceId(), key = newDeviceKey();
    const { error } = await devices().insert(deviceRow({ shopId: m.shop_id, userId: m.user_id, deviceId, deviceName: r.deviceName, platform: r.platform,
      keyHash: await sha256Hex(key), changedBy: m.user_id }));
    if (error) { console.error("team: couldn't add the device:", error.message); return { error: unavailable() }; }
    return { deviceId, key };
  };
  const shopName = async (shopId: string) => (await admin.from("hangtag_profiles").select("shop_name").eq("id", shopId).maybeSingle()).data?.shop_name || null;
  const revokeAll = async (shopId: string, userId: string, by: string) =>
    devices().update(revokePatch(Date.now(), by)).eq("owner_id", shopId).eq("user_id", userId).eq("status", "active").select("id");
  /* A member's access changed (reset, a phone revoked, switched off): note when, and end every sign-in it has, so no phone
     gets a new token (the database's own function; false when it can't: the revoked devices already reach nothing) */
  const accessReset = async (shopId: string, userId: string, by: string, extra: Record<string, unknown> = {}) => {
    const up = await members().update({ ...accessResetPatch(Date.now(), by), ...extra }).eq("shop_id", shopId).eq("user_id", userId);
    if (up.error) console.error("team: access reset:", up.error.message);
    const { data, error } = await admin.rpc("hangtag_end_sessions", { p_user: userId });
    if (error) console.error("team: end sessions:", error.message);
    return data === true;
  };

  try {
    // ---------- a new phone scans the owner's QR: no session yet, the single-use token is the key ----------
    if (r.action === "enroll_redeem") {
      const tokenHash = await sha256Hex(r.token), now = Date.now();
      const { data: row, error } = await admin.from("hangtag_enrollments").select("*").eq("token_hash", tokenHash).maybeSingle();
      if (error) { console.error("team: enrollment lookup:", error.message); return unavailable(); }
      const ok: any = redeemable(row, now);
      if (!ok.ok) return refuse(ok.status, ok.error, ok.message);
      const m = await memberOf(row.owner_id, row.user_id);
      if (!m || m.status !== "active") return refuse(403, "disabled", "This team member can't sign in. Ask the owner.");
      // used once, even when two phones scan the same code at the same moment
      const used = await admin.from("hangtag_enrollments").update({ used_at: new Date(now).toISOString() }).eq("id", row.id).is("used_at", null)
        .gt("expires_at", new Date(now).toISOString()).select("id").maybeSingle();
      if (used.error || !used.data) return refuse(410, "used", "This QR code was used already. Ask the owner for a new one.");
      const dev: any = await addDevice(m, r);
      if (dev.error) return dev.error;
      await admin.from("hangtag_enrollments").update({ device_id: dev.deviceId }).eq("id", row.id);
      const { data: au } = await admin.auth.admin.getUserById(m.user_id);
      const email = au && au.user && au.user.email;
      const link = email ? await admin.auth.admin.generateLink({ type: "magiclink", email }) : null;
      const hashed = link && !link.error && link.data && link.data.properties && link.data.properties.hashed_token;
      if (!hashed) {
        await devices().delete().eq("owner_id", m.shop_id).eq("id", dev.deviceId);
        console.error("team: couldn't make the sign-in link:", link && link.error && link.error.message);
        return unavailable();
      }
      return reply(200, { ok: true, token_hash: hashed, email, device_id: dev.deviceId, device_key: dev.key, shop_name: await shopName(m.shop_id),
        shop_code: shopCode(m.shop_id), role: m.role, name: m.name, username: m.username });
    }

    // ---------- everything else: a signed-in caller ----------
    const auth = req.headers.get("Authorization");
    if (!auth || !/^Bearer\s+\S+\.\S+\.\S+$/i.test(auth)) return refuse(401, "unauthorized", "Sign in first.");
    const deviceKey = req.headers.get("x-hangtag-device");
    const db = createClient(url, anon, { global: { headers: { Authorization: auth, ...(deviceKey ? { "x-hangtag-device": deviceKey } : {}) } },
      auth: { persistSession: false, autoRefreshToken: false } });
    const { data: who } = await db.auth.getUser();
    const user = who && who.user;
    if (!user) return refuse(401, "unauthorized", "Sign in again.");

    // a member who just signed in with a password adds the phone it is on: only a member the owner gave a password, with a
    // password sign-in of the last 10 minutes made after the owner last reset its access or revoked one of its phones
    if (r.action === "register_device") {
      const { data: m } = await members().select("*").eq("user_id", user.id).maybeSingle();
      if (!m) return refuse(403, "not_member", "Only team members add their phones here.");
      if (m.status !== "active") return refuse(403, "disabled", "This team member can't sign in. Ask the owner.");
      if (!m.password_signin) return refuse(403, "qr_only", "This team member signs in with a QR code from the owner.");
      const { data: rv, error: rvErr } = await devices().select("revoked_at").eq("owner_id", m.shop_id).eq("user_id", m.user_id).not("revoked_at", "is", null)
        .order("revoked_at", { ascending: false }).limit(1);
      if (rvErr) return unavailable();
      const after = latest(m.access_reset_at, rv && rv[0] && rv[0].revoked_at);
      if (!freshSession(jwtClaims(auth), Date.now(), { after })) return refuse(401, "stale_session", "Sign in again with your password to add this phone.");
      const dev: any = await addDevice(m, r);
      if (dev.error) return dev.error;
      return reply(200, { ok: true, device_id: dev.deviceId, device_key: dev.key, shop_name: await shopName(m.shop_id), shop_code: shopCode(m.shop_id),
        role: m.role, name: m.name, username: m.username });
    }

    // managing the team: the shop's owner only, as the database sees the caller
    const { data: role, error: roleErr } = await db.rpc("hangtag_role");
    if (roleErr) { console.error("team: role check:", roleErr.message); return unavailable(); }
    if (role !== "owner") return refuse(403, "forbidden", "Only the shop's owner can manage the team.");
    const shopId: string = user.id;

    if (r.action === "create_member") {
      const { count, error: countErr } = await members().select("user_id", { count: "exact", head: true }).eq("shop_id", shopId);
      if (countErr || count == null) return unavailable();
      if (count >= LIMITS.members) return refuse(409, "too_many_members", `A shop can have up to ${LIMITS.members} team members.`);
      const { data: taken } = await members().select("user_id").eq("shop_id", shopId).eq("username", r.username).maybeSingle();
      if (taken) return refuse(409, "username_taken", "That username is taken in this shop. Choose another.");
      const code = shopCode(shopId);
      const created = await admin.auth.admin.createUser({ email: staffEmail(r.username, code), password: r.password || newPassword(), email_confirm: true,
        user_metadata: { full_name: r.name, staff: true, shop_id: shopId } });
      const nu = created.data && created.data.user;
      if (created.error || !nu) {
        console.error("team: couldn't create the account:", created.error && created.error.message);
        return /already|exists|registered/i.test((created.error && created.error.message) || "") ? refuse(409, "username_taken", "That username is taken. Choose another.") : unavailable();
      }
      const ins = await members().insert(memberRow({ userId: nu.id, shopId, name: r.name, username: r.username, role: r.role, createdBy: user.id, passwordSignin: !!r.password }))
        .select("*").single();
      if (ins.error) {
        await admin.auth.admin.deleteUser(nu.id);   // no account without its member row
        console.error("team: couldn't add the member:", ins.error.message);
        return /duplicate|unique/i.test(ins.error.message) ? refuse(409, "username_taken", "That username is taken in this shop. Choose another.") : unavailable();
      }
      return reply(200, { ok: true, user_id: nu.id, shop_code: code, username: r.username, member: publicMember(ins.data) });
    }

    // the other actions name a member (or a device) of this shop
    if (r.action === "revoke_device" || r.action === "remove_device") {
      // who removes it: noted on the row first (the audit log reads the removed row)
      if (r.action === "remove_device") await devices().update({ changed_by: user.id }).eq("owner_id", shopId).eq("id", r.deviceId);
      const q = r.action === "revoke_device"
        ? devices().update(revokePatch(Date.now(), user.id)).eq("owner_id", shopId).eq("id", r.deviceId).eq("status", "active").select("id,user_id")
        : devices().delete().eq("owner_id", shopId).eq("id", r.deviceId).select("id,user_id");
      const { data, error } = await q;
      if (error) { console.error("team:", r.action, error.message); return unavailable(); }
      if (!(data || []).length) {
        // revoking a device that is revoked already is fine; one that isn't the shop's is not found
        const { data: there } = await devices().select("id").eq("owner_id", shopId).eq("id", r.deviceId).maybeSingle();
        if (!there || r.action === "remove_device") return refuse(404, "not_found", "That device wasn't found.");
        return reply(200, { ok: true, device_id: r.deviceId });
      }
      // a revoked phone's sign-in ends too (every sign-in of that member: the member's other phones sign in again)
      const ended = r.action === "revoke_device" ? await accessReset(shopId, data[0].user_id, user.id) : false;
      return reply(200, { ok: true, device_id: r.deviceId, sessions_ended: ended });
    }
    const m = await memberOf(shopId, r.userId);
    if (!m) return refuse(404, "not_found", "That team member wasn't found.");

    if (r.action === "update_member") {
      const patch: Record<string, string> = { changed_by: user.id };
      if (r.name !== undefined) patch.name = r.name;
      if (r.role !== undefined) patch.role = r.role;
      if (r.status !== undefined) patch.status = r.status;   // switched off: the database notes access_reset_at itself
      const up = await members().update(patch).eq("shop_id", shopId).eq("user_id", m.user_id).select("*").single();
      if (up.error) { console.error("team: update:", up.error.message); return unavailable(); }
      let revoked = 0, ended = false;
      if (r.status && r.status !== m.status) {
        const ban = await admin.auth.admin.updateUserById(m.user_id, { ban_duration: r.status === "disabled" ? BAN_FOREVER : "none" });
        if (ban.error) console.error("team: ban:", ban.error.message);   // the database already refuses a disabled member
        if (r.status === "disabled") {
          revoked = ((await revokeAll(shopId, m.user_id, user.id)).data || []).length;
          const { data } = await admin.rpc("hangtag_end_sessions", { p_user: m.user_id });
          ended = data === true;
        }
      }
      if (r.name !== undefined && r.name !== m.name) await admin.auth.admin.updateUserById(m.user_id, { user_metadata: { full_name: r.name, staff: true, shop_id: shopId } });
      return reply(200, { ok: true, member: publicMember(up.data), revoked, sessions_ended: ended });
    }
    if (r.action === "reset_access") {
      // the old password always stops working: the owner's new one, or one nobody knows (the member then joins by QR only)
      const pw = await admin.auth.admin.updateUserById(m.user_id, { password: r.password || newPassword() });
      if (pw.error) { console.error("team: password:", pw.error.message); return r.password ? refuse(422, "bad_password", "That password wasn't accepted. Try a longer one.") : unavailable(); }
      const { data, error } = await revokeAll(shopId, m.user_id, user.id);
      if (error) { console.error("team: revoke:", error.message); return unavailable(); }
      const ended = await accessReset(shopId, m.user_id, user.id, { password_signin: !!r.password });
      return reply(200, { ok: true, revoked: (data || []).length, password_changed: true, password_set: !!r.password, sessions_ended: ended });
    }
    if (r.action === "remove_member") {
      // who removes them: noted on the rows first (the audit log reads the removed rows)
      await members().update({ changed_by: user.id }).eq("shop_id", shopId).eq("user_id", m.user_id);
      await devices().update({ changed_by: user.id }).eq("owner_id", shopId).eq("user_id", m.user_id);
      const { error } = await admin.auth.admin.deleteUser(m.user_id);   // the member row, its devices and its sign-ins go with the account
      if (error) { console.error("team: remove:", error.message); return unavailable(); }
      return reply(200, { ok: true, user_id: m.user_id });
    }
    if (r.action === "enroll_start") {
      if (m.status !== "active") return refuse(409, "disabled", "Enable this team member first.");
      const token = newToken();
      await admin.from("hangtag_enrollments").delete().eq("owner_id", shopId).eq("user_id", m.user_id).is("used_at", null);   // one open code per member
      const { data, error } = await admin.from("hangtag_enrollments").insert(enrollmentRow({ shopId, userId: m.user_id, tokenHash: await sha256Hex(token), createdBy: user.id }))
        .select("expires_at").single();
      if (error || !data) { console.error("team: enroll:", error && error.message); return unavailable(); }
      return reply(200, { ok: true, token, expires_at: data.expires_at });
    }
    return refuse(400, "bad_request", "Unknown action.");
  } catch (e) {
    console.error("team:", e instanceof Error ? e.message : e);
    return unavailable();
  }
});
