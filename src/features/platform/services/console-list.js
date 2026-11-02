// The Platform Console's list pages (Customers, Subscriptions, Payments): the pieces they share. Badges, the lists as chips
// with their counts, a pager, the loading, empty and error states, the side panel a row opens, and the address kept in
// step with the list shown (so a list can be reloaded or shared).
import { esc } from '../../../shared/dom.js';
import { routeHash } from '../../../domain/platform/console.js';
import { count } from './console-ui.js';

export const badgeHTML = b => `<span class="chip-s nodot${b && b.tone ? " " + b.tone : ""}">${esc(b ? b.label : "—")}</span>`;

/* The lists ([[key, label]…]) as toggle chips, each with how many it holds for this search */
export function chipsHTML(lists, counts, current, label){
  return `<div class="pc-chips" role="group" aria-label="${esc(label)}">${lists.map(([k, l]) =>
    `<button type="button" class="pc-chip" data-pc-list="${esc(k)}" aria-pressed="${k === current ? "true" : "false"}">${esc(l)}${counts && counts[k] != null
      ? ` <b>${esc(count(counts[k]))}</b>` : ""}</button>`).join("")}</div>`;
}
/* Repaint a part only when it changed, keeping the focus on the same chip (a keyboard user keeps their place) */
const painted = new WeakMap();
export function paint(el, html){
  if(painted.get(el) === html) return;
  const f = document.activeElement, key = f && el.contains(f) && f.dataset ? f.dataset.pcList : null;
  el.innerHTML = html; painted.set(el, html);
  if(key){ const b = el.querySelector(`[data-pc-list="${key}"]`); if(b) b.focus(); }
}
export function pagerHTML(total, offset, limit){
  if(!total) return "";
  const to = Math.min(total, offset + limit);
  return `<nav class="pc-pager" aria-label="Pages"><span class="note">${esc(count(offset + 1))}–${esc(count(to))} of ${esc(count(total))}</span>
    <button type="button" class="btn sm" data-pc-page="prev"${offset <= 0 ? " disabled" : ""}>Previous</button>
    <button type="button" class="btn sm" data-pc-page="next"${to >= total ? " disabled" : ""}>Next</button></nav>`;
}
export const listLoadingHTML = () => `<p class="note pc-loading" role="status">Loading…</p>`;
/* Nothing to show: why, and (when a search or a list narrowed it) the way back to everything */
export const listEmptyHTML = (msg, narrowed) => `<div class="pc-empty"><p>${esc(msg)}</p>${narrowed ? '<p><button type="button" class="btn sm" data-pc-clear>Show all</button></p>' : ""}</div>`;
export function listErrorHTML(e){
  const msg = e && e.code === "DENIED" ? "Your console role can't open this." : e && e.code === "AUTH" ? "Your sign-in has ended. Sign in again." : (e && e.message) || "Something went wrong.";
  const act = e && e.code === "AUTH" ? '<button type="button" class="btn sm" data-pc="signout">Sign in again</button>'
    : e && e.code === "DENIED" ? "" : '<button type="button" class="btn sm" data-pc-reload>Try again</button>';
  return `<div class="pc-empty" role="alert"><p>${esc(msg)}</p>${act ? `<p>${act}</p>` : ""}</div>`;
}
/* The address follows the list shown, without reloading the page */
export function setAddress(route, query){
  const h = routeHash(route, query);
  if(location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
}
/* A label and a value, for the panels' fact lists */
export const kv = (label, value, html = false) => `<div><dt>${esc(label)}</dt><dd>${html ? value : esc(value == null || value === "" ? "—" : String(value))}</dd></div>`;

/* The side panel a row opens: a modal dialog over the page; ✕, Escape or the shade close it and focus goes back where it was.
   One at a time: opening another closes the first. */
let current = null;
export function openPanel(host, { label, onClose } = {}){
  if(current) current.close();
  const back = document.activeElement;
  const wrap = document.createElement("div");
  wrap.className = "pc-panel-wrap";
  wrap.innerHTML = `<div class="pc-panel-shade" data-pc-close></div><aside class="pc-panel" role="dialog" aria-modal="true" aria-label="${esc(label || "Details")}" tabindex="-1">
    <header class="pc-panel-head"><div class="pc-panel-title"></div><button type="button" class="btn sm" data-pc-close aria-label="Close">✕</button></header>
    <div class="pc-panel-body"></div></aside>`;
  host.appendChild(wrap);
  const panel = wrap.querySelector(".pc-panel");
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    if(current && current.wrap === wrap) current = null;
    if(!wrap.isConnected) return;
    wrap.remove();
    if(back && back.isConnected && back.focus) back.focus({ preventScroll: true });
    if(onClose) onClose();
  };
  // (a panel the page took away when it changed section just stops listening)
  const onKey = e => {
    if(!wrap.isConnected){ close(); return; }
    if(e.key === "Escape" && !wrap.querySelector(".pc-confirm")){ e.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  // the second click of a double-click on a row lands on the shade: it doesn't close what the first one opened
  const opened = Date.now();
  wrap.addEventListener("click", e => {
    const t = e.target.closest && e.target.closest("[data-pc-close]");
    if(t && !(t.classList.contains("pc-panel-shade") && Date.now() - opened < 500)) close();
  });
  panel.focus({ preventScroll: true });
  current = { wrap, close };
  return { wrap, panel, title: wrap.querySelector(".pc-panel-title"), body: wrap.querySelector(".pc-panel-body"), close };
}
