// The "teamService" port: the shop's team — members, their roles and permissions, and the phones they use.
// Changes go through the team Edge Function (it writes with the service role and decides from the database that the caller
// is the owner); reads and role permissions go through the cloud gateway (REST with row security: the owner reads the
// whole team, a member only itself). Answers use the app's names (camelCase); the function's replies are in its README.

const member = m => m ? ({ userId:m.user_id, name:m.name||"", username:m.username||"", role:m.role||"", status:m.status||"active",
  createdAt:m.created_at||null, lastSeenAt:m.last_seen_at||null }) : null;
/* What a phone gets when it joins the shop (enroll_redeem / register_device) */
const joined = r => ({ deviceId:r.device_id, deviceKey:r.device_key, shopName:r.shop_name||"", shopCode:r.shop_code||"", role:r.role||"",
  name:r.name||"", username:r.username||"" });

/* cloud: the cloud gateway (callFunction, touchDevice, fetchMembers, fetchDevices, fetchRoles, saveRole) */
export function createTeamClient({ cloud }){
  const call = body => cloud.callFunction("team", body, "Team access");
  return {
    /* { name, username, role, password? } → { userId, shopCode, username, member } (no password: the person signs in by QR) */
    createMember: ({ name, username, role, password }) => call({ action:"create_member", name, username, role, ...(password ? { password } : {}) })
      .then(r => ({ userId:r.user_id, shopCode:r.shop_code, username:r.username, member:member(r.member) })),
    /* { userId, name?, role?, status? } → { member, revoked } (disabling signs every phone of the member out) */
    updateMember: ({ userId, name, role, status }) => call({ action:"update_member", user_id:userId,
      ...(name !== undefined ? { name } : {}), ...(role !== undefined ? { role } : {}), ...(status !== undefined ? { status } : {}) })
      .then(r => ({ member:member(r.member), revoked:r.revoked || 0 })),
    /* Signs every phone of the member out and ends its sign-ins; the old password always stops working (the new one when
       given, else one nobody knows: the member joins by QR only) → { revoked, passwordSet, sessionsEnded } */
    resetAccess: ({ userId, password }) => call({ action:"reset_access", user_id:userId, ...(password ? { password } : {}) })
      .then(r => ({ revoked:r.revoked || 0, passwordSet:!!r.password_set, sessionsEnded:!!r.sessions_ended })),
    removeMember: userId => call({ action:"remove_member", user_id:userId }).then(() => ({ ok:true })),
    /* A single-use code for the enrollment QR, valid 10 minutes → { token, expiresAt (ms) } */
    enrollStart: userId => call({ action:"enroll_start", user_id:userId }).then(r => ({ token:r.token, expiresAt:Date.parse(r.expires_at) || Date.now() + 600e3 })),
    /* The new phone (no session) redeems the QR's code → { tokenHash, email, deviceId, deviceKey, shopName, role, name, username } */
    enrollRedeem: ({ token, deviceName, platform }) => call({ action:"enroll_redeem", token, device_name:deviceName, platform:platform || "" })
      .then(r => ({ ...joined(r), tokenHash:r.token_hash, email:r.email })),
    /* A member who just signed in with a password adds the phone it is on → { deviceId, deviceKey, shopName, role, name, username } */
    registerDevice: ({ deviceName, platform }) => call({ action:"register_device", device_name:deviceName, platform:platform || "" }).then(joined),
    revokeDevice: deviceId => call({ action:"revoke_device", device_id:deviceId }).then(() => ({ ok:true })),
    removeDevice: deviceId => call({ action:"remove_device", device_id:deviceId }).then(() => ({ ok:true })),
    /* ---------- reads (row security decides what comes back) ---------- */
    members: () => cloud.fetchMembers(),
    devices: () => cloud.fetchDevices(),
    roles: () => cloud.fetchRoles(),
    /* The owner's own permission list for a role (hangtag_roles) */
    saveRolePermissions: (role, permissions, label) => cloud.saveRole({ role, permissions, label }),
    /* This phone's standing: { shopId, role, deviceId }; also keeps the member's "last seen" */
    touch: () => cloud.touchDevice(),
  };
}
