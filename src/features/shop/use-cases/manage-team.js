// ManageTeam: the owner's changes to the shop's team — add a member, change a member's name, role or status, reset its
// access, remove it, make a sign-in code (QR) for a phone, revoke or remove a phone, and save a role's permissions.
// Only the owner: a team member is refused here, before anything is sent (the team Edge Function and the database refuse
// it too). Each returns the team service's answer, or throws an AppError the screen shows (components/team-settings.js).
import { EDITABLE_PERMISSIONS, PERMISSIONS } from '../../../domain/shop/permissions.js';
import { AppError, ERROR_CODES } from '../../../shared/errors/app-error.js';
import { isMember } from '../services/access.js';
import { teamService } from '../services/team.js';

export const OWNER_ONLY_TEXT = "Only the shop's owner manages the team.";
const owner = () => { if(isMember()) throw new AppError(ERROR_CODES.PERMISSION, OWNER_ONLY_TEXT); return teamService(); };

/* { name, username, role, password? } → { userId, shopCode, username, member } (no password: the person joins by QR) */
export const addMember = async input => owner().createMember(input);
/* { userId, name?, role?, status? } → { member, revoked } (switching off signs every phone of the member out) */
export const changeMember = async change => owner().updateMember(change);
/* Every phone of the member is signed out and its sign-ins end; the old password stops working (a new one when given,
   else the member joins by QR only) → { revoked, passwordSet } */
export const resetMemberAccess = async (userId, password) => owner().resetAccess({ userId, password: password || undefined });
export const removeMember = async userId => owner().removeMember(userId);
/* A single-use sign-in code for the member's phone (10 minutes) → { token, expiresAt } */
export const phoneSignInCode = async userId => owner().enrollStart(userId);
export const revokePhone = async deviceId => owner().revokeDevice(deviceId);
export const removePhone = async deviceId => owner().removeDevice(deviceId);
/* A role's permissions as the owner ticked them. Only the switchable ones change; seeing products, stock and customers
   stays as the role has it (every member may read them), and managing the team stays the owner's. */
export async function saveRolePermissions(role, ticked, current){
  const svc = owner();
  const keep = (current || []).filter(p => !EDITABLE_PERMISSIONS.includes(p) && p !== "manage_users" && p !== "manage_devices");
  const next = PERMISSIONS.filter(p => keep.includes(p) || (EDITABLE_PERMISSIONS.includes(p) && (ticked || []).includes(p)));
  await svc.saveRolePermissions(role, next);
  return next;
}
