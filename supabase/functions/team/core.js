// team: the shop's team — staff accounts (members), their roles, and the devices they may use the shop from. Plain ES
// module with Web Crypto only (no Deno or Node APIs), so the unit tests import it directly (tests/unit/team.test.mjs);
// index.ts stays thin.
//
// Rules:
// - Only the shop's owner manages the team. The database says who that is (hangtag_role() = 'owner'), never the request.
// - A staff account signs in as `${username}.${shopCode}@staff.hangtag.invalid` (staffEmail): an address that can never
//   receive mail, so nothing is ever sent to it. The shop code is the first 10 hex digits of the shop id.
// - Enrollment tokens (in the QR) and device keys are 32 random bytes each. Only their SHA-256 hashes are stored: the
//   token lives in the QR for 10 minutes and is used once; the key lives only on the device.
// - A member signed in with a password may register the phone it is on only while that sign-in is fresh (10 minutes), was
//   made after the owner last reset its access, switched it off or revoked one of its phones, and only when the owner gave
//   it a password (a QR-only member joins phones by QR).
// - Disabling a member or resetting its access revokes every device it has and ends its sign-ins; a revoked device stays
//   revoked. Resetting without a new password still replaces the old one (with one nobody knows).

/* Every permission, and the permissions of each role when the shop hasn't changed them. The same lists as
   src/domain/shop/permissions.js and public.hangtag_default_permissions() in supabase/schema.sql (section 3i). */
export const PERMISSIONS = ["view_products", "manage_products", "manage_inventory", "create_purchase", "create_sale", "apply_discount",
  "view_reports", "perform_return", "collect_credit", "manage_users", "manage_devices", "manage_tables", "create_order",
  "send_to_kitchen", "manage_kitchen", "manage_settings"];
