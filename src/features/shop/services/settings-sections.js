// Settings, in sections: which sections the person signed in sees, and the parts other features add to a section
// (e.g. Hardware → the weighing scale). Sections never depend on the type of business: Team & devices and Roles &
// permissions are there for every shop's owner. What a section may change is still checked by its use cases (and the
// database); a section a person can't use is simply not shown.
import { can, isMember } from './access.js';

/* key, label, who sees it: owner (the shop's owner only) or perms (any of these; the owner has all) */
export const SETTINGS_SECTIONS = [
  { key: "business", label: "Business", perms: ["manage_settings"] },
  { key: "capabilities", label: "Capabilities", perms: ["manage_settings"] },
  { key: "receipt", label: "Receipt", perms: ["manage_settings"] },
  { key: "taxes", label: "Taxes", perms: ["manage_settings"] },
  { key: "team", label: "Team & devices", owner: true },
  { key: "roles", label: "Roles & permissions", owner: true },
  { key: "selling", label: "Selling", perms: ["manage_products", "manage_settings", "create_sale"], parts: true },
  { key: "hardware", label: "Hardware" },
  { key: "advanced", label: "Advanced", owner: true, parts: true },
  { key: "account", label: "Account" },
];
/* The sections this person sees, in order */
export function settingsSections(){
  return SETTINGS_SECTIONS.filter(s => s.owner ? !isMember() : !s.perms || s.perms.some(p => can(p)));
}

const PARTS = new Map();
/* Add a part to a section: { id, order, perms: [any of these] (none: everyone who sees the section), html(): markup }.
   Registering the same id again replaces it. */
export function registerSettingsPart(section, def){
  if(!PARTS.has(section)) PARTS.set(section, new Map());
  PARTS.get(section).set(def.id, Object.assign({ order: 100, perms: [] }, def));
}
/* The markup of a section's added parts (the ones this person may use) */
export function settingsPartsHTML(section){
  const list = [...(PARTS.get(section) || new Map()).values()].filter(d => !d.perms.length || d.perms.some(p => can(p))).sort((a, b) => a.order - b.order);
  return list.map(d => { try{ return d.html() || ""; }catch{ return ""; } }).join("");
}
