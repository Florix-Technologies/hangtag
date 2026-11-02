// What each role's day is about, and so where it works and what its Home brings forward:
//   owner    sales, profit, GST, cash, bank, inventory, the Agent, the team
//   manager  sales, stock, customers, orders, purchases, the Agent
//   cashier  selling, bills, customers, held bills
//   server   tables, orders, the kitchen
//   kitchen  the kitchen (tables and orders when the role may)
// Presentation only: what anyone may do is the permissions' (permissions.js) and the database's policies. A member the owner
// gave more than its role's defaults also gets what those permissions open, after its own. Pure.
import { ROLE_DEFAULTS, tabAllowed } from './permissions.js';

export const ROLE_FOCUS = Object.freeze({
  owner: Object.freeze(["sales", "profit", "gst", "cash", "bank", "inventory", "agent", "team"]),
  manager: Object.freeze(["sales", "stock", "customers", "orders", "purchases", "agent"]),
  cashier: Object.freeze(["sell", "bills", "customers", "held"]),
  server: Object.freeze(["tables", "orders", "kitchen"]),
  kitchen: Object.freeze(["kitchen", "tables", "orders"]),
});
/* The shop's usual workspace bar (nav-model.js PRIMARY_TABS) */
const USUAL = ["home", "sell", "bills", "stock", "customers", "report"];
/* Each role's workspaces, in the bar's order: a desktop shows them all, a phone's tab bar the first that fit */
export const ROLE_BAR = Object.freeze({
  owner: Object.freeze(USUAL),
  manager: Object.freeze(USUAL),
  cashier: Object.freeze(["home", "sell", "bills", "customers"]),
  server: Object.freeze(["home", "tables", "orders", "kitchen"]),
  kitchen: Object.freeze(["kitchen", "tables", "orders"]),
});
const roleOf = role => ROLE_BAR[role] ? role : "owner";
/* A workspace only a permission beyond the role's defaults opens (the owner let a cashier see reports: Reports) */
const extraTabs = (role, perms, own) => role === "owner" ? [] : USUAL.filter(t => !own.includes(t) && tabAllowed(t, perms || []) && !tabAllowed(t, ROLE_DEFAULTS[role] || []));
/* The bar for a role with these permissions: its own workspaces, then the extra ones (each is still shown only when the
   shop uses it and the person may open it: services/modules.js) */
export function roleBar(role, perms){
  const r = roleOf(role), own = [...ROLE_BAR[r]];
  return [...own, ...extraTabs(r, perms, own)];
}

/* Home, by role: the sections it brings forward, in order. Each section still checks its permission and the shop's
   features when it is drawn; a member with extra permissions gets the sections they open after its own.
     briefing   the owner's morning briefing: what to do first, yesterday, products, payments, orders, money
     business   Business today (sales against a usual day, and why)   shift      the cashier's own bills, money and drawer
     owner      GST, bank and cash, the team today                    held       bills put on hold, to finish
     ops        orders, purchases and stock to act on                 customers  find or add a customer, dues to collect
     attention  what needs this person                                tables     the tables now: ready to serve, asking to pay
     agent      the Agent's observations                              bills      the latest bills
     trend      the last 7 days */
export const HOME_SECTIONS = Object.freeze({
  owner: Object.freeze(["briefing", "business", "owner", "attention", "agent", "bills", "trend"]),
  manager: Object.freeze(["business", "ops", "attention", "agent", "bills", "trend"]),
  cashier: Object.freeze(["shift", "held", "attention", "bills", "customers"]),
  server: Object.freeze(["tables", "attention"]),
  kitchen: Object.freeze(["tables", "attention"]),
});
/* Sections a permission beyond the role's defaults brings (after the role's own) */
const EXTRA_SECTIONS = [["view_reports", ["business", "agent", "trend"]], ["create_purchase", ["ops"]], ["manage_inventory", ["ops"]], ["create_sale", ["shift", "held", "bills"]]];
export function homeSections(role, perms){
  const r = roleOf(role), own = [...HOME_SECTIONS[r]];
  if(r === "owner") return own;
  const defaults = new Set(ROLE_DEFAULTS[r] || []), have = new Set(perms || []);
  EXTRA_SECTIONS.forEach(([p, secs]) => { if(have.has(p) && !defaults.has(p)) secs.forEach(s => { if(!own.includes(s)) own.push(s); }); });
  return own;
}
/* What Business today shows a role: the owner everything; anyone else who sees reports sales with what customers owe and
   the stock (profit, the money split and reconciliation are the owner's: they stay in Reports for those who may) */
export const businessScope = (role, perms) => roleOf(role) === "owner" ? { profit: true, money: true, position: true }
  : (perms || []).includes("view_reports") ? { profit: false, money: false, position: true } : {};
