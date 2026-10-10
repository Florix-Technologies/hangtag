// The Platform Console's map (Hangtag's own staff, platform/): its sections, which permission opens each, the role names,
// and the guard for a route. The database decides what each role may do (hangtag_platform_permissions, schema.sql 3w) and
// checks it on every console call; the console only draws its menu and guards its routes from the permissions the server
// returned for the signed-in account — never from an email or anything the browser decides. Pure.

export const ROLES = Object.freeze(["super_admin", "admin", "billing_admin", "support_admin", "read_only"]);
export const ROLE_LABELS = Object.freeze({ super_admin: "Super admin", admin: "Admin", billing_admin: "Billing admin", support_admin: "Support admin", read_only: "Read only" });
/* The sections, in menu order; built: what this release shows (the others say plainly they come later) */
export const NAV = Object.freeze([
  { id: "dashboard", label: "Dashboard", perm: "dashboard.view", built: true },
  { id: "customers", label: "Customers", perm: "customers.view", built: true },
  { id: "subscriptions", label: "Subscriptions", perm: "subscriptions.view", built: true },
  { id: "payments", label: "Payments", perm: "payments.view", built: true },
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
/* "#/promotions" or "#/customers?filter=active" → "promotions" / "customers"; anything else → the dashboard */
export function routeOf(hash){
  const m = /^#\/([a-z]+)\/?(?:\?[A-Za-z0-9_=&%.+-]*)?$/.exec(String(hash || ""));
  return m && NAV.some(n => n.id === m[1]) ? m[1] : DEFAULT_ROUTE;
}
/* A route's settings from its address ("#/customers?filter=active&q=aura"): only the known ones, each a short plain value */
const QUERY_KEYS = ["filter", "status", "days", "sort", "q"];
export function routeQuery(hash){
  const h = String(hash || ""), m = /^#\/([a-z]+)\/?\?(.*)$/.exec(h), out = {};
  if(!m || routeOf(h) !== m[1]) return out;
  for(const part of m[2].split("&")){
    const [k, raw = ""] = part.split("=");
    let v; try{ v = decodeURIComponent(raw.replace(/\+/g, " ")).trim(); }catch{ continue; }
    if(QUERY_KEYS.includes(k) && v && v.length <= 80 && (k === "q" || /^[a-z0-9_]{1,24}$/.test(v))) out[k] = v;
  }
  return out;
}
/* The address of a route with its settings (empty ones left out): ("customers", { filter: "active" }) → "#/customers?filter=active" */
const enc = v => encodeURIComponent(String(v)).replace(/[!'()*~]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
export function routeHash(route, query){
  const q = Object.entries(query || {}).filter(([k, v]) => QUERY_KEYS.includes(k) && v != null && v !== "" && v !== "all")
    .map(([k, v]) => `${k}=${enc(v)}`).join("&");
  return `#/${route}${q ? "?" + q : ""}`;
}
/* May this account open the route? → "ok" | "denied" */
export function guard(route, perms){
  const n = NAV.find(x => x.id === route);
  return n && can(perms, n.perm) ? "ok" : "denied";
}

/* The dashboard's numbers as tiles: [{ group, items: [{ label, value, hint?, money?, href? }] }] — only what the server counted.
   A customer count opens the list it counted (the database counts each list with the list's own definition), when the
   account may open that section. */
export function dashboardTiles(d, perms){
  if(!d || typeof d !== "object") return [];
  const n = v => (Number.isFinite(+v) ? +v : 0), s = d.shops || {}, c = d.customers || {}, p = d.subscriptions || {}, r = d.revenue || {}, u = d.usage || {};
  const to = (perm, route, query) => (can(perms, perm) ? routeHash(route, query) : undefined);
  const list = (label, key) => ({ label, value: n(c[key]), href: to("customers.view", "customers", { filter: key }) });
  return [
    { group: "Customers", items: [list("All customers", "all"), list("Active", "active"), list("Trials", "trial"), list("Expiring in 7 days", "expiring"),
      { label: "Payment failures, 7 days", value: n(r.failed_7d), href: to("payments.view", "payments", { status: "failed", days: 7 }) },
      list("Expired", "expired"), list("Suspended", "suspended"), list("Inactive 30 days", "inactive")] },
    { group: "Shops", items: [{ label: "Shops set up", value: n(s.total) }, { label: "New in 7 days", value: n(s.new_7d) }, { label: "New in 30 days", value: n(s.new_30d) }] },
    { group: "AutoPay", items: [{ label: "On", value: n(p.autopay_on) }, { label: "Failing", value: n(p.autopay_failing) }, { label: "Turned off", value: n(p.autopay_cancelled) },
      { label: "Waiting for AutoPay", value: n(p.autopay_setup) }, { label: "Renewing now", value: n(p.renewing) }] },
    { group: "Money received", items: [{ label: "This month", value: n(r.month), money: true, hint: `${n(r.month_count)} payment${n(r.month_count) === 1 ? "" : "s"}` },
      { label: "Last 30 days", value: n(r.last_30d), money: true }, { label: "By AutoPay, 30 days", value: n(r.autopay_30d), money: true }] },
    { group: "Usage", items: [{ label: "Bills in 24 hours", value: n(u.bills_24h) }, { label: "Shops selling, 7 days", value: n(u.shops_selling_7d) }] },
  ];
}

/* The lists of Customers and Subscriptions, and the payment statuses, as the database names them (schema.sql 3x) */
export const CUSTOMER_LISTS = Object.freeze([["all", "All"], ["trial", "Trial"], ["active", "Active"], ["payment_failed", "Payment failed"], ["expiring", "Expiring"],
  ["expired", "Expired"], ["suspended", "Suspended"], ["inactive", "Inactive"]]);
export const SUBSCRIPTION_LISTS = Object.freeze([["all", "All"], ["trial", "Trial"], ["active", "Active"], ["payment_failed", "Payment failed"], ["past_due", "Past due"],
  ["cancelled", "Cancelled"], ["expired", "Expired"], ["suspended", "Suspended"]]);
export const PAYMENT_STATUSES = Object.freeze([["all", "All"], ["captured", "Captured"], ["pending", "Pending"], ["failed", "Failed"], ["refunded", "Refunded"],
  ["cancelled", "Cancelled"], ["expired", "Expired"], ["granted", "Granted"], ["free", "Free"]]);
export const SORTS = Object.freeze([["newest", "Newest"], ["oldest", "Oldest"], ["last_active", "Last active"], ["expiry", "Expiry"], ["revenue", "Revenue"]]);
export const CUSTOMER_TABS = Object.freeze([["overview", "Overview"], ["subscription", "Subscription"], ["payments", "Payments"], ["usage", "Usage"], ["inventory", "Inventory"],
  ["communications", "Communications"], ["errors", "Errors"], ["referrals", "Referrals"], ["wallet", "Wallet"], ["activity", "Activity"]]);
/* One of a list's values, or its first */
export const pick = (list, v) => (list.some(([k]) => k === v) ? v : list[0][0]);

/* Badges: [label, tone] — tone ok | info | warn | bad | "" */
const LIFECYCLE = { trial: ["Trial", "info"], trial_ending: ["Trial ending", "warn"], autopay_required: ["Waiting for AutoPay", "warn"], active: ["Active", "ok"],
  renewing: ["Renewing", "info"], past_due: ["Past due", "warn"], cancelled: ["AutoPay off", "warn"], halted: ["Payment stopped", "bad"], expired: ["Expired", "bad"],
  suspended: ["Suspended", "bad"], none: ["Setup not finished", ""] };
const AUTOPAY = { none: ["Off", ""], pending: ["Setting up", "info"], active: ["On", "ok"], past_due: ["Retrying", "warn"], halted: ["Stopped", "bad"], cancelled: ["Turned off", ""] };
const PAYMENT = { captured: ["Captured", "ok"], pending: ["Pending", "info"], failed: ["Failed", "bad"], refunded: ["Refunded", ""], cancelled: ["Cancelled", ""],
  expired: ["Expired", ""], granted: ["Granted", "info"], free: ["Free", "info"] };
const STATE = { trial_active: "Trial", trial_setup: "Trial, waiting for AutoPay", paid_active: "Paid plan", renewal_due: "Renewing (grace)", trial_expired: "Trial ended",
  paid_expired: "Plan ended", suspended: "Suspended", none: "Setup not finished" };
const badge = (map, v) => { const b = map[v]; return { label: b ? b[0] : String(v || "—"), tone: b ? b[1] : "" }; };
export const lifecycleBadge = v => badge(LIFECYCLE, v);
export const autopayBadge = v => badge(AUTOPAY, v || "none");
export const paymentBadge = v => badge(PAYMENT, v);
export const stateLabel = v => STATE[v] || String(v || "—");

/* The actions on a shop: who may (the database checks again), and when each one makes sense */
export const ACTIONS = Object.freeze({
  suspend: { label: "Suspend", confirm: "Suspend the shop", perm: "customers.suspend", danger: true },
  restore: { label: "Restore", confirm: "Restore the shop", perm: "customers.suspend" },
  grant: { label: "Give a plan", confirm: "Give the plan", perm: "subscriptions.manage" },
  extend: { label: "Extend", confirm: "Extend", perm: "subscriptions.manage" },
  sign_out: { label: "End all sign-ins", confirm: "End all sign-ins", perm: "customers.sessions", danger: true },
});
export function shopActions(perms, state){
  const set = state && state !== "none";
  return Object.keys(ACTIONS).filter(a => can(perms, ACTIONS[a].perm) && (a === "sign_out" || (set && (a === "suspend" ? state !== "suspended" : a === "restore" ? state === "suspended" : true))));
}
/* What an action will do, from the database's preview ({ before, after, …}): plain lines. day, money: the formatters. */
export function actionConsequence(action, pv, { day = v => String(v || "").slice(0, 10), money = v => String(+v || 0) } = {}){
  if(!pv || typeof pv !== "object") return [];
  const b = pv.before || {}, a = pv.after || {}, out = [];
  const access = x => (x.access ? "can use Hangtag" : "can't use Hangtag");
  if(a.state !== b.state) out.push(`Plan: ${stateLabel(b.state)} → ${stateLabel(a.state)} (the shop ${access(a)}).`);
  if(action === "suspend"){
    out.push("The owner and the team can't bill or change anything until the shop is restored. Nothing is deleted.");
    if(b.autopay_status === "active" || b.autopay_status === "past_due") out.push("AutoPay stays on at the provider: suspending doesn't stop its charges.");
  }else if(action === "restore"){
    if(a.access_until) out.push(`Access runs until ${day(a.access_until)}.`);
  }else if(action === "grant"){
    out.push(`Paid until ${day(a.period_end)}${b.period_end ? ` (was ${day(b.period_end)})` : ""}.`, `A ${money(0)} manual payment is recorded: no money is charged.`);
  }else if(action === "extend"){
    const k = pv.extended === "trial" ? "trial_ends_at" : "period_end";
    out.push(`${pv.extended === "trial" ? "The trial" : "The plan"} ends ${day(a[k])} instead of ${day(b[k])} (+${pv.days} day${pv.days === 1 ? "" : "s"}).`);
  }else if(action === "sign_out"){
    const n = +pv.sessions_ended || 0;
    out.push(`${n} sign-in${n === 1 ? "" : "s"} end now (the owner's${+pv.team ? " and the team's" : ""}): each signs in again.`,
      "A page already open stops syncing within the hour.");
  }
  return out;
}
/* The audit log's actions in words */
export const AUDIT_LABELS = Object.freeze({ "console.sign_in": "Signed in to the console", "console.denied": "Opened the console without a role",
  "promotion.update": "Changed a campaign", "plan.update": "Changed a plan", "settings.update": "Changed Hangtag's settings", "staff.update": "Changed console access",
  "customer.suspend": "Suspended a shop", "customer.restore": "Restored a shop", "customer.grant": "Gave a shop a plan", "customer.extend": "Extended a shop's trial or plan",
  "customer.sign_out": "Ended a shop's sign-ins" });
/* A shop's history in words (hangtag_platform_customer → activity: its own events, its payments, the console's actions on it) */
export const ACTIVITY_LABELS = Object.freeze({ signed_up: "Signed up", shop_set_up: "Set up the shop", trial_started: "Trial started", autopay_on: "AutoPay set up",
  autopay_failed: "An AutoPay charge failed", autopay_off: "AutoPay turned off", payment_captured: "Paid", payment_granted: "Plan given (no charge)",
  payment_free: "Plan taken with an offer (no charge)", payment_failed: "A payment failed", created: "Payment started", captured: "Money captured by the provider",
  activated: "Plan activated" });
export const activityLabel = kind => ACTIVITY_LABELS[kind] || AUDIT_LABELS[kind] || String(kind || "");
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
