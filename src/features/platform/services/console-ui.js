// The Platform Console's small shared pieces: the error panel that says what to do next, and the formatters the pages use.
import { esc } from '../../../shared/dom.js';
import { dateText, dtLong } from '../../../shared/formatting/dates.js';
import { inrx, numberText } from '../../../shared/formatting/money.js';

export const money = v => inrx(+v || 0);
export const count = v => numberText(+v || 0);
export const when = v => { const t = Date.parse(v); return Number.isFinite(t) ? dtLong(t) : "—"; };
export const day = v => { const t = Date.parse(v); return Number.isFinite(t) ? dateText(t) : "—"; };
export const loadingHTML = title => `<div class="pc-page"><div class="pc-head"><h1>${esc(title)}</h1></div><p class="note" role="status">Loading…</p></div>`;
/* A message under a page's title: tone ok | bad */
export const msgHTML = (msg, tone) => msg ? `<p class="pc-msg ${tone === "ok" ? "ok" : tone === "bad" ? "bad" : ""}" role="status">${esc(msg)}</p>` : "";

/* What went wrong, and what to do (a PlatformError: DENIED, REFUSED, AUTH, OUTDATED, NETWORK…) */
export function errorPanelHTML(title, e, { retry = true } = {}){
  const code = e && e.code;
  const msg = code === "DENIED" ? "Your console role can't open this." : code === "AUTH" ? "Your sign-in has ended. Sign in again." : (e && e.message) || "Something went wrong.";
  const act = code === "AUTH" ? `<p><button type="button" class="btn sm" data-pc="signout">Sign in again</button></p>`
    : retry && code !== "DENIED" ? `<p><button type="button" class="btn sm" data-pc="retry">Try again</button></p>` : "";
  return `<div class="pc-page">${title ? `<div class="pc-head"><h1>${esc(title)}</h1></div>` : ""}<div class="pc-empty" role="alert"><p>${esc(msg)}</p>${act}</div></div>`;
}
/* A date picked in a form (yyyy-mm-dd) → the end of that day in India, as the database takes it; "" → "" (no date) */
export const endOfDay = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? new Date(v + "T23:59:59+05:30").toISOString() : "");
export const startOfDay = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? new Date(v + "T00:00:00+05:30").toISOString() : "");
/* A timestamp → yyyy-mm-dd in India (for a date input) */
export const dateInput = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10) : ""; };
