// Roles and permissions of a shop's team. Pure.
// Permission = "may this person do X" (the database enforces it: public.hangtag_can() in supabase/schema.sql section 3i).
// The owner may do everything; a member what its role allows: the shop's own list for the role (hangtag_roles), else the
// defaults below. The same lists as public.hangtag_default_permissions() and supabase/functions/team/core.js
// (tests/unit/access.test.mjs checks all three agree). Hiding a button for a role is only a convenience.

export const PERMISSIONS = ["view_products", "manage_products", "manage_inventory", "create_purchase", "create_sale", "apply_discount",
  "view_reports", "perform_return", "collect_credit", "manage_users", "manage_devices", "manage_tables", "create_order",
  "send_to_kitchen", "manage_kitchen", "manage_settings"];
export const PERMISSION_LABELS = {
  view_products: "See products and stock",
  manage_products: "Add and edit products",
  manage_inventory: "Stock in and stock adjustments",
  create_purchase: "Supplier bills and purchases",
  create_sale: "Sell, take payments, cash drawer",
  apply_discount: "Give discounts",
  view_reports: "See reports and books",
  perform_return: "Returns, exchanges, cancel bills",
  collect_credit: "Collect money customers owe",
  manage_users: "Manage the team",
  manage_devices: "Manage devices",
  manage_tables: "Tables",
  create_order: "Take orders",
  send_to_kitchen: "Send orders to the kitchen",
  manage_kitchen: "Kitchen screen",
  manage_settings: "Shop settings, events, receipt logo",
};
export const ROLE_DEFAULTS = {
  owner: [...PERMISSIONS],
  manager: PERMISSIONS.filter(p => p !== "manage_users" && p !== "manage_devices"),
  cashier: ["view_products", "create_sale", "apply_discount", "perform_return", "collect_credit", "create_order", "send_to_kitchen", "manage_tables"],
  server: ["view_products", "create_order", "send_to_kitchen", "manage_tables"],
  kitchen: ["manage_kitchen"],
};
/* Roles a team member can have (the owner is never a member) */
export const MEMBER_ROLES = ["manager", "cashier", "server", "kitchen"];
export const ROLE_LABELS = { owner: "Owner", manager: "Manager", cashier: "Cashier", server: "Server", kitchen: "Kitchen" };
export const roleLabel = r => ROLE_LABELS[r] || (r ? String(r).charAt(0).toUpperCase() + String(r).slice(1).replace(/_/g, " ") : "");

/* What a role may do: everything for the owner; the shop's own list for the role when it changed it (overrides:
   { role: [permissions] }, from hangtag_roles), else the defaults. Unknown permissions are dropped. */
export function permissionsFor(role, overrides){
  if(role === "owner") return [...PERMISSIONS];
  const own = overrides && Array.isArray(overrides[role]) ? overrides[role] : null;
  return own ? PERMISSIONS.filter(p => own.includes(p)) : [...(ROLE_DEFAULTS[role] || [])];
}
/* May this role do p? perms: the role's permission list, or the shop's overrides ({ role: [permissions] }) */
export const roleCan = (role, perms, p) => role === "owner" || (Array.isArray(perms) ? perms : permissionsFor(role, perms)).includes(p);
/* Cancelling or restoring a bill: any one of these (the database checks the same: hangtag_member_write_check) */
export const CANCEL_BILL = ["perform_return", "manage_settings"];
/* What the owner can switch per role in Roles & permissions. Managing the team and devices stays the owner's own; seeing
   products, stock and customers is every member's (the database lets any member read them, so it isn't a switch). */
export const EDITABLE_PERMISSIONS = PERMISSIONS.filter(p => p !== "manage_users" && p !== "manage_devices" && p !== "view_products");
/* The permissions a role lacks (what the app hides for it) */
export const missingFor = perms => PERMISSIONS.filter(p => !(perms || []).includes(p));

/* Roles to offer for the kind of business: domain/shop/capabilities.js (ROLE_SUGGESTIONS, roleSuggestionsFor). */

/* ---------- which permission a screen or an upload needs ---------- */
/* Tabs: what a person needs to see each one (any of the list) */
export const TAB_PERMISSIONS = {
  sell: ["create_sale"],
  stock: ["view_products", "manage_inventory", "create_purchase"],
  report: ["view_reports"],
  products: ["view_products", "manage_products"],
  customers: ["create_sale", "collect_credit", "create_order"],
  // the adaptive navigation's modules (features/shop/services/modules.js); Settings is everyone's (what it shows depends on the role)
  home: ["view_products", "create_sale", "view_reports", "create_order", "manage_inventory", "create_purchase"],
  orders: ["create_sale", "create_order"],
  tables: ["manage_tables", "create_order"],
  kitchen: ["manage_kitchen"],
};
export const tabAllowed = (tab, perms) => !TAB_PERMISSIONS[tab] || TAB_PERMISSIONS[tab].some(p => (perms || []).includes(p));
