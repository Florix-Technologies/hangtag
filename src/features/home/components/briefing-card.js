// Home's morning briefing for the owner (reports/services/daily-briefing.js): the one thing to do first, then yesterday,
// the products, the payments overdue, the purchase orders expected and the money — each line with where to act (folded
// under the first thing until opened: Home's figures and Needs attention say most of it already). Shared as text (the
// phone's share sheet, else WhatsApp) and hidden until tomorrow with one tap.
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { UI_ICON } from '../../../shared/ui/kit.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { REF_LABELS } from '../../../domain/reports/business-today.js';
import { briefingView } from '../../reports/services/daily-briefing.js';

const go = ref => ref ? `<button type="button" class="link xs" data-agentopen="${esc(ref.target)}|${esc(ref.id || "")}">${esc(REF_LABELS[ref.target] || "Open")} ${UI_ICON.chevron}</button>` : "";
/* Hidden for today (the owner tapped "Hide for today") */
export const briefingHidden = (now = Date.now()) => !!(store.prefs && store.prefs.briefingHidden === dayKey(now));
export function briefingHTML(now = Date.now()){
  if(briefingHidden(now)) return "";
  const B = briefingView(now);
  const sections = B.sections.map(s => `<section class="brf-sec" data-brfsec="${esc(s.key)}"><h4>${esc(s.title)}</h4><ul>${s.lines.map(l => `<li data-brf="${esc(s.key + ":" + l.id)}"><span>${esc(l.text)}</span>${go(l.ref)}</li>`).join("")}</ul></section>`).join("");
  return `<section class="card hcard hbrief" aria-label="Morning briefing"><div class="card-h"><h3>${esc(B.title)}</h3><span class="brf-acts"><button type="button" class="link xs" data-brief="share">Share</button><button type="button" class="link xs" data-brief="hide">Hide for today</button></span></div>
    <div class="brf-first${B.quiet ? " quiet" : ""}"><b>${B.quiet ? "All clear" : "First"}</b><span>${esc(B.first.text)}</span>${B.first.ref ? `<button type="button" class="btn sm${B.quiet ? "" : " primary"}" data-agentopen="${esc(B.first.ref.target)}|${esc(B.first.ref.id || "")}">${esc(REF_LABELS[B.first.ref.target] || "Open")}</button>` : ""}</div>
    ${sections ? `<details class="brf-more"${store.homeBriefOpen ? " open" : ""}><summary>${esc(B.sections.map(x => x.title).join(" · "))}</summary><div class="brf-grid">${sections}</div></details>` : ""}</section>`;
}
/* The briefing as text, to share */
export const briefingText = (now = Date.now()) => briefingView(now).text;
