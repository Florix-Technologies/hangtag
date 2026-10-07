// Phone navigation and quick-action priorities for the existing roles. This changes presentation only: permissions and
// database policies remain authoritative, and a custom permission can surface an otherwise non-default module.
import { ROLE_DEFAULTS } from './permissions.js';
import { ROLE_BAR } from './role-workspace.js';

export const MOBILE_MODULE_ORDER = Object.freeze({
  owner: ['home', 'sell', 'bills', 'stock', 'customers', 'report', 'orders', 'products', 'tables', 'kitchen', 'assistant', 'store', 'team', 'settings'],
  manager: ['home', 'sell', 'bills', 'stock', 'customers', 'report', 'orders', 'products', 'tables', 'kitchen', 'assistant', 'store', 'settings'],
  cashier: ['home', 'sell', 'bills', 'customers', 'orders', 'stock', 'tables', 'settings'],
  server: ['tables', 'orders', 'home', 'settings'],
  kitchen: ['kitchen', 'settings'],
});

export const MOBILE_ACTION_ORDER = Object.freeze({
  owner: ['sale', 'scan', 'tables', 'reports', 'reorder', 'stock', 'customers', 'suppliers', 'settings'],
  manager: ['reports', 'reorder', 'stock', 'tables', 'orders', 'products', 'customers'],
  cashier: ['sale', 'scan', 'orders', 'customers'],
  server: ['tables', 'orders'],
  kitchen: ['kitchen'],
});

const defaultPerms = role => new Set(ROLE_DEFAULTS[role] || []);

/* Modules relevant on a phone. `modules` are already capability/permission-filtered module definitions. If the owner has
   granted this role a permission outside its defaults, the corresponding module is included as a custom workflow. */
export function mobileModulesFor(role, modules, permissions){
  const list = Array.isArray(modules) ? modules : [], order = MOBILE_MODULE_ORDER[role] || MOBILE_MODULE_ORDER.owner;
  const rank = id => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  if(role === 'owner') return list.slice().sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order || String(a.id).localeCompare(String(b.id)));
  const base = new Set(order), defaults = defaultPerms(role), current = new Set(permissions || []);
  const custom = def => (def.perms || []).some(p => current.has(p) && !defaults.has(p));
  const keep = list.filter(def => base.has(def.id) || custom(def));
  return keep.sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order || String(a.id).localeCompare(String(b.id)));
}

/* Keep a phone on a workflow it can actually navigate back to after an account/role change. This is presentation-only:
   `modules` must already have passed the normal capability and permission checks. */
export function mobileLandingModule(role, modules, permissions, current){
  const list = mobileModulesFor(role, modules, permissions);
  if(list.some(def => def.id === current && def.view !== false)) return current;
  const first = list.find(def => def.view !== false && def.landing !== false);   // (never a page like Settings by itself)
  return first ? first.id : null;
}

/* The phone tab bar: the role's own workspaces that fit (role-workspace.js ROLE_BAR: the owner and a manager Home · Sell ·
   Bills · Stock, a cashier Home · Sell · Bills · Customers, a server Home · Tables · Orders · Kitchen, the kitchen its
   screen), then "More". A place the shop or the person doesn't have goes to the next module the role uses on a phone.
   ids: the modules this person may open on a phone (mobileModulesFor), in its order. → the bar's module ids, at most `room` */
export function phoneBarFor(role, ids, room = 4){
  const have = Array.isArray(ids) ? ids : [], want = ROLE_BAR[role] || ROLE_BAR.owner;
  const bar = want.filter(id => have.includes(id));
  for(const id of have){ if(bar.length >= room) break; if(!bar.includes(id) && id !== 'settings') bar.push(id); }
  return bar.slice(0, room);
}

export function orderMobileActions(role, actions){
  const order = MOBILE_ACTION_ORDER[role] || MOBILE_ACTION_ORDER.owner, byId = new Map((actions || []).map(a => [a.id, a]));
  return order.map(id => byId.get(id)).filter(Boolean);
}
