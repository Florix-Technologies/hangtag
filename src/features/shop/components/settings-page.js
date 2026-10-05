// The Settings page (module "settings"): a searchable list of sections (services/settings-sections.js) and the section on
// screen. A desktop shows both side by side; a phone shows the list, then the section with a way back. Each section is a
// few blocks, every form with Save and Cancel (Cancel puts back what is saved). The sections a person sees follow the
// shop's type and features and the person's role; a section with nothing in it for them is not shown.
import { fitDocFrames } from '../../receipts/components/doc-render.js';
import { store } from '../../../shared/state/store.js';
import { methodNames, renderAccount } from './account-menu.js';
import { autoSendFormHTML, expenseCatsHTML, paymentsFormHTML, printerSetupHTML, receiptFormHTML, receiptSetupHTML, refreshPaymentsForm, reorderFormHTML, stockAlertHTML, taxFormsHTML } from './billing-settings.js';
import { capabilitiesHTML, onCapsSubmit, syncCapDeps, useRecommendedCaps } from './capability-settings.js';
import { can, isMember, signedInAs } from '../services/access.js';
import { settingsPartsHTML, settingsSections } from '../services/settings-sections.js';
import { CAP_LABELS } from '../../../domain/shop/capabilities.js';
import { roleLabel } from '../../../domain/shop/permissions.js';
import { shopCode } from '../../../domain/shop/staff.js';
import { shopCaps, shopTypeLabel } from '../services/shop-caps.js';
import { profileFieldsHTML, readProfileForm } from './profile-form.js';
import { saveShopProfile } from '../use-cases/save-shop-profile.js';
import { toast } from '../../../shared/components/toast.js';
import { $, esc } from '../../../shared/dom.js';
import { storage, savePrefs } from '../../../shared/state/persistence.js';
import { renderAll, setTab } from '../../../shared/ui/render.js';
import { UI_ICON, formActionsHTML, kvHTML } from '../../../shared/ui/kit.js';

/* ---------- what each section holds ---------- */
/* The features that belong to a section, and where they are switched (Business → Features) */
const SECTION_FEATURES = {
  inventory: ["uses_variants", "uses_serials", "uses_batches", "uses_expiry", "uses_weight", "uses_bundles", "uses_repack"],
  sales: ["uses_quotations", "uses_sales_orders", "uses_price_lists", "uses_vouchers"],
  purchasing: ["uses_purchase_orders"],
  billing: ["uses_einvoice", "uses_eway"],
  storefront: ["uses_mobile_store"],
  restaurant: ["uses_tables", "uses_table_qr", "uses_customer_ordering", "uses_server_ordering", "uses_kitchen"],
};
function featuresLine(key){
  const keys = SECTION_FEATURES[key]; if(!keys) return "";
  const caps = shopCaps(), on = keys.filter(k => caps[k]).map(k => CAP_LABELS[k]), off = keys.filter(k => !caps[k]).map(k => CAP_LABELS[k]);
  return `<div class="setfeat"><span>${on.length ? `<b>On:</b> ${esc(on.join(", "))}` : "No features on here yet."}${off.length ? `<br><span class="note">Off: ${esc(off.join(", "))}</span>` : ""}</span>${can("manage_settings") ? `<button type="button" class="btn sm" data-setgo="business" data-setfocus="featuresBlk">Change features</button>` : ""}</div>`;
}
const block = (title, inner, id) => inner ? `<div class="setblk"${id ? ` id="${id}"` : ""}>${title ? `<h5>${esc(title)}</h5>` : ""}${inner}</div>` : "";
const teamHTML = () => store.authUser ? `<div class="setblk" id="teamSec"><h5>Team</h5><p class="note" style="margin:0">People who sell in your shop, each with their own sign-in and role. Their phones join with a QR code you show here. Shop code for staff: <b>${esc(shopCode(store.authUser.id))}</b></p>
  <div class="btnrow" style="margin-top:12px"><button class="btn primary" type="button" data-team="open">Team &amp; devices</button><button class="btn" type="button" data-team="roles">Roles &amp; permissions</button></div></div>`
  : '<div class="setblk"><h5>Team</h5><p class="note" style="margin:0">Sign in to manage your team.</p></div>';
