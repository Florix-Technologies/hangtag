// Automation on the screen: Settings → Automation, the automation center — today at a glance (what is watched, noticed,
// done by itself, waiting for an OK), Watch (what Hangtag keeps an eye on and tells you about: Off / Notify me), Act (what
// it does by itself or asks you first), Your rules (WHEN … THEN tell me / note it / write a reminder), and the log of what
// was noticed, done, approved, dismissed, saved by the Hangtag Agent and changed — and Approvals (what waits for a
// person's OK, opened from Home → Needs attention).
// Approving a reminder opens WhatsApp with the message typed in — the person presses Send there; approving a reorder
// saves a draft purchase order (not sent).
import { AUTOMATION_RULES, LOG_ACTIONS, POLICY_LABELS, WATCH_LABELS, WATCH_POLICIES, WATCH_RULES, automationRule } from '../../../domain/automation/rules.js';
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { formActionsHTML } from '../../../shared/ui/kit.js';
import { inr, moneyLabel } from '../../../shared/formatting/money.js';
import { RULE_ACTIONS, TRIGGERS, actionsOf, ruleWords, triggerOf } from '../../../domain/automation/custom-rules.js';
import { customRules, customUsable } from '../services/custom-rules.js';
import { addCustomRule, removeCustomRule, switchCustomRule } from '../use-cases/save-automation.js';
import { liveProducts } from '../../products/services/catalog.js';
import { can } from '../../shop/services/access.js';
import { moduleShown } from '../../shop/services/modules.js';
import { AGENT_NEVER } from '../../../domain/agent/governance.js';
import { ICON } from '../../../shared/constants/icons.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { shopRegion } from '../../shop/services/region.js';
import { approveAutomation, automationSettings, dismissAutomation, pendingApprovals, ruleUsable } from '../services/automation.js';
import { watchUsable } from '../services/watchers.js';
import { saveAutomationSettings } from '../use-cases/save-automation.js';

/* ---------- Settings → Automation ---------- */
function ruleHTML(r, A){
  const usable = ruleUsable(r), why = !usable && r.cap && !hasCap(r.cap) ? "Purchase orders are switched off for this shop (Business → Features)." : !usable ? "Your role can't act on this." : "";
  return `<fieldset class="autorule" data-autorule="${esc(r.key)}"><legend>${esc(r.label)}</legend><p class="note">${esc(r.help)}</p>
    <div class="segrow" role="radiogroup" aria-label="${esc(r.label)}">${r.policies.map(p => `<label class="segopt"><input type="radio" name="${esc(r.key)}" value="${p}"${A[r.key] === p ? " checked" : ""}><span>${esc(POLICY_LABELS[p])}</span></label>`).join("")}</div>
    ${r.field ? `<label class="f autofield"><span class="lab">${esc(r.field.label)}</span><input name="${esc(r.field.name)}" type="number" inputmode="numeric" min="${r.field.min}" max="${r.field.max}" value="${esc(A[r.field.name])}"><span class="fhint">${esc(r.field.unit)}</span></label>` : ""}
    ${why ? `<p class="note autowhy">${esc(why)}</p>` : ""}</fieldset>`;
}
const CAP_WORDS = { uses_sales_orders: "sales orders", uses_mobile_store: "the online store", uses_expiry: "expiry dates", uses_batches: "batches" };
function watchHTML(r, W){
  // a rule for another tax regime (GST preparation outside India) isn't shown; its setting is kept as it is
  if(r.tax && shopRegion().tax !== r.tax) return `<input type="hidden" name="w_${esc(r.key)}" value="${esc(W[r.key])}">`;
  const off = r.caps && !r.caps.some(c => hasCap(c)), why = off ? `Switch on ${r.caps.map(c => CAP_WORDS[c] || c).join(" or ")} for this shop to use this (Business → Features).`
    : !watchUsable(r) ? "Your role doesn't see these; people whose role does are told." : "";
  return `<fieldset class="autorule watchrule" data-watchrule="${esc(r.key)}"><legend>${esc(r.label)}</legend><p class="note">${esc(r.help)}</p>
    <div class="segrow" role="radiogroup" aria-label="${esc(r.label)}">${WATCH_POLICIES.map(p => `<label class="segopt"><input type="radio" name="w_${esc(r.key)}" value="${p}"${W[r.key] === p ? " checked" : ""}><span>${esc(WATCH_LABELS[p])}</span></label>`).join("")}</div>
    ${r.field ? `<label class="f autofield"><span class="lab">${esc(r.field.label)}</span><input name="${esc(r.field.name)}" type="number" inputmode="numeric" min="${r.field.min}" max="${r.field.max}" value="${esc(W[r.field.name])}"><span class="fhint">${esc(r.field.unit)}</span></label>` : ""}
    ${why ? `<p class="note autowhy">${esc(why)}</p>` : ""}</fieldset>`;
}
/* Every entry is an audit (domain/agent/governance.js): who (by), what (the text), when, why, the tool, before and after,
   who approved it, the outcome */
