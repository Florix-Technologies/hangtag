// The Platform Console's map (Hangtag's own staff, platform/): its sections, which permission opens each, the role names,
// and the guard for a route. The database decides what each role may do (hangtag_platform_permissions, schema.sql 3w) and
// checks it on every console call; the console only draws its menu and guards its routes from the permissions the server
// returned for the signed-in account — never from an email or anything the browser decides. Pure.

export const ROLES = Object.freeze(["super_admin", "admin", "billing_admin", "support_admin", "read_only"]);
export const ROLE_LABELS = Object.freeze({ super_admin: "Super admin", admin: "Admin", billing_admin: "Billing admin", support_admin: "Support admin", read_only: "Read only" });
/* The sections, in menu order; built: what this release shows (the others say plainly they come later) */
export const NAV = Object.freeze([
  { id: "dashboard", label: "Dashboard", perm: "dashboard.view", built: true },
  { id: "customers", label: "Customers", perm: "customers.view" },
  { id: "subscriptions", label: "Subscriptions", perm: "subscriptions.view" },
  { id: "payments", label: "Payments", perm: "payments.view" },
  { id: "promotions", label: "Promotions", perm: "promotions.view", built: true },
  { id: "referrals", label: "Referrals", perm: "referrals.view" },
  { id: "wallet", label: "Wallet", perm: "wallet.view" },
  { id: "communications", label: "Communications", perm: "communications.view" },
  { id: "health", label: "Usage & Health", perm: "health.view" },
  { id: "inventory", label: "Inventory", perm: "inventory.view" },
  { id: "diagnostics", label: "Errors & Diagnostics", perm: "diagnostics.view" },
  { id: "growth", label: "Growth", perm: "growth.view" },
  { id: "employees", label: "Employees", perm: "employees.view" },
  { id: "incentives", label: "Incentives", perm: "incentives.view" },
  { id: "reports", label: "Reports", perm: "reports.view" },
  { id: "audit", label: "Audit Log", perm: "audit.view", built: true },
  { id: "settings", label: "Settings", perm: "settings.view", built: true },
].map(Object.freeze));
export const DEFAULT_ROUTE = "dashboard";

/* The console's answer about the signed-in account ({ staff, role, permissions, account }) made safe to use */
export function staffOf(who){
  const w = who && typeof who === "object" ? who : {};
  const perms = Array.isArray(w.permissions) ? w.permissions.filter(p => typeof p === "string") : [];
  return { staff: w.staff === true && ROLES.includes(w.role), role: ROLES.includes(w.role) ? w.role : null, perms, account: typeof w.account === "string" ? w.account : "",
    name: typeof w.name === "string" ? w.name : "" };
}
export const can = (perms, perm) => Array.isArray(perms) && perms.includes(perm);
/* The sections this account may open, in menu order */
export const navFor = perms => NAV.filter(n => can(perms, n.perm));
/* "#/promotions" → "promotions"; anything else → the dashboard */
export function routeOf(hash){
  const m = /^#\/([a-z]+)\/?$/.exec(String(hash || ""));
  return m && NAV.some(n => n.id === m[1]) ? m[1] : DEFAULT_ROUTE;
}
/* May this account open the route? → "ok" | "denied" */
export function guard(route, perms){
  const n = NAV.find(x => x.id === route);
  return n && can(perms, n.perm) ? "ok" : "denied";
}

/* The dashboard's numbers as tiles: [{ group, items: [{ label, value, hint? , money? }] }] — only what the server counted */
export function dashboardTiles(d){
  if(!d || typeof d !== "object") return [];
  const n = v => (Number.isFinite(+v) ? +v : 0), s = d.shops || {}, p = d.subscriptions || {}, r = d.revenue || {}, u = d.usage || {};
  return [
    { group: "Shops", items: [{ label: "Shops set up", value: n(s.total) }, { label: "New in 7 days", value: n(s.new_7d) }, { label: "New in 30 days", value: n(s.new_30d) }] },
    { group: "Plans", items: [{ label: "On a trial", value: n(p.trial) }, { label: "Trial ending soon", value: n(p.trial_ending) }, { label: "Waiting for AutoPay", value: n(p.autopay_setup) },
      { label: "Paying", value: n(p.active) }, { label: "Renewing now", value: n(p.renewing) }, { label: "Ended", value: n(p.expired) }, { label: "Suspended", value: n(p.suspended) }] },
    { group: "AutoPay", items: [{ label: "On", value: n(p.autopay_on) }, { label: "Failing", value: n(p.autopay_failing) }, { label: "Turned off", value: n(p.autopay_cancelled) }] },
    { group: "Money received", items: [{ label: "This month", value: n(r.month), money: true, hint: `${n(r.month_count)} payment${n(r.month_count) === 1 ? "" : "s"}` },
      { label: "Last 30 days", value: n(r.last_30d), money: true }, { label: "By AutoPay, 30 days", value: n(r.autopay_30d), money: true }, { label: "Failed payments, 7 days", value: n(r.failed_7d) }] },
    { group: "Usage", items: [{ label: "Bills in 24 hours", value: n(u.bills_24h) }, { label: "Shops selling, 7 days", value: n(u.shops_selling_7d) }] },
  ];
}
/* The audit log's actions in words */
export const AUDIT_LABELS = Object.freeze({ "console.sign_in": "Signed in to the console", "console.denied": "Opened the console without a role",
  "promotion.update": "Changed a campaign", "plan.update": "Changed a plan", "settings.update": "Changed Hangtag's settings", "staff.update": "Changed console access" });
export const auditLabel = action => AUDIT_LABELS[action] || String(action || "");
/* What an audited change changed: ["max_uses: 3 → 100", …] — the fields whose value differs before and after */
export function auditChanges(detail){
  const d = detail && typeof detail === "object" ? detail : {}, before = d.before && typeof d.before === "object" ? d.before : {}, after = d.after && typeof d.after === "object" ? d.after : null;
  if(!after) return [];
  const show = v => v == null || v === "" ? "—" : Array.isArray(v) ? v.join(", ") || "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return Object.keys(after).filter(k => k !== "updated_at" && JSON.stringify(after[k]) !== JSON.stringify(before[k])).map(k => `${k}: ${show(before[k])} → ${show(after[k])}`);
}
/* An offer's counter: { redeemed, cap, left, share (0–1) } */
export function offerProgress(o){
  const redeemed = Math.max(0, +(o && o.redeemed) || 0), cap = o && o.cap != null ? Math.max(0, +o.cap) : null;
  return { redeemed, cap, left: cap == null ? null : Math.max(0, cap - redeemed), share: cap ? Math.min(1, redeemed / cap) : 0 };
}
