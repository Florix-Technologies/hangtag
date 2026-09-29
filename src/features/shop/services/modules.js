// The navigation module registry: the ONE place that says which parts of the app exist and who sees them.
// A module (a tab) or a sub-view (a part of a module, e.g. Orders → Held carts, Inventory → Purchases) is shown only when
//   · it exists: registered, and available() (Orders only while at least one kind of order is registered);
//   · the shop uses it: any of its capabilities is on (services/shop-caps.js; none listed = every business);
//   · the person signed in may open it: any of its permissions (services/access.js can(); the owner may do everything).
// Capabilities only decide what is shown; permissions keep deciding what a person may do (the database enforces them).
// The core modules are registered here; the app shell (app/modules.js) adds their pages, and later batches register
// theirs the same way (registerModule / registerSubview) — a module that isn't built yet is simply not registered.
import { store } from '../../../shared/state/store.js';
import { savePrefs } from '../../../shared/state/persistence.js';
import { TAB_PERMISSIONS } from '../../../domain/shop/permissions.js';
import { featureShown } from '../../../domain/shop/capabilities.js';
import { NAV_ICONS } from '../../../shared/constants/nav-icons.js';
import { shopCaps } from './shop-caps.js';
import { can } from './access.js';

const MODULES = new Map(), SUBVIEWS = new Map();
/* Modules that only ever show with their capability (a batch registering them can't forget it): never for a shop that
   doesn't use tables or a kitchen */
const MODULE_CAPS = { tables: ["uses_tables"], kitchen: ["uses_kitchen"] };

/* def: { id (the tab id; its page is <section id="v-<id>">), label, icon (svg), order (place in the tab bar),
   phone (which stay on a phone's short tab bar: lower first), view: true (a page) | false (an action: open()),
   caps: [any of these capabilities] (none: every business), perms: [any of these permissions] (default: TAB_PERMISSIONS),
   available(): false while it can't be used here, render(): draws its page, open(): an action module's action }.
   Registering an id again adds to it (the app shell adds render functions to the core modules). */
export function registerModule(def){
  const was = MODULES.get(def.id);
  const d = Object.assign({ view: true, order: 100, phone: 50, caps: [], perms: TAB_PERMISSIONS[def.id] || [], icon: NAV_ICONS[def.id] || NAV_ICONS.dot }, was || {}, def);
  if(MODULE_CAPS[d.id] && !(d.caps || []).some(k => MODULE_CAPS[d.id].includes(k))) d.caps = MODULE_CAPS[d.id].slice();
  MODULES.set(d.id, d);
  return d;
}
/* A part of a module (the module's page shows a bar to switch between its parts when it has more than one).
   def: { id, label, order, caps, perms, available(), render(host) } */
export function registerSubview(parent, def){
  if(!SUBVIEWS.has(parent)) SUBVIEWS.set(parent, new Map());
  const list = SUBVIEWS.get(parent), was = list.get(def.id);
  const d = Object.assign({ order: 100, caps: [], perms: [] }, was || {}, def);
  list.set(d.id, d);
  return d;
}
export const moduleDef = id => MODULES.get(id) || null;
const byOrder = (a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id));
/* Is this module shown to the person signed in, in this shop? */
export function moduleShown(id){ return featureShown(MODULES.get(id), shopCaps(), can); }
/* The modules shown, in tab bar order */
export function shownModules(){ const caps = shopCaps(); return [...MODULES.values()].filter(d => featureShown(d, caps, can)).sort(byOrder); }
/* Every registered module's id (shown or not) */
export const registeredModules = () => [...MODULES.values()].sort(byOrder).map(d => d.id);
/* The parts of a module shown, in order */
export function subviewsOf(parent){ const caps = shopCaps(); return [...(SUBVIEWS.get(parent) || new Map()).values()].filter(d => featureShown(d, caps, can)).sort(byOrder); }
/* The part of a module on screen (the one chosen last, else its first) */
export function currentSubview(parent){
  const list = subviewsOf(parent), want = store.prefs && store.prefs.sub && store.prefs.sub[parent];
  return list.find(d => d.id === want) || list[0] || null;
}
export function chooseSubview(parent, id){
  if(!store.prefs) return;
  store.prefs.sub = Object.assign({}, store.prefs.sub, { [parent]: id });
  savePrefs();
}

/* The tab bar with room for `limit` buttons: { bar: [ids shown in it], more: [ids behind "More"] }, both in tab bar order.
   list: the modules shown (shownModules()). Everything fits → no More. Otherwise the ones a phone needs most (lowest
   `phone`) keep their place, one fewer to leave room for More, and the page on screen always keeps its button. */
export function navSlots(list, current, limit){
  const ids = list.map(d => d.id);
  if(ids.length <= limit) return { bar: ids, more: [] };
  const keep = list.slice().sort((a, b) => a.phone - b.phone || byOrder(a, b)).map(d => d.id).slice(0, Math.max(1, limit - 1));
  if(current && ids.includes(current) && !keep.includes(current)) keep[keep.length - 1] = current;
  return { bar: ids.filter(id => keep.includes(id)), more: ids.filter(id => !keep.includes(id)) };
}

/* ---------- the core modules (every business; their pages are added by app/modules.js) ---------- */
[
  { id: "home", label: "Home", order: 10, phone: 20 },
  { id: "sell", label: "Sell", order: 20, phone: 10 },
  // quotations, sales orders, held carts, table orders: shown only when at least one of them is registered and in use
  { id: "orders", label: "Orders", order: 30, phone: 30, available: () => subviewsOf("orders").length > 0 },
  { id: "stock", label: "Inventory", order: 50, phone: 40 },
  { id: "products", label: "Products", order: 60, phone: 70 },
  { id: "customers", label: "Customers", order: 70, phone: 60 },
  { id: "report", label: "Reports", order: 80, phone: 50 },
  { id: "settings", label: "Settings", order: 90, phone: 80, view: false },
].forEach(registerModule);
/* Where the restaurant modules go when their batch registers them (only with uses_tables / uses_kitchen on):
   registerModule({ id: "tables", label: "Tables", order: 32, phone: 25, caps: ["uses_tables"], render })
   registerModule({ id: "kitchen", label: "Kitchen", order: 34, phone: 25, caps: ["uses_kitchen"], render }) */
