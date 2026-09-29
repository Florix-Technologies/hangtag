// What a team member sees: the app hides what the member's role can't do. html[data-noperm] lists the permissions the
// person signed in lacks and html[data-notabs] the tabs it has no use for (styles/96-team.css hides their buttons);
// html[data-member] is the member's role. The owner lacks nothing, so nothing is hidden and nothing changes for owners.
// Which tabs exist and who sees them is the module registry's (services/modules.js: capabilities, permissions, whether
// the module exists). Only a convenience: the database refuses anything the role can't do.
import { currentRole, isMember, missingPerms } from '../services/access.js';
import { moduleDef, moduleShown, registeredModules } from '../services/modules.js';

/* The tabs of the first version (their ids keep working: prefs, links, tests) */
export const TABS = ["sell", "stock", "report", "products", "customers"];
/* May the person signed in open this page? (a module with a page, shown in this shop to this person) */
export const tabOpen = t => { const d = moduleDef(t); return !!d && d.view !== false && moduleShown(t); };
const setAttr = (el, k, v) => { if(v){ if(el.getAttribute(k) !== v) el.setAttribute(k, v); } else if(el.hasAttribute(k)) el.removeAttribute(k); };
export function applyAccessUI(){
  const root = document.documentElement;
  setAttr(root, "data-noperm", missingPerms().join(" "));
  setAttr(root, "data-notabs", registeredModules().filter(t => moduleDef(t).view !== false && !tabOpen(t)).join(" "));
  setAttr(root, "data-member", isMember() ? currentRole() : "");
}
