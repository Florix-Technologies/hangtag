// Automation on the screen: Settings → Automation (what each rule does, its timing, and the log of what was done) and
// Approvals (what waits for a person's OK, opened from Home → Needs attention). Approving a reminder opens WhatsApp with
// the message typed in — the person presses Send there; approving a reorder saves a draft purchase order (not sent).
import { AUTOMATION_RULES, LOG_ACTIONS, POLICY_LABELS, automationRule } from '../../../domain/automation/rules.js';
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { formActionsHTML } from '../../../shared/ui/kit.js';
import { ICON } from '../../../shared/constants/icons.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { approveAutomation, automationSettings, dismissAutomation, pendingApprovals, ruleUsable } from '../services/automation.js';
import { saveAutomationSettings } from '../use-cases/save-automation.js';

/* ---------- Settings → Automation ---------- */
function ruleHTML(r, A){
  const usable = ruleUsable(r), why = !usable && r.cap && !hasCap(r.cap) ? "Purchase orders are switched off for this shop (Business → Features)." : !usable ? "Your role can't act on this." : "";
  return `<fieldset class="autorule" data-autorule="${esc(r.key)}"><legend>${esc(r.label)}</legend><p class="note">${esc(r.help)}</p>
    <div class="segrow" role="radiogroup" aria-label="${esc(r.label)}">${r.policies.map(p => `<label class="segopt"><input type="radio" name="${esc(r.key)}" value="${p}"${A[r.key] === p ? " checked" : ""}><span>${esc(POLICY_LABELS[p])}</span></label>`).join("")}</div>
    ${r.field ? `<label class="f autofield"><span class="lab">${esc(r.field.label)}</span><input name="${esc(r.field.name)}" type="number" inputmode="numeric" min="${r.field.min}" max="${r.field.max}" value="${esc(A[r.field.name])}"><span class="fhint">${esc(r.field.unit)}</span></label>` : ""}
    ${why ? `<p class="note autowhy">${esc(why)}</p>` : ""}</fieldset>`;
}
function logHTML(){
  const list = (store.autoLog || []).slice(0, 30);
  if(!list.length) return `<p class="note" style="margin:0">Nothing yet. What automation does, and every approval or dismissal, shows here.</p>`;
  return `<ol class="autolog">${list.map(e => `<li data-autolog="${esc(e.action)}"><span class="al-when">${esc(dayKey(e.t) === dayKey(Date.now()) ? hhmm(e.t) : dayLab(dayKey(e.t)) + " · " + hhmm(e.t))}</span><span class="al-what"><b>${esc(LOG_ACTIONS[e.action] || e.action)}</b> · ${esc((automationRule(e.rule) || { label: e.rule }).label)}<small>${esc(e.text)}</small></span><span class="al-who">${esc(e.by || "")}</span></li>`).join("")}</ol>`;
}
export function automationSettingsHTML(){
  const A = automationSettings();
  return `<form id="autoForm" class="authform setblk" novalidate><h5>Rules</h5><p class="note" style="margin:0 0 12px">Hangtag watches your shop and either does a safe thing by itself or asks you first. It never sends anything to a customer or supplier on its own.</p>
    ${AUTOMATION_RULES.map(r => ruleHTML(r, A)).join("")}<p id="autoErr" class="autherr" role="alert" hidden></p>${formActionsHTML({ save: "Save automation" })}</form>
    <div class="setblk" id="autoLogBlk"><h5>Activity</h5><p class="note" style="margin:0 0 10px">What was done automatically, approved or dismissed, and policy changes — from every device of the shop.</p>${logHTML()}</div>`;
}

/* ---------- Approvals ---------- */
function approvalsHTML(){
  const list = pendingApprovals();
  const rows = list.length ? list.map(f => `<li class="appr" data-appr="${esc(f.key)}"><span class="appr-t"><b>${esc(f.title)}</b><small>${esc(f.sub)}</small><span class="appr-rule">${esc(automationRule(f.rule).label)}</span></span>
      <span class="appr-acts"><button type="button" class="btn sm primary" data-autoapprove="${esc(f.key)}">${esc(f.approve)}</button><button type="button" class="btn sm" data-autodismiss="${esc(f.key)}">Dismiss</button></span></li>`).join("")
    : "";
  return `<div class="scrim" data-modal-scrim><div class="sheet apprsheet" role="dialog" aria-modal="true" aria-labelledby="apprT">
    <div class="sh-head"><h3 id="apprT" style="margin:0;flex:1">Waiting for your OK</h3><button class="iconbtn" type="button" data-modal-close aria-label="Close">${ICON.x}</button></div>
    ${list.length ? `<ul class="apprlist">${rows}</ul>` : `<p class="muted" style="padding:6px 2px">Nothing is waiting. Automation asks here when a rule is set to “Ask me first”.</p>`}
    <p class="note" style="margin:12px 2px 0">Reminders open WhatsApp with the message written — you press Send. Purchase orders are saved as drafts and not sent. <button type="button" class="link xs" data-setgo="automation">Automation settings</button></p></div></div>`;
}
export function openApprovals(){ const host = $("#modalHost"); if(host) host.innerHTML = approvalsHTML(); }

let installed = false;
export function installAutomationEvents(){
  if(installed) return; installed = true;
  document.addEventListener("submit", e => {
    if(!e.target || e.target.id !== "autoForm") return;
    e.preventDefault();
    const f = new FormData(e.target), input = {};
    AUTOMATION_RULES.forEach(r => { input[r.key] = f.get(r.key); if(r.field) input[r.field.name] = f.get(r.field.name); });
    const r = saveAutomationSettings(input), err = $("#autoErr");
    if(r.error){ if(err){ err.textContent = r.error; err.hidden = false; } return; }
    if(err) err.hidden = true;
    toast(r.changed ? "Automation saved." : "Nothing changed."); renderAll();
  });
  document.addEventListener("click", e => {
    const t = e.target && e.target.closest ? e.target : null; if(!t) return;
    if(t.closest("[data-approvals]")){ e.preventDefault(); openApprovals(); return; }
    const a = t.closest("[data-autoapprove]");
    if(a){
      e.preventDefault();
      const r = approveAutomation(a.dataset.autoapprove);
      if(r.error){ toast(r.error); }
      else if(r.url){ const w = window.open(r.url, "_blank", "noopener"); if(!w) location.href = r.url; toast(r.phone ? "WhatsApp opened with the reminder. Press Send there." : "WhatsApp opened with the reminder. Pick the customer there."); }
      else if(r.po) toast(`Draft purchase order ${r.po.no} saved. It isn't sent yet.`);
      openApprovals(); renderAll(); return;
    }
    const d = t.closest("[data-autodismiss]");
    if(d){ e.preventDefault(); const r = dismissAutomation(d.dataset.autodismiss); if(r.error) toast(r.error); openApprovals(); renderAll(); }
  });
}