const AUDIT_WORDS = { why: "Why", tool: "Tool", before: "Before", after: "After", approvedBy: "Approved by", outcome: "Outcome" };
const auditHTML = e => { const parts = Object.keys(AUDIT_WORDS).filter(k => e[k]).map(k => `<span data-audit="${k}">${AUDIT_WORDS[k]}: ${esc(k === "why" && e.rule === "agent" ? `“${e[k]}”` : e[k])}</span>`); return parts.length ? `<span class="al-audit">${parts.join("")}</span>` : ""; };
/* Activity's filter: everything, the Agent's steps, what ran by itself, approvals and dismissals, what was noticed, changes */
const LOG_FILTERS = [["all", "All", () => true], ["agent", "Agent", e => e.rule === "agent"], ["auto", "Automatic", e => e.action === "auto"],
  ["approvals", "Approvals", e => e.action === "approved" || e.action === "dismissed"], ["noticed", "Noticed", e => e.action === "notified"], ["changes", "Changes", e => e.action === "policy"]];
let logFilter = "all";
function logHTML(){
  const F = LOG_FILTERS.find(f => f[0] === logFilter) || LOG_FILTERS[0], all = store.autoLog || [], list = all.filter(F[2]).slice(0, 30);
  const chips = all.length ? `<div class="billfilters autologf" role="group" aria-label="Show">${LOG_FILTERS.map(f => `<button type="button" class="chipbtn${f[0] === F[0] ? " on" : ""}" data-logfilter="${f[0]}" aria-pressed="${f[0] === F[0]}">${esc(f[1])}</button>`).join("")}</div>` : "";
  if(!list.length) return chips + `<p class="note" style="margin:0">${all.length ? "Nothing of that kind yet." : "Nothing yet. What automation notices and does, and every approval or dismissal, shows here."}</p>`;
  return chips + logListHTML(list);
}
function logListHTML(list){
  return `<ol class="autolog">${list.map(e => `<li data-autolog="${esc(e.action)}" data-logrule="${esc(e.rule)}"><span class="al-when">${esc(dayKey(e.t) === dayKey(Date.now()) ? hhmm(e.t) : dayLab(dayKey(e.t)) + " · " + hhmm(e.t))}</span><span class="al-what"><b>${esc(LOG_ACTIONS[e.action] || e.action)}</b> · ${esc((automationRule(e.rule) || { label: e.rule }).label)}<small>${esc(e.text)}</small>${auditHTML(e)}</span><span class="al-who" title="${esc(e.by || "")}">${esc(e.by || "")}</span></li>`).join("")}</ol>`;
}
/* Today at a glance: what is watched, what was noticed and done by itself today, what waits for an OK */
function centerHTML(A){
  const today = dayKey(Date.now()), log = (store.autoLog || []).filter(e => dayKey(e.t) === today), waiting = pendingApprovals().length;
  const watching = WATCH_RULES.filter(r => A.watch[r.key] === "notify" && watchUsable(r)).length + customRules().filter(r => r.on !== false && r.action !== "remind").length;
  const k = (label, v, extra = "", cls = "") => `<div class="ac-k${cls ? " " + cls : ""}"><span>${esc(label)}</span><b>${esc(v)}</b>${extra}</div>`;
  return `<div class="autocenter" id="autoCenter" role="group" aria-label="Automation today">${k("Watching", String(watching))}${k("Noticed today", String(log.filter(e => e.action === "notified").length))}
    ${k("Done by itself today", String(log.filter(e => e.action === "auto").length))}${k("Waiting for your OK", String(waiting), waiting ? `<button type="button" class="link xs" data-approvals>Open</button>` : "", waiting ? "warn" : "")}</div>`;
}
/* The Hangtag Agent's boundaries, from its governance (one source): what it may do, what it never does, where it is recorded */
function agentRulesHTML(){
  if(!moduleShown("assistant")) return "";
  return `<div class="setblk" id="agentRulesBlk"><h5>Hangtag Agent</h5><p class="note" style="margin:0 0 8px">It reads the shop's records with the role of the person asking, opens screens, and drafts purchase orders that a person saves. It never:</p>
    <ul class="agentnever">${AGENT_NEVER.map(x => `<li>${esc(x)}</li>`).join("")}</ul><p class="note" style="margin:8px 0 0">Every answer and every proposal is in Activity (Agent): who asked, why, the tools, before and after, who approved it, the outcome.</p></div>`;
}
/* ---------- Your rules ---------- */
let CF = { trigger: "bill_over" };   // the new-rule form's trigger (its figure, product and actions follow it)
const pname = id => (liveProducts().find(p => p.id === id) || {}).name || "a product no longer sold";
function ruleFormHTML(){
  const t = triggerOf(CF.trigger) || TRIGGERS[0], P = t.param;
  const param = !P ? "" : P.kind === "hour" ? `<label class="f"><span class="lab">By</span><select name="hour">${Array.from({ length: P.max - P.min + 1 }, (_, i) => P.min + i).map(h => `<option value="${h}"${h === 11 ? " selected" : ""}>${h}:00</option>`).join("")}</select></label>`
    : `<label class="f"><span class="lab">${esc(P.kind === "money" ? moneyLabel("Amount") : P.kind === "percent" ? "Discount (%)" : "Stock level")}</span><input name="${P.name}" type="number" inputmode="decimal" min="${P.min}" step="any" autocomplete="off"></label>`;
  const prods = t.product ? liveProducts().slice().sort((a, b) => a.name.localeCompare(b.name)) : [];
  const product = t.product ? `<label class="f"><span class="lab">Product</span><select name="product"><option value="">Choose…</option>${prods.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>` : "";
  return `<form id="customRuleForm" class="authform crule-form" novalidate><div class="pgrid">
    <label class="f"><span class="lab">When</span><select name="trigger">${TRIGGERS.map(x => `<option value="${x.key}"${x.key === t.key ? " selected" : ""}>${esc(x.label)}…</option>`).join("")}</select></label>
    ${param}${product}<label class="f"><span class="lab">Then</span><select name="action">${actionsOf(t).map(a => `<option value="${a}">${esc(RULE_ACTIONS[a])}</option>`).join("")}</select></label></div>
    <p id="customErr" class="autherr" role="alert" hidden></p><div class="setactions"><button class="btn sm primary" type="submit">Add rule</button></div></form>`;
}
function customHTML(){
  const list = customRules(), may = can("manage_settings");
  const rows = list.map(r => `<li class="crule${r.on === false ? " off" : ""}" data-crule="${esc(r.id)}"><span class="crule-t"><b>${esc(ruleWords(r, r.product ? pname(r.product) : ""))}</b><small>${esc(RULE_ACTIONS[r.action])}${r.on === false ? " · off" : ""}${customUsable(r) ? "" : " · your role isn't told"}</small></span>
    ${may ? `<span class="crule-acts"><label class="chk"><input type="checkbox" data-customon="${esc(r.id)}"${r.on !== false ? " checked" : ""}> On</label><button type="button" class="link xs" data-customrm="${esc(r.id)}">Remove</button></span>` : ""}</li>`).join("");
  return `<div class="setblk" id="customRulesBlk"><h5>Your rules</h5><p class="note" style="margin:0 0 10px">When something happens in the shop, tell you, note it, or write a reminder for your OK. A rule never changes a bill, stock, a price or a payment, and never sends anything by itself.</p>
    ${list.length ? `<ul class="crules">${rows}</ul>` : `<p class="note" style="margin:0 0 10px">No rules of your own yet. For example: a bill over ${esc(inr(10000))} → tell me; a discount over 20% → tell me; a customer owing more than ${esc(inr(5000))} → write a reminder.</p>`}
    ${may ? ruleFormHTML() : ""}</div>`;
}
export function automationSettingsHTML(){
  const A = automationSettings();
  return `${centerHTML(A)}<form id="autoForm" class="authform setblk" novalidate>
    <section class="autogroup" data-autogroup="watch" aria-labelledby="autoWatchH"><h5 id="autoWatchH">Watch</h5><p class="note" style="margin:0 0 12px">Hangtag keeps an eye on these and tells you under Home → Needs attention (and once a day in Activity below). Watching never changes anything.</p>
    ${WATCH_RULES.map(r => watchHTML(r, A.watch)).join("")}</section>
    <section class="autogroup" data-autogroup="act" aria-labelledby="autoActH"><h5 id="autoActH">Act</h5><p class="note" style="margin:0 0 12px">Hangtag either does a safe thing by itself or asks you first. It never sends anything to a customer or supplier on its own.</p>
    ${AUTOMATION_RULES.map(r => ruleHTML(r, A)).join("")}</section><p id="autoErr" class="autherr" role="alert" hidden></p>${formActionsHTML({ save: "Save automation" })}</form>
    ${customHTML()}${agentRulesHTML()}
    <div class="setblk" id="autoLogBlk"><h5>Activity</h5><p class="note" style="margin:0 0 10px">What was noticed, done automatically, approved or dismissed, what the Hangtag Agent saved, and policy changes — from every device of the shop.</p><div class="autolog-body">${logHTML()}</div></div>`;
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
  // Your rules: the form follows its trigger; adding, switching and removing a rule
  document.addEventListener("change", e => {
    const t = e.target; if(!t || !t.closest) return;
    if(t.name === "trigger" && t.closest("#customRuleForm")){ CF = { trigger: t.value }; const f = $("#customRuleForm"); if(f){ f.outerHTML = ruleFormHTML(); const n = $("#customRuleForm [name=trigger]"); if(n) n.focus({ preventScroll: true }); } return; }
    if(t.matches("[data-customon]")){ const r = switchCustomRule(t.dataset.customon, t.checked); if(r.error) toast(r.error); else toast(t.checked ? "Rule switched on." : "Rule switched off."); renderAll(); }
  });
  document.addEventListener("click", e => {
    const lf = e.target && e.target.closest ? e.target.closest("[data-logfilter]") : null;
    if(lf){ logFilter = lf.dataset.logfilter; const blk = $("#autoLogBlk .autolog-body"); if(blk) blk.innerHTML = logHTML(); return; }
    const b = e.target && e.target.closest ? e.target.closest("[data-customrm]") : null; if(!b) return;
    e.preventDefault(); const r = removeCustomRule(b.dataset.customrm); toast(r.error || "Rule removed."); renderAll();
  });
  document.addEventListener("submit", e => {
    if(!e.target || e.target.id !== "customRuleForm") return;
    e.preventDefault();
    const f = new FormData(e.target), input = {}; ["trigger", "amount", "pct", "qty", "hour", "product", "action"].forEach(k => { if(f.get(k) != null) input[k] = f.get(k); });
    const r = addCustomRule(input), err = $("#customErr");
    if(r.error){ if(err){ err.textContent = r.error; err.hidden = false; } const fld = r.field && e.target.querySelector(`[name="${r.field}"]`); if(fld) fld.focus(); return; }
    CF = { trigger: r.rule.trigger }; toast("Rule added."); renderAll();
  });
  document.addEventListener("submit", e => {
    if(!e.target || e.target.id !== "autoForm") return;
    e.preventDefault();
    const f = new FormData(e.target), input = {};
    AUTOMATION_RULES.forEach(r => { input[r.key] = f.get(r.key); if(r.field) input[r.field.name] = f.get(r.field.name); });
    WATCH_RULES.forEach(r => { input["w_" + r.key] = f.get("w_" + r.key); if(r.field) input[r.field.name] = f.get(r.field.name); });
    const r = saveAutomationSettings(input), err = $("#autoErr");
    if(r.error){ if(err){ err.textContent = r.error; err.hidden = false; } return; }
    if(err) err.hidden = true;
    toast(r.changed ? "Automation saved." : "Nothing changed."); renderAll();
  });
  // "Prepare GST" (the GST watch) names its month: set before the GST view's own click handler opens it on that month
  document.addEventListener("click", e => {
    const g = e.target && e.target.closest ? e.target.closest("[data-gstmonth]") : null;
    if(g && /^\d{4}-(0[1-9]|1[0-2])$/.test(g.dataset.gstmonth || "")) store.gstView = Object.assign({}, store.gstView, { month: g.dataset.gstmonth });
  }, true);
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