function youHTML(){
  if(isMember()){
    const a = store.access || {};
    return block("You", kvHTML([["Name", esc(a.name || "—"), "kvName"], ["Username", esc(a.username ? "@" + a.username : "—"), "kvUser"], ["Role", esc(roleLabel(a.role) || "—"), "kvRole"],
      ["Shop", esc(a.shopName || (store.profile && store.profile.shop_name) || "—"), "kvShop"], ["Shop code", esc(a.shopId ? shopCode(a.shopId) : "—"), "kvCode"], ["This phone", esc(a.deviceId || "—"), "kvDevice"]])
      + '<p class="note" style="margin:10px 0 0">The owner manages your role and your phones. Signing out keeps this phone ready for your next sign-in.</p><div class="btnrow" style="margin-top:12px"><button class="btn danger" type="button" data-settings-act="signout">Sign out</button></div>');
  }
  const p = store.profile || {}, u = store.authUser, since = (u && u.created_at) || p.created_at;
  return block("Your account", kvHTML([["Email", esc((u && u.email) || storage.get("hangtag_auth_email", "") || "—"), "kvEmail"], ["Signs in with", esc(methodNames()), "kvMethod"],
    ["Member since", esc(since ? new Date(since).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "—"), "kvSince"], ["Account ID", esc(u ? u.id.slice(0, 8) : "—"), "kvId"]])
    + '<div class="btnrow" style="margin-top:12px"><button class="btn danger" type="button" data-settings-act="signout">Sign out</button></div>');
}
function sectionBody(key){
  const member = isMember();
  switch(key){
    case "business":
      return (member ? block("Shop", kvHTML([["Shop", esc((store.access && store.access.shopName) || (store.profile && store.profile.shop_name) || "—")], ["Type of business", esc(shopTypeLabel())]]))
        : `<form id="profileForm" class="authform setblk" novalidate><h5>Shop details</h5>${profileFieldsHTML(store.profile || {}, "ps")}<p id="profileErr" class="autherr" role="alert" hidden></p>${formActionsHTML({ save: "Save changes", saveAttrs: 'id="profileSave"' })}</form>`)
        + `<div class="setblk" id="featuresBlk"><h5>Features</h5>${capabilitiesHTML()}</div>` + settingsPartsHTML("business");
    case "payments": return paymentsFormHTML() + settingsPartsHTML("payments") + expenseCatsHTML();
    case "billing": return receiptFormHTML() + settingsPartsHTML("billing") + receiptSetupHTML() + taxFormsHTML() + autoSendFormHTML() + featuresLine("billing");
    case "inventory": return (can("manage_settings") ? stockAlertHTML() : "") + settingsPartsHTML("inventory") + featuresLine("inventory");
    case "sales": { const parts = settingsPartsHTML("sales"); return parts ? parts + featuresLine("sales") : featuresLine("sales"); }
    case "purchasing": return reorderFormHTML() + settingsPartsHTML("purchasing") + featuresLine("purchasing");
    case "automation": return settingsPartsHTML("automation");
    case "plans": return settingsPartsHTML("plans");
    case "storefront": { const parts = settingsPartsHTML("storefront"); return parts ? parts + featuresLine("storefront") : ""; }
    case "restaurant": return settingsPartsHTML("restaurant") + featuresLine("restaurant");
    case "devices": return (member ? "" : teamHTML()) + printerSetupHTML() + settingsPartsHTML("devices") + youHTML();
    case "integrations": return settingsPartsHTML("integrations");
    case "advanced": return block("Your data", `<p class="note" style="margin:0 0 12px">Your products, stock and bills are private to this account. Download everything — products, variants, stock history, bills, returns, customers, photos and settings — as one file, any time. Restoring checks the file and shows you what it will add before anything changes.</p>
      <div class="btnrow"><button class="btn" type="button" data-settings-act="backup">${UI_ICON.download} Download backup</button><label class="btn" for="restoreIn">Restore from backup</label><input id="restoreIn" class="sr" type="file" accept="application/json,.json" data-restore><button class="btn" type="button" data-settings-act="export">Export sales (CSV)</button></div>`, "dataBlk") + settingsPartsHTML("advanced");
  }
  return "";
}
/* The sections this person sees with something in them: [{ section, body }] */
function shownSections(){ return settingsSections().map(s => ({ s, body: sectionBody(s.key) })).filter(x => x.body); }

