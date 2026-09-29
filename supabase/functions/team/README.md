# team (Supabase Edge Function)

The shop owner's **team**: staff accounts (members), their roles, and the phones they may use the shop from.

- `index.ts`: HTTP wrapper (Deno). Writes with the service role; members, devices and enrollment tokens are read-only
  for the app (`supabase/schema.sql` section 3i).
- `core.js`: request checks per action, the staff sign-in address and shop code, random tokens and device keys (Web
  Crypto), SHA-256, the "fresh sign-in" rule, the rows the function writes, and the default permissions of each role
  (the same lists as `public.hangtag_default_permissions()` and `src/domain/shop/permissions.js`). Unit-tested in
  Node: `tests/unit/team.test.mjs`.

## How the database keeps a member inside the shop

- The shop is the owner's account (every `owner_id` means "the shop"). A member is its own account with a row in
  `hangtag_members` (shop, name, username, role, status).
- `public.hangtag_shop_id()` gives a member its shop **only** while the member is `active` **and** the request carries
  the header `x-hangtag-device` whose SHA-256 matches one of the member's `active` devices. Otherwise it is `NULL`,
  and the member sees nothing and can change nothing. Row security on every table checks the shop and the role's
  permissions (`public.hangtag_can(...)`); the owner can do everything, exactly as before.
- So: disabling a member, revoking a device or resetting access takes effect on the very next request.

## Actions

Every request is `POST` JSON `{ action, ... }`. Only the fields below are read.

| Action | Who | Fields | Returns |
|---|---|---|---|
| `create_member` | owner | `name`, `username` (3–30 of `a-z 0-9 . _ -`), `role` (`manager`, `cashier`, `server`, `kitchen`), `password?` (8–72; without one the member signs in by QR only) | `user_id`, `shop_code`, `username`, `member` |
| `update_member` | owner | `user_id`, `name?`, `role?`, `status?` (`active` / `disabled`) | `member`, `revoked` (devices revoked when disabled), `sessions_ended` |
| `reset_access` | owner | `user_id`, `password?` | `revoked`, `password_changed` (always true), `password_set` (the owner chose one), `sessions_ended`: every device of the member is revoked and its sign-ins end; the old password stops working (without a new one the member joins by QR only) |
| `remove_member` | owner | `user_id` | the account is deleted; its member row and devices go with it |
| `enroll_start` | owner | `user_id` | `token`, `expires_at` (10 minutes, single use) |
| `enroll_redeem` | the new phone (no session) | `token`, `device_name`, `platform?` | `token_hash`, `email`, `device_id`, `device_key`, `shop_name`, `shop_code`, `role`, `name`, `username` |
| `register_device` | a member the owner gave a password, signed in **with that password** in the last 10 minutes and after the owner last reset its access, switched it off or revoked one of its phones | `device_name`, `platform?` | `device_id`, `device_key`, `shop_name`, `shop_code`, `role`, `name`, `username` |
| `revoke_device` | owner | `device_id` | a revoked device stays revoked (enroll the phone again); the member's sign-ins end (`sessions_ended`) |
| `remove_device` | owner | `device_id` | the device row is deleted |

"Owner" is decided by the database with the caller's own session (`hangtag_role()` = `'owner'`), never by the request.
Disabling bans the member's account (`ban_duration: 876000h`), revokes its devices and ends its sign-ins; enabling
lifts the ban (the member then needs a new QR or a password sign-in on each phone). A shop can have up to 50 members,
and a member up to 10 active devices.

Every change records who made it (`changed_by` on the member or device row, `created_by` for a new member): the audit
log (`hangtag_audit_log`) names the owner although the function writes with the service role, and names the member for
a phone it added itself.

## Staff sign-in

- A member's sign-in address is `<username>.<shop code>@staff.hangtag.invalid`, where the shop code is the first 10
  hex digits of the shop id (`core.js` `staffEmail`, `shopCode`). The `.invalid` domain can never receive mail, so no
  email is ever sent to a staff account. The account's `user_metadata` has `staff: true` and `shop_id` (hints for the
  app only: the database decides from `hangtag_members`).
- **By password on a new phone**: the app signs in with the staff address and password, then calls `register_device`
  with that fresh session and keeps the returned key. The JWT must carry a `password` sign-in (`amr`) of the last 10
  minutes (a token refresh keeps the sign-in's own time; `iat` doesn't count), made after the member's `access_reset_at`
  and after its latest revoked phone, and the owner must have given the member a password (`password_signin`).

## QR enrollment

1. The owner opens Settings → Team & Devices → the member → **Sign in a phone**. The app calls `enroll_start`; the
   function stores the SHA-256 of 32 random bytes (never the token itself) with a 10-minute expiry, replacing any
   unused code for that member.
2. The QR shows `<app url>#enroll=<token>`: only that single-use token. **Never a password, a service key or a
   long-lived token.** A photo of the QR is useless after 10 minutes or once it has been used.
3. The member's phone opens the link. The app calls `enroll_redeem` with the token and a name for the phone. The
   function checks the token (exists, unused, not expired, member active), marks it used (once, even if two phones
   race), creates the device with a new random key (only its hash is kept) and makes a one-time sign-in with
   `admin.generateLink({ type: 'magiclink' })`. No email is sent: the phone gets the link's `hashed_token`.
4. The app calls `auth.verifyOtp({ type: 'magiclink', token_hash })` (or `type: 'email'`) to sign in, stores the
   device key (`hangtag_device_key`, `hangtag_device_id`) and from then on sends it as `x-hangtag-device` on every
   request.

## Deploy

```bash
supabase functions deploy team --no-verify-jwt --project-ref <your-project-ref>
```

`--no-verify-jwt` is needed because a phone redeeming a QR has no session yet; the function checks every other
caller itself (`auth.getUser()` with the request's token, then the database's `hangtag_role()`). No secrets beyond
the defaults every Edge Function gets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Run
`supabase/schema.sql` first (section 3i makes the tables and functions).

The other functions called by staff phones (`send-receipt`, `payment-gateway`, `extract-bill`) accept the
`x-hangtag-device` header too; redeploy them after this change.

Notes:
- Supabase Auth must accept the `staff.hangtag.invalid` addresses for accounts made with the admin API (it does not
  send mail to them). If a project has strict email-domain checks, allow this domain.
- Ending a member's sign-ins: the auth admin API can't end another user's sessions by id, so the function calls the
  database's `hangtag_end_sessions(user)` (service role only), which deletes the member's rows in `auth.sessions` (their
  refresh tokens go with them). If the project doesn't let the database do that, the call answers `false`
  (`sessions_ended: false`) and the old sign-in stays until its access token expires (1 hour) — but it reaches nothing,
  because every device of the member is revoked (the database checks the device key on every request), and it can't add
  a phone: `register_device` needs a password sign-in made after the reset, and a QR-only member has no password. Also
  switch on **Secure password change** in Auth settings, so a leftover session can't set a new password. Switching a
  member off (a ban) always blocks new tokens.
