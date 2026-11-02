// The shared UI kit: markup for the components in styles/15-ui.css, so every screen draws them the same way.
//   UI_ICON          stroked 24 px icons in the text colour (one family; the nav uses shared/constants/nav-icons.js)
//   statusChip       a state ("Paid", "Overdue", "Ready") — colour says ok / warn / bad / info / muted, never decoration
//   emptyStateHTML   what a list looks like with nothing in it, and the one next step
//   sheetHTML        a sheet (a phone) / dialog (wider): title, line under it, body, actions at the foot
//   formActionsHTML  a form's Save / Cancel (Cancel puts the form back as it was saved: a reset button)
//   actionsMenuHTML  "More actions" for a record or document: a menu (a sheet on a phone); only the actions given
//   kvHTML           a record's facts as label / value rows ([label, value html, optional id for the value])
// The menus open and close through installMenus() (one listener, app/main.js).
import { esc } from '../dom.js';

const svg = (d, w = 18) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const UI_ICON = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  scan: svg('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13.5 8v8M17 8v8"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  micOff: svg('<path d="M15 10.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11a6.5 6.5 0 0 1-.6 2.7M12 17.5V21M3 3l18 18"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  back: svg('<path d="m15 6-6 6 6 6"/>'),
  print: svg('<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14.5h10V21H7z"/>'),
  download: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15"/>'),
  share: svg('<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="m8.7 10.8 6.6-3.9M8.7 13.2l6.6 3.9"/>'),
  send: svg('<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5-7.5-4z"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>'),
  chat: svg('<path d="M20.5 12a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.2-4.2A8.5 8.5 0 1 1 20.5 12z"/>'),
  link: svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>'),
  qr: svg('<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM18 14h2.5M14 18v2.5"/>'),
  edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  archive: svg('<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M5 8.5V20h14V8.5M10 12.5h4"/>'),
  duplicate: svg('<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3M14.5 12v5M12 14.5h5"/>'),
  convert: svg('<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>'),
  receipt: svg('<path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>'),
  doc: svg('<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h5"/>'),
  truck: svg('<path d="M3 6.5h11v9H3z"/><path d="M14 9.5h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>'),
  box: svg('<path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9"/>'),
  bank: svg('<path d="M3.5 9 12 4l8.5 5M5 9v8.5M9.5 9v8.5M14.5 9v8.5M19 9v8.5M3.5 20.5h17"/>'),
  transfer: svg('<path d="M4 8.5h15l-3.5-3.5M20 15.5H5l3.5 3.5"/>'),
  moneyIn: svg('<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>'),
  moneyOut: svg('<path d="M12 20V8M7 13l5-5 5 5M5 4h14"/>'),
  adjust: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  user: svg('<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>'),
  store: svg('<path d="M4 9.5 5.6 4.5h12.8L20 9.5"/><path d="M4 9.5h16v.7a2.9 2.9 0 0 1-5.3 1.6 2.9 2.9 0 0 1-5.4 0A2.9 2.9 0 0 1 4 10.2z"/><path d="M5.5 13v7h13v-7"/><path d="M10 20v-4h4v4"/>'),
  open: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  alert: svg('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17v.2"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.2"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
  refresh: svg('<path d="M19.5 10.5A8 8 0 0 0 5.6 6.7L4 8.3"/><path d="M4 4.5v3.8h3.8"/><path d="M4.5 13.5a8 8 0 0 0 13.9 3.8l1.6-1.6"/><path d="M20 19.5v-3.8h-3.8"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>'),
  sparkle: svg('<path d="M12 3.5 13.8 10 20.5 12l-6.7 2-1.8 6.5-1.8-6.5L3.5 12l6.7-2z"/>'),
  tag: svg('<path d="M3.5 13.6V5.5a2 2 0 0 1 2-2h8.1l8.4 8.4a2 2 0 0 1 0 2.8l-7.2 7.2a2 2 0 0 1-2.8 0z"/><circle cx="8.5" cy="8.5" r="1.6"/>'),
};

const TONES = ["ok", "warn", "bad", "info", "muted"];
/* A state: tone "ok" | "warn" | "bad" | "info" | "muted" | "" (neutral) */
export const statusChip = (text, tone = "", attrs = "") => `<span class="chip-s${TONES.includes(tone) ? " " + tone : ""}"${attrs ? " " + attrs : ""}>${esc(text)}</span>`;

/* { icon (a UI_ICON key or markup), title, text, actions (markup), cls } */
export function emptyStateHTML({ icon = "box", title = "", text = "", actions = "", cls = "" } = {}){
  const ic = UI_ICON[icon] || icon || "";
  return `<div class="empty${cls ? " " + cls : ""}">${ic ? `<span class="e-ic">${ic}</span>` : ""}${title ? `<b>${esc(title)}</b>` : ""}${text ? `<p>${esc(text)}</p>` : ""}${actions ? `<div class="btnrow">${actions}</div>` : ""}</div>`;
}

/* { id, cls, title, sub, body, foot, keep (a tap beside it doesn't close it: work in progress), label } */
export function sheetHTML({ id = "", cls = "", title = "", sub = "", body = "", foot = "", keep = false, label = "" } = {}){
  const hid = (id || "sheet") + "T";
  return `<div class="scrim" data-modal-scrim${keep ? " data-keep" : ""}><div class="sheet${cls ? " " + cls : ""}"${id ? ` id="${esc(id)}"` : ""} role="dialog" aria-modal="true" aria-labelledby="${esc(hid)}">
    <div class="sh-head"><div class="sh-t"><h3 id="${esc(hid)}">${esc(title)}</h3>${sub ? `<p>${sub}</p>` : ""}</div><button class="iconbtn" type="button" data-modal-close aria-label="${esc(label || "Close")}">${UI_ICON.x}</button></div>
    ${body}${foot ? `<div class="sh-foot"><div class="sh-acts">${foot}</div></div>` : ""}</div></div>`;
}

/* A form's Save / Cancel: { save: "Save changes", cancel: "Cancel" | false, note, saveAttrs } */
export function formActionsHTML({ save = "Save changes", cancel = "Cancel", note = "", saveAttrs = "" } = {}){
  return `<div class="formacts">${note ? `<span class="fa-note">${esc(note)}</span>` : ""}${cancel ? `<button class="btn" type="reset">${esc(cancel)}</button>` : ""}<button class="btn primary" type="submit"${saveAttrs ? " " + saveAttrs : ""}>${esc(save)}</button></div>`;
}

/* rows: [[label, value markup], …] (a row with an empty value is left out) */
export const kvHTML = rows => `<dl class="kv">${(rows || []).filter(r => r && r[1] !== "" && r[1] != null).map(([k, v, id]) => `<dt>${esc(k)}</dt><dd${id ? ` id="${esc(id)}"` : ""}>${v}</dd>`).join("")}</dl>`;

/* "More actions" for one record: items [{ label, attrs (the action's data-* attributes), icon, hint, danger, disabled, sep }].
   Only real actions go in (a caller leaves out what can't be done). → the button with its menu, or "" with no actions */
export function actionsMenuHTML(id, items, { label = "More", primary = false, up = false } = {}){
  const list = (items || []).filter(Boolean);
  if(!list.length) return "";
  const body = list.map(it => it.sep ? "<hr>" : it.head ? `<div class="menu-h">${esc(it.head)}</div>`
    : `<button type="button" role="menuitem" ${it.attrs || ""}${it.danger ? ' class="danger"' : ""}${it.disabled ? " disabled" : ""}>${it.icon ? UI_ICON[it.icon] || "" : ""}<span>${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ""}</span></button>`).join("");
  return `<span class="menuwrap"><button type="button" class="btn${primary ? " primary" : ""}" data-menu="${esc(id)}" aria-haspopup="menu" aria-expanded="false"${label ? "" : ' aria-label="More actions" title="More actions"'}>${esc(label)}${label ? " " : ""}${UI_ICON.more}</button><div class="menu${up ? " up" : ""}" role="menu" data-menufor="${esc(id)}" hidden>${body}</div></span>`;
}
export function closeMenus(except){
  document.querySelectorAll(".menu[data-menufor]:not([hidden])").forEach(m => { if(m === except) return; m.hidden = true; const b = m.parentElement && m.parentElement.querySelector("[data-menu]"); if(b) b.setAttribute("aria-expanded", "false"); });
}
let menusOn = false;
/* One listener for every actions menu: its button opens it, a choice or a tap elsewhere closes it (Escape too) */
export function installMenus(){
  if(menusOn) return; menusOn = true;
  document.addEventListener("click", e => {
    const t = e.target; if(!t || !t.closest) return;
    const b = t.closest("[data-menu]");
    if(b){
      const m = b.parentElement && b.parentElement.querySelector(".menu[data-menufor]");
      if(m){ const open = m.hidden; closeMenus(m); m.hidden = !open; b.setAttribute("aria-expanded", String(open)); if(open){ const f = m.querySelector("button:not([disabled])"); if(f) f.focus({ preventScroll: true }); } }
      return;
    }
    if(t.closest(".menu[data-menufor]")){ if(t.closest("[role=menuitem]")) setTimeout(() => closeMenus(), 0); return; }
    closeMenus();
  }, true);
  document.addEventListener("keydown", e => { if(e.key === "Escape" && document.querySelector(".menu[data-menufor]:not([hidden])")){ closeMenus(); e.stopPropagation(); } }, true);
}
