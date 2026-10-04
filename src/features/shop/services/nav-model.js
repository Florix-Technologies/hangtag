// Where every page sits: the navigation model. A small, stable primary bar chooses the workspace; contextual navigation
// inside Sell and Stock chooses the task. Everything secondary is grouped under More. Presentation only: whether a destination
// exists for this person is the module registry's (services/modules.js: capabilities, permissions, available()).
import { store } from '../../../shared/state/store.js';
import { currentSubview, moduleDef, moduleShown, subviewsOf } from './modules.js';

/* key, label (the heading; "" for areas that are one destination), items: { tab, sub?, label?, side? }.
   side: false keeps a destination out of the desktop sidebar (it is still in its area's bar and in More). */
export const NAV_AREAS = [
  { key: "home", label: "", items: [{ tab: "home" }] },
  { key: "sell", label: "Sell", items: [{ tab: "sell", label: "New sale" }, { tab: "orders", sub: "held" },
    { tab: "orders", sub: "quote" }, { tab: "orders", sub: "sales" }, { tab: "tables" }, { tab: "kitchen" }] },
  { key: "bills", label: "", items: [{ tab: "bills" }] },
  { key: "stock", label: "Stock", items: [{ tab: "stock", sub: "levels", label: "Stock" }, { tab: "products" },
    { tab: "stock", sub: "count" }, { tab: "stock", sub: "purchases" }, { tab: "stock", sub: "suppliers" },
    { tab: "stock", sub: "pos" }, { tab: "stock", sub: "tracking" }, { tab: "stock", sub: "smart" }] },
  { key: "customers", label: "", items: [{ tab: "customers" }] },
  { key: "reports", label: "", items: [{ tab: "report" }] },
  { key: "commerce", label: "Commerce", items: [{ tab: "store" }] },
  { key: "agent", label: "Hangtag Agent", items: [{ tab: "assistant" }] },
  { key: "team", label: "", items: [{ tab: "team" }] },
  { key: "settings", label: "", items: [{ tab: "settings" }] },
];
export const PRIMARY_TABS = Object.freeze(["home", "sell", "bills", "stock", "customers", "report"]);
/* More's headings on a phone for areas that are one destination */
const MORE_HEADINGS = { customers: "Customers", reports: "Reports", bills: "Bills", team: "Team & Devices", settings: "Business & Settings", home: "", sell: "Sell", agent: "Hangtag Agent" };

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
/* The stable workspaces shown across the desktop. A role/capability may remove one; More remains. */
export function primaryNav(){
  const areas=navAreas();
  return PRIMARY_TABS.map(tab=>{
    const area=areas.find(a=>a.items.some(it=>it.tab===tab)), it=area&&area.items.find(x=>x.tab===tab);
    return it?Object.assign({},it,{area:area.key,label:tab==="report"?"Reports":tab==="stock"?"Stock":tab.charAt(0).toUpperCase()+tab.slice(1)}):null;
  }).filter(Boolean);
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
