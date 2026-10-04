// Where every page sits: the navigation model. Destinations (a module, or a part of one: Stock → Purchases) are grouped
// in areas. A desktop lists the areas in its sidebar; a phone keeps a few modules in its tab bar and puts the other areas
// under "More" (Sales, Purchases, Customers, Reports, Team, Settings); an area with parts shows them in a bar on its page
// (Stock: Stock · Products · Serials & batches · Stock count · Smart reorder). Presentation only: whether a destination
// exists for this person is the module registry's (services/modules.js: capabilities, permissions, available()).
import { store } from '../../../shared/state/store.js';
import { currentSubview, moduleDef, moduleShown, subviewsOf } from './modules.js';

/* key, label (the heading; "" for areas that are one destination), items: { tab, sub?, label?, side? }.
   side: false keeps a destination out of the desktop sidebar (it is still in its area's bar and in More). */
export const NAV_AREAS = [
  { key: "home", label: "", items: [{ tab: "home" }] },
  { key: "sell", label: "", items: [{ tab: "sell" }] },
  { key: "tables", label: "", items: [{ tab: "tables" }] },
  { key: "kitchen", label: "", items: [{ tab: "kitchen" }] },
  { key: "sales", label: "Sales", items: [{ tab: "orders" }, { tab: "store" }] },
  { key: "stock", label: "Stock", items: [{ tab: "stock", sub: "levels", label: "Stock" }, { tab: "products" }, { tab: "stock", sub: "tracking", side: false },
    { tab: "stock", sub: "count", side: false }, { tab: "stock", sub: "smart", side: false }] },
  { key: "purchases", label: "Purchases", items: [{ tab: "stock", sub: "purchases" }, { tab: "stock", sub: "pos", side: false }, { tab: "stock", sub: "suppliers" }] },
  { key: "customers", label: "", items: [{ tab: "customers" }] },
  { key: "reports", label: "Reports", items: [{ tab: "report" }, { tab: "assistant" }] },
  { key: "team", label: "", items: [{ tab: "team" }] },
  { key: "settings", label: "", items: [{ tab: "settings" }] },
];
/* More's headings on a phone for areas that are one destination */
const MORE_HEADINGS = { customers: "Customers", team: "Team", settings: "Settings", home: "", sell: "Sales", tables: "Restaurant", kitchen: "Restaurant" };

const subOf = (tab, sub) => subviewsOf(tab).find(d => d.id === sub) || null;
/* Is this destination shown to the person signed in, in this shop? */
export function destShown(it){
  if(!moduleShown(it.tab)) return false;
  return it.sub ? !!subOf(it.tab, it.sub) : true;
}
/* A destination's id ("stock:purchases", "products") and label */
export const destId = it => it.sub ? it.tab + ":" + it.sub : it.tab;
export function destLabel(it){
  if(it.label) return it.label;
  if(it.sub){ const s = subOf(it.tab, it.sub); return s ? s.label : it.sub; }
  const d = moduleDef(it.tab); return d ? d.label : it.tab;
}
/* The areas with the destinations shown here: [{ key, label, items: [{ tab, sub, id, label }] }] */
export function navAreas(){
  return NAV_AREAS.map(a => ({ key: a.key, label: a.label, items: a.items.filter(destShown).map(it => Object.assign({}, it, { id: destId(it), label: destLabel(it) })) }))
    .filter(a => a.items.length);
}
/* Where the page on screen is: { area, id } (the module's part decides for a module split over areas) */
export function navWhere(tab = store.prefs && store.prefs.tab){
  const cur = tab && currentSubview(tab), sub = cur && cur.id;
  for(const a of NAV_AREAS) for(const it of a.items){
    if(it.tab !== tab) continue;
    if(!it.sub || it.sub === sub) return { area: a.key, id: destId(it) };
  }
  // a part not listed (a later batch's) belongs where its module's first destination is
  const a = NAV_AREAS.find(x => x.items.some(it => it.tab === tab));
  return { area: a ? a.key : tab, id: tab };
}
/* The phone's "More" groups: every area except the ones its tab bar already shows (barIds: module ids in the bar) */
export function moreGroups(barIds, allowed){
  const inBar = new Set(barIds || []), may = allowed ? new Set(allowed) : null, out = [];
  navAreas().forEach(a => {
    if(a.items.some(it => inBar.has(it.tab) && (!it.sub || it.sub === "levels"))) return;   // this area is a tab-bar place
    const items = a.items.filter(it => !inBar.has(it.tab) || it.sub).filter(it => !may || may.has(it.tab));
    if(!items.length) return;
    const label = a.label || MORE_HEADINGS[a.key] || "";
    const g = out.find(x => x.label === label && label);
    if(g) g.items.push(...items); else out.push({ key: a.key, label, items });
  });
  return out;
}
/* The bar of an area's parts on its page (Stock, Purchases): [{ id, tab, sub, label, on }] — none when it has one part */
export function areaBar(areaKey, where = navWhere()){
  const a = navAreas().find(x => x.key === areaKey);
  if(!a || a.items.length < 2) return [];
  return a.items.map(it => Object.assign({}, it, { on: it.id === where.id }));
}