export const ROLE_DEFAULTS = {
  owner: [...PERMISSIONS],
  manager: PERMISSIONS.filter((p) => p !== "manage_users" && p !== "manage_devices"),
  cashier: ["view_products", "create_sale", "apply_discount", "perform_return", "collect_credit", "create_order", "send_to_kitchen", "manage_tables"],
  server: ["view_products", "create_order", "send_to_kitchen", "manage_tables"],
  kitchen: ["manage_kitchen"],
};
/* Roles a member can have (the owner is never a member) */
export const ROLES = ["manager", "cashier", "server", "kitchen"];
export const STATUSES = ["active", "disabled"];
export const LIMITS = { name: 80, deviceName: 60, platform: 40, passwordMin: 8, passwordMax: 72, members: 50, devicesPerMember: 10, enrollMinutes: 10, freshMinutes: 10 };
export const STAFF_DOMAIN = "staff.hangtag.invalid";
/* How long a disabled member's account is banned: 100 years (lifted when the member is enabled again) */
export const BAN_FOREVER = "876000h";

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const fail = (status, error, message) => ({ ok: false, status, error, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const USERNAME = /^[a-z0-9._-]{3,30}$/;

/* The shop code staff type when they sign in: the first 10 hex digits of the shop id */
export const shopCode = (shopId) => str(shopId).replace(/-/g, "").toLowerCase().slice(0, 10);
/* The sign-in address of a staff account (never receives mail) */
export const staffEmail = (username, code) => `${username}.${code}@${STAFF_DOMAIN}`;
export const cleanUsername = (u) => str(u).trim().toLowerCase();
const cleanName = (v, max) => str(v).replace(/\s+/g, " ").trim().slice(0, max + 1);
const plainText = (v, max) => str(v).replace(/[^\p{L}\p{N} ._()'/-]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);

function name(v, what = "name") {
  const n = cleanName(v, LIMITS.name);
  if (!n) return fail(422, "bad_name", `The ${what} is missing.`);
  if (n.length > LIMITS.name) return fail(422, "bad_name", `The ${what} can be at most ${LIMITS.name} characters.`);
  return { ok: true, value: n };
}
function password(v) {
  if (v == null || v === "") return { ok: true, value: null };
  const p = str(v);
  if (p.length < LIMITS.passwordMin || p.length > LIMITS.passwordMax) return fail(422, "bad_password", `The password needs ${LIMITS.passwordMin} to ${LIMITS.passwordMax} characters.`);
  return { ok: true, value: p };
}
function device(body) {
  const n = cleanName(body.device_name, LIMITS.deviceName);
  if (!n) return fail(422, "bad_device", "Give this phone a name.");
  if (n.length > LIMITS.deviceName) return fail(422, "bad_device", `A device name can be at most ${LIMITS.deviceName} characters.`);
  return { ok: true, deviceName: n, platform: plainText(body.platform, LIMITS.platform) || null };
}
const userId = (body) => (UUID.test(str(body.user_id).trim()) ? str(body.user_id).trim().toLowerCase() : "");

/* body → { ok, action, ... } or a failure { ok: false, status, error, message }. Only these fields are read. */
export function validateRequest(body) {
  if (!body || typeof body !== "object") return fail(400, "bad_request", "Send the request as JSON.");
  const a = body.action;
  if (a === "create_member") {
    const n = name(body.name); if (!n.ok) return n;
    const username = cleanUsername(body.username);
    if (!USERNAME.test(username)) return fail(422, "bad_username", "A username has 3 to 30 letters, digits, dots, dashes or underscores.");
    if (!ROLES.includes(body.role)) return fail(422, "bad_role", "Choose a role: " + ROLES.join(", ") + ".");
    const pw = password(body.password); if (!pw.ok) return pw;
    return { ok: true, action: a, name: n.value, username, role: body.role, password: pw.value };
  }
  if (a === "update_member") {
    const id = userId(body); if (!id) return fail(400, "bad_request", "Which team member? The id is missing.");
    const out = { ok: true, action: a, userId: id };
    if (body.name !== undefined) { const n = name(body.name); if (!n.ok) return n; out.name = n.value; }
    if (body.role !== undefined) { if (!ROLES.includes(body.role)) return fail(422, "bad_role", "Choose a role: " + ROLES.join(", ") + "."); out.role = body.role; }
    if (body.status !== undefined) { if (!STATUSES.includes(body.status)) return fail(422, "bad_status", "The status is active or disabled."); out.status = body.status; }
    if (!("name" in out) && !("role" in out) && !("status" in out)) return fail(400, "bad_request", "Nothing to change.");
    return out;
  }
  if (a === "reset_access") {
    const id = userId(body); if (!id) return fail(400, "bad_request", "Which team member? The id is missing.");
    const pw = password(body.password); if (!pw.ok) return pw;
    return { ok: true, action: a, userId: id, password: pw.value };
  }
  if (a === "remove_member" || a === "enroll_start") {
    const id = userId(body); if (!id) return fail(400, "bad_request", "Which team member? The id is missing.");
    return { ok: true, action: a, userId: id };
  }
  if (a === "enroll_redeem") {
    const token = str(body.token).trim();
    if (!TOKEN.test(token)) return fail(400, "bad_token", "This QR code isn't a Hangtag sign-in code.");
    const d = device(body); if (!d.ok) return d;
    return { ok: true, action: a, token, deviceName: d.deviceName, platform: d.platform };
  }
  if (a === "register_device") {
    const d = device(body); if (!d.ok) return d;
    return { ok: true, action: a, deviceName: d.deviceName, platform: d.platform };
  }
  if (a === "revoke_device" || a === "remove_device") {
    const id = str(body.device_id).trim();
    if (!DEVICE_ID.test(id)) return fail(400, "bad_request", "Which device? The id is missing.");
    return { ok: true, action: a, deviceId: id };
  }
  return fail(400, "bad_request", "Unknown action.");
}

/* Random bytes as base64url (no padding) */
export function randomToken(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/* The QR's single-use enrollment token, a device key, a device id, and a password nobody knows (a member added for
   QR sign-in only) */
export const newToken = () => randomToken(32);
export const newDeviceKey = () => randomToken(32);
export const newDeviceId = () => randomToken(12);
export const newPassword = () => randomToken(24);
/* SHA-256 of the text as lowercase hex: the same as the database's encode(sha256(convert_to(text, 'UTF8')), 'hex') */
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str(text)));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* The claims of a JWT (the Authorization header or the token itself), without checking it: only for a token the auth
   server has already accepted (getUser) */
export function jwtClaims(auth) {
  const t = str(auth).replace(/^Bearer\s+/i, "").trim().split(".");
  if (t.length !== 3) return null;
  try {
    const b = t[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent([...atob(b + "=".repeat((4 - (b.length % 4)) % 4))].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
    const c = JSON.parse(json);
    return c && typeof c === "object" ? c : null;
  } catch { return null; }
}
/* When the person signed in with a password (seconds), or null: the token's "password" sign-in method (amr). A refreshed
   token keeps the time of the sign-in itself; a QR or link sign-in has no password entry; when the token was issued (iat)
   says nothing about a sign-in. */
export function passwordSignInAt(claims) {
  const amr = claims && Array.isArray(claims.amr) ? claims.amr : [];
  const e = amr.find((a) => a && a.method === "password" && Number.isFinite(+a.timestamp));
  return e ? +e.timestamp : null;
}
/* A password sign-in within the last 10 minutes (and not from the future), made after `after` (the owner's last reset,
   switch-off or revoke for this member: an ISO time or ms; none = no limit) */
export function freshSession(claims, nowMs, { minutes = LIMITS.freshMinutes, after = null } = {}) {
  const t = passwordSignInAt(claims);
  if (t == null) return false;
  const age = nowMs / 1000 - t, limit = typeof after === "number" ? after : after ? Date.parse(after) : NaN;
  if (age < -60 || age > minutes * 60) return false;
  return !(Number.isFinite(limit) && t * 1000 <= limit);
}
/* The latest of several times (ISO strings or null) as ms, or null */
export const latest = (...times) => { const ms = times.map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite); return ms.length ? Math.max(...ms) : null; };

/* Rows the function writes (the service role; the database checks them again). changed_by / created_by name who did it
   (the owner, or the member adding its own phone), for the audit log: the service role has no auth.uid(). */
export const memberRow = ({ userId: id, shopId, name: n, username, role, createdBy, passwordSignin = false }) =>
  ({ user_id: id, shop_id: shopId, name: n, username, role, status: "active", created_by: createdBy || null, password_signin: !!passwordSignin });
export const deviceRow = ({ shopId, userId: id, deviceId, deviceName, platform, keyHash, changedBy }) =>
  ({ owner_id: shopId, id: deviceId, user_id: id, name: deviceName, platform: platform || null, status: "active", key_hash: keyHash, changed_by: changedBy || null });
export const enrollmentRow = ({ shopId, userId: id, tokenHash, createdBy }) =>
  ({ owner_id: shopId, user_id: id, token_hash: tokenHash, created_by: createdBy || null });
/* The change that revokes devices (by: who did it) */
export const revokePatch = (now, by) => ({ status: "revoked", revoked_at: new Date(now).toISOString(), ...(by ? { changed_by: by } : {}) });
/* The member's access was reset (or a phone of theirs revoked): a phone can be added again only with a later password sign-in */
export const accessResetPatch = (now, by) => ({ access_reset_at: new Date(now).toISOString(), ...(by ? { changed_by: by } : {}) });

/* Can this enrollment token still be used? */
export function redeemable(row, nowMs) {
  if (!row) return fail(404, "bad_token", "This QR code isn't valid. Ask the owner for a new one.");
  if (row.used_at) return fail(410, "used", "This QR code was used already. Ask the owner for a new one.");
  if (!(Date.parse(row.expires_at) > nowMs)) return fail(410, "expired", "This QR code has expired. Ask the owner for a new one.");
  return { ok: true };
}

/* A member as the app sees it */
export const publicMember = (m) => (m ? { user_id: m.user_id, name: m.name, username: m.username, role: m.role, status: m.status,
  created_at: m.created_at || null, last_seen_at: m.last_seen_at || null } : null);
