// What a team member sees: the app hides what the member's role can't do. html[data-noperm] lists the permissions the
// person signed in lacks and html[data-notabs] the tabs it has no use for (styles/96-team.css hides their buttons);
// html[data-member] is the member's role. The owner lacks nothing, so nothing is hidden and nothing changes for owners.
// Only a convenience: the database refuses anything the role can't do.
import { tabAllowed } from '../../../domain/shop/permissions.js';
import { currentPerms, currentRole, isMember, missingPerms } from '../services/access.js';

export const TABS = ["sell", "stock", "report", "products", "customers", "orders"];
/* May the person signed in open this tab? (the owner: every tab) */
export const tabOpen = t => !isMember() || tabAllowed(t, currentPerms());
const setAttr = (el, k, v) => { if(v){ if(el.getAttribute(k) !== v) el.setAttribute(k, v); } else if(el.hasAttribute(k)) el.removeAttribute(k); };
export function applyAccessUI(){
  const root = document.documentElement;
  setAttr(root, "data-noperm", missingPerms().join(" "));
  setAttr(root, "data-notabs", TABS.filter(t => !tabOpen(t)).join(" "));
  setAttr(root, "data-member", isMember() ? currentRole() : "");
}