/* ---------- search ---------- */
const plain = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/* [{ key, label, block, blockId }] matching every word typed (section names, what they're for, keywords, block titles) */
export function settingsSearch(q, list = shownSections()){
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if(!words.length) return [];
  const out = [];
  list.forEach(({ s, body }) => {
    const hay = (s.label + " " + s.sub + " " + s.keywords).toLowerCase();
    const blocks = [...body.matchAll(/<(?:div|form)[^>]*class="[^"]*setblk[^"]*"[^>]*?(?:id="([^"]+)")?[^>]*>\s*<h5>([\s\S]*?)<\/h5>/g)].map(m => ({ id: m[1] || "", title: plain(m[2]) }));
    const fields = plain(body).toLowerCase();
    let hit = false;
    blocks.forEach(b => { if(words.every(w => (b.title.toLowerCase() + " " + s.label.toLowerCase()).includes(w))){ out.push({ key: s.key, label: s.label, block: b.title, blockId: b.id }); hit = true; } });
    if(!hit && words.every(w => hay.includes(w) || fields.includes(w))) out.push({ key: s.key, label: s.label, block: "", blockId: "" });
  });
  return out.slice(0, 12);
}

/* ---------- the page ---------- */
let phonePicked = false, dirty = false;
const isPhone = () => window.innerWidth < 760;
function currentKey(list){
  const want = store.prefs && store.prefs.setSec;
  return (list.find(x => x.s.key === want) || list[0] || { s: { key: "" } }).s.key;
}
function resultsHTML(q){
  const r = settingsSearch(q);
  if(!r.length) return `<p class="note setnone">No settings match “${esc(q)}”.</p>`;
  return `<div class="olist">${r.map(x => `<button type="button" class="orow chev" data-setgo="${esc(x.key)}"${x.blockId ? ` data-setfocus="${esc(x.blockId)}"` : ""}><span class="o-main"><span class="o-t">${esc(x.block || x.label)}</span><span class="o-s">${esc(x.block ? x.label : "Section")}</span></span></button>`).join("")}</div>`;
}
export function renderSettingsPage(force){
  const host = document.getElementById("v-settings"); if(!host) return;
  const a = document.activeElement;
  if(!force && host.firstChild && (dirty || (a && host.contains(a) && a.matches && a.matches("input:not([type=checkbox]):not([type=file]), select, textarea")))) return;
  const list = shownSections(), key = currentKey(list), cur = list.find(x => x.s.key === key), q = ($("#setQ") && $("#setQ").value) || "";
  const showMain = !isPhone() || phonePicked;
  const member = isMember(), email = (store.authUser && store.authUser.email) || storage.get("hangtag_auth_email", "");
  host.innerHTML = `<div class="setpage${showMain ? " has-sec" : ""}">
    <aside class="setside"><div class="viewhead"><div><h2 class="vt">Settings</h2><p id="setSub">${esc(member ? "Signed in as " + signedInAs() : email)}</p></div></div>
      <div class="search"><input id="setQ" type="search" placeholder="Search settings" autocomplete="off" enterkeyhint="search" aria-label="Search settings" value="${esc(q)}"></div>
      <div id="setResults"${q ? "" : " hidden"}>${q ? resultsHTML(q) : ""}</div>
      <nav class="setlist" aria-label="Settings sections"${q ? " hidden" : ""}>${list.map(({ s }) => `<button type="button" class="setitem" data-setgo="${esc(s.key)}"${s.key === key && showMain ? ' aria-current="page"' : ""}>${UI_ICON[s.icon] || ""}<span><b>${esc(s.label)}</b><small>${esc(s.sub)}</small></span></button>`).join("")}</nav>
    </aside>
    ${cur ? `<section class="setmain" id="set-${esc(key)}" data-setsec="${esc(key)}" aria-labelledby="setT">
      <div class="sethead"><button type="button" class="btn text sm setback" data-setback>${UI_ICON.back} Settings</button><h3 id="setT">${esc(cur.s.label)}</h3><p>${esc(cur.s.sub)}</p></div>
      ${cur.body}</section>` : `<section class="setmain"><p class="note">Nothing to set here for your role.</p></section>`}</div>`;
  if(cur && (key === "payments" || key === "billing") && can("manage_settings")) refreshPaymentsForm();
  fitDocFrames(host);   // a document preview in a section (Billing & Documents → Templates) scaled to its width
}
/* Open Settings (on a section: "business", "payments", "billing", "inventory", "sales", "purchasing", "storefront",
   "restaurant", "devices", "integrations", "advanced"; a block to scroll to) */
let backTab = "";
export function openSettings(section, focus){
  if(store.prefs && store.prefs.tab !== "settings") backTab = store.prefs.tab;
  if(section && store.prefs){ store.prefs.setSec = section; phonePicked = true; savePrefs(); } else phonePicked = false;
  dirty = false;
  if(store.prefs && store.prefs.tab === "settings") renderSettingsPage(true); else setTab("settings");
  if(focus) focusBlock(focus);
}
/* A team member's settings are the same page (what it holds follows the role) */
export const openMemberSettings = () => openSettings();
/* Leave Settings for the page it was opened from */
export function closeSettings(){
  if(store.prefs && store.prefs.tab === "settings"){ dirty = false; setTab(backTab && backTab !== "settings" ? backTab : "home"); }
}
function focusBlock(id){
  const el = id && document.getElementById(id); if(!el) return;
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
}
export function goSettingsSection(key, focus){
  if(dirty && store.prefs && store.prefs.setSec !== key && !confirm("Discard the changes you haven't saved?")) return;
  if(store.prefs){ store.prefs.setSec = key; savePrefs(); }
  phonePicked = true; dirty = false;
  const q = $("#setQ"); if(q) q.value = "";
  renderSettingsPage(true);
  if(focus) focusBlock(focus); else if(isPhone()) window.scrollTo(0, 0);
}
export async function onProfileSubmit(form){
  const err = $("#profileErr"), btn = $("#profileSave");
  const r = readProfileForm(form);
  if(r.error){ err.textContent = r.error; err.hidden = false; return; }
  if(!store.authUser || !store.sbClient){ err.textContent = "You're offline. Changes can be saved once you're back online."; err.hidden = false; return; }
  btn.setAttribute("aria-busy", "true"); err.hidden = true;
  try{
    await saveShopProfile(r.values);
    dirty = false;
    renderAccount();
    renderAll();   // a new type of business can change what the shop uses (tabs, fields, sections)
    renderSettingsPage(true);
    toast("Profile saved.");
  }catch(e){ err.textContent = e.message || "Couldn't save. Try again."; err.hidden = false; }
  finally{ const b = $("#profileSave"); if(b) b.removeAttribute("aria-busy"); }
}

/* Registered once at start-up (app/main.js): sections, search, features, unsaved-change tracking */
export function installSettingsEvents(){
  document.addEventListener("click", e => {
    const t = e.target; if(!t || !t.closest) return;
    const go = t.closest("[data-setgo]"); if(go){ if(store.prefs && store.prefs.tab !== "settings") openSettings(go.dataset.setgo, go.dataset.setfocus); else goSettingsSection(go.dataset.setgo, go.dataset.setfocus); return; }
    if(t.closest("[data-setback]")){ if(dirty && !confirm("Discard the changes you haven't saved?")) return; phonePicked = false; dirty = false; renderSettingsPage(true); window.scrollTo(0, 0); return; }
    if(t.closest("[data-capsrec]")){ dirty = false; useRecommendedCaps(); return; }
  });
  document.addEventListener("input", e => {
    const t = e.target; if(!t || !t.closest) return;
    if(t.id === "setQ"){ const q = t.value.trim(), r = $("#setResults"), l = $(".setlist"); if(r){ r.hidden = !q; r.innerHTML = q ? resultsHTML(q) : ""; } if(l) l.hidden = !!q; return; }
    if(t.closest("#v-settings form")) dirty = true;
  });
  document.addEventListener("change", e => {
    const t = e.target; if(!t || !t.closest) return;
    if(t.closest("#v-settings form") && !t.matches("[data-logofile],[data-restore]")) dirty = true;
    const f = t.closest("#capsForm"); if(f && t.matches("[data-cap]")) syncCapDeps(f);
  });
  // a save or Cancel ends the unsaved changes (the save's own handler redraws what changed)
  document.addEventListener("submit", e => { if(e.target && e.target.closest && e.target.closest("#v-settings")) dirty = false; }, true);
  document.addEventListener("reset", e => { if(e.target && e.target.closest && e.target.closest("#v-settings")) dirty = false; });
  document.addEventListener("submit", e => { if(e.target && e.target.id === "capsForm"){ e.preventDefault(); onCapsSubmit(e.target); } });
  window.addEventListener("resize", () => { if(store.prefs && store.prefs.tab === "settings" && !dirty) renderSettingsPage(); });
}
