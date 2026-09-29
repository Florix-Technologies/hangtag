// Staff accounts (team members): the address a staff account signs in with, and checks of what the owner and staff type.
// The same rules as supabase/functions/team/core.js, which checks everything again. Pure.
//   A staff account signs in as <username>.<shop code>@staff.hangtag.invalid: an address that can never receive mail.
//   The shop code is the first 10 hex digits of the shop id (the owner sees it in Settings → Team & devices).
import { MEMBER_ROLES } from './permissions.js';

export const STAFF_DOMAIN = "staff.hangtag.invalid";
export const USERNAME = /^[a-z0-9._-]{3,30}$/;
export const SHOP_CODE = /^[0-9a-f]{10}$/;
export const STAFF_LIMITS = { name: 80, passwordMin: 8, passwordMax: 72 };

export const shopCode = shopId => String(shopId || "").replace(/-/g, "").toLowerCase().slice(0, 10);
export const staffEmail = (username, code) => `${username}.${code}@${STAFF_DOMAIN}`;
export const cleanUsername = u => String(u || "").trim().toLowerCase();
export const cleanShopCode = c => String(c || "").trim().toLowerCase().replace(/[\s-]/g, "");
export const cleanMemberName = n => String(n || "").replace(/\s+/g, " ").trim();

function passwordError(p){
  if(p.length < STAFF_LIMITS.passwordMin || p.length > STAFF_LIMITS.passwordMax) return `The password needs ${STAFF_LIMITS.passwordMin} to ${STAFF_LIMITS.passwordMax} characters.`;
  return "";
}
/* The staff sign-in form → null, or { error, field } */
export function checkStaffSignIn({ code, username, password }){
  if(!SHOP_CODE.test(cleanShopCode(code))) return { error: "Enter the shop code: 10 letters and digits the owner gives you.", field: "code" };
  if(!USERNAME.test(cleanUsername(username))) return { error: "Enter your username: 3 to 30 letters, digits, dots, dashes or underscores.", field: "username" };
  if(!password) return { error: "Enter your password.", field: "password" };
  return null;
}
/* The owner's "Add team member" form. password is optional (without one the person signs in by QR only). → null or { error, field } */
export function checkNewMember({ name, username, role, password }){
  const n = cleanMemberName(name);
  if(!n) return { error: "Enter the person's name.", field: "name" };
  if(n.length > STAFF_LIMITS.name) return { error: `A name can be at most ${STAFF_LIMITS.name} characters.`, field: "name" };
  if(!USERNAME.test(cleanUsername(username))) return { error: "A username has 3 to 30 lower-case letters, digits, dots, dashes or underscores.", field: "username" };
  if(!MEMBER_ROLES.includes(role)) return { error: "Choose a role.", field: "role" };
  const pe = password ? passwordError(String(password)) : "";
  if(pe) return { error: pe, field: "password" };
  return null;
}
/* A new password the owner types when resetting access (optional) → "" or the problem */
export const newPasswordError = p => p ? passwordError(String(p)) : "";
