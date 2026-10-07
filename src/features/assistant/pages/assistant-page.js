// The Hangtag Agent's page: ask in plain language; answers come from the shop's own records through the Agent's tools
// (services/agent-tools.js, with this person's role). An answer may offer buttons — open a bill, product, customer or
// report, or ask a next question — and a draft (a purchase order from Smart reorder) that is saved only when the person
// taps Save, as a draft that isn't sent. Questions the Agent doesn't know go to the shop's AI provider when one is set up
// (the agent Edge Function; services/agent-runner.js): it can only use the same tools.
import { $, esc } from '../../../shared/dom.js';
import { use } from '../../../shared/di/services.js';
import { store } from '../../../shared/state/store.js';
import { savePrefs } from '../../../shared/state/persistence.js';
import { setTab, renderAll } from '../../../shared/ui/render.js';
import { toast } from '../../../shared/components/toast.js';
import { inr } from '../../../shared/formatting/money.js';
import { agentTool } from '../../../domain/agent/agent-tools.js';
import { can, currentRole, refuse } from '../../shop/services/access.js';
import { chooseSubview } from '../../shop/services/modules.js';
import { createReadOnlyBusinessQuery } from '../services/business-query.js';
import { createBusinessAssistant } from '../services/business-assistant.js';
import { appAgentToolHost } from '../services/agent-tools.js';
import { createAgentAI } from '../services/agent-runner.js';
import { confirmAgentProposal, dismissAgentProposal } from '../use-cases/agent-actions.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';
import { openBillView } from '../../receipts/components/bill-view.js';
import { openProductView } from '../../products/components/product-view.js';
import { openCustHistory } from '../../customers/components/customer-picker.js';
import { openSettings } from '../../shop/components/settings-page.js';
import { answerAudit } from '../../../domain/agent/governance.js';
import { logAutomation } from '../../automation/services/automation.js';
import { logger } from '../../../shared/logging/logger.js';
import { endTrace, startTrace, traceStep } from '../../../shared/logging/diagnostics.js';

/* The questions offered first, by what the role's day is about (domain/shop/role-workspace.js ROLE_FOCUS): the owner's
   money, profit, GST and bank; a manager's sales, stock, orders and purchases; anyone else the everyday ones */
const SUGGESTIONS = {
  owner: ['Morning briefing', 'What’s unusual today?', 'Profit this month', 'GST this month', 'Cash in hand', 'Bank balances', 'Who owes me money?', 'What should I reorder?', 'UPI to verify', 'What can you do?'],
  manager: ['What’s unusual today?', 'How much did I sell today?', 'What should I reorder?', 'Low stock', 'Open orders', 'Purchase orders to receive', 'Who owes me money?', 'Draft a purchase order', 'What can you do?'],
  other: ['How much did I sell today?', 'What should I reorder?', 'Who owes me money?', 'Recent bills', 'Sales trend', 'UPI to verify', 'Profit this month', 'Draft a purchase order', 'What can you do?'],
};
const suggestions = () => SUGGESTIONS[currentRole()] || SUGGESTIONS.other;

let state = { busy: false, question: '', answer: null, saved: null }, requestVersion = 0;
let inventorySource = kind => {
  const rows = inventoryIntelligence().products;
  if(kind === 'reorder' || kind === 'low') return rows.filter(row => row.shouldReorder);
  if(kind === 'dead') return rows.filter(row => row.hasDeadStock);
  if(kind === 'slow') return rows.filter(row => row.hasSlowStock);
  if(kind === 'fast') return rows.filter(row => row.fastMoving);
  return rows;
};

export function configureAssistantInventory(source){ inventorySource = typeof source === 'function' ? source : () => []; one = null; }
/* one assistant for the page, so a follow-up ("and yesterday?") knows the question before it */
let one = null, ai = null;
const online = () => !!store.sbClient && store.sbStatus === 'connected';
function assistant(){
  if(one) return one;
  ai = createAgentAI({ provider: use('agentProvider'), host: () => appAgentToolHost(), online });
  if(online()) ai.prepare().catch(() => {});
  return (one = createBusinessAssistant({ query: createReadOnlyBusinessQuery({ inventory: kind => inventorySource(kind) }), tools: () => appAgentToolHost(), provider: ai }));
}

const actionHTML = a => a.kind === 'ask' ? `<button type="button" class="btn sm" data-ask-question="${esc(a.question)}">${esc(a.label)}</button>`
  : `<button type="button" class="btn sm" data-agentopen="${esc(a.target)}|${esc(a.id)}">${esc(a.label)}</button>`;
function proposalHTML(p){
  if(!p || p.kind !== 'purchase_order') return '';
  return `<section class="agent-prop" aria-label="Draft purchase order"><h4>Draft purchase order · ${esc(p.supplier || 'Supplier')}</h4>
    <table class="agent-lines"><thead><tr><th>Product</th><th>Qty</th><th>Cost</th></tr></thead><tbody>${p.items.map(l => `<tr><td>${esc(l.name)}${l.vl ? ` <span class="szl">${esc(l.vl)}</span>` : ''}</td><td>${esc(String(l.q))}${l.u ? ' ' + esc(l.u) : ''}</td><td>${l.price == null ? '—' : inr(l.price * l.q)}</td></tr>`).join('')}</tbody></table>
    <p class="note">${p.total ? `About ${inr(p.total)} at the last cost prices. ` : ''}Saved as a draft for you to check — it isn't sent to the supplier.</p>
    <div class="btnrow"><button type="button" class="btn primary" data-agentconfirm>Save draft purchase order</button><button type="button" class="btn" data-agentdismiss>Not now</button></div></section>`;
}
function answerHTML(answer){
  if(!answer) return `<div class="ask-empty"><b>Hi 👋 Ask in plain language</b><p>Sales, profit, stock, payments, customer dues, reorders and more — answered from this shop's records. The Agent can open bills, products and customers, and draft a reorder; anything it would save waits for your OK. It never changes bills, stock, payments, prices or GST records.</p></div>`;
  const badge = answer.source === 'local' ? '<span class="btag ok">From your shop&rsquo;s data</span>' : answer.source === 'provider' ? '<span class="btag c">AI · from your shop&rsquo;s data</span>' : '<span class="btag">Not understood</span>';
  const used = answer.source === 'provider' && answer.toolsUsed && answer.toolsUsed.length ? `<p class="note ask-used">Checked: ${esc([...new Set(answer.toolsUsed)].map(n => (agentTool(n) || { title: n }).title).join(', '))}</p>` : '';
  const saved = state.saved ? `<p class="agent-saved" role="status">Saved as draft ${esc(state.saved.no || 'purchase order')}. Check it and send it from Purchase orders. <button type="button" class="link xs" data-navsub="stock:pos">Open purchase orders</button></p>` : '';
  return `<article class="card ask-answer" aria-live="polite">${badge}${state.question ? `<p class="ask-q">“${esc(state.question)}”</p>` : ''}<h3>${esc(answer.title)}</h3><p>${esc(answer.text)}</p>${answer.rows && answer.rows.length ? `<dl>${answer.rows.map(row => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join('')}</dl>` : ''}
    ${answer.actions && answer.actions.length ? `<div class="btnrow ask-acts">${answer.actions.map(actionHTML).join('')}</div>` : ''}${state.saved ? '' : proposalHTML(answer.proposal)}${saved}${used}</article>`;
}

export function renderAssistantPage(){
  const host = $('#v-assistant'); if(!host) return;
  if(!can('view_reports')){ host.innerHTML = '<div class="empty"><b>The Hangtag Agent is unavailable</b><p>Your role cannot view business reports.</p></div>'; return; }
  host.innerHTML = `<div class="viewhead"><div><div class="eyebrow">Your shop&rsquo;s assistant</div><h2 class="vt">Hangtag Agent</h2><p>Answers from your sales, payments, customers and stock. It can open what you ask for and draft reorders — you confirm anything it would save.</p></div></div>
    <div class="ask-shell"><form id="askForm" class="card ask-form"><label class="f"><span class="lab">What would you like to know or do?</span><textarea id="askQuestion" rows="3" maxlength="240" placeholder="e.g. What should I reorder?">${esc(state.question)}</textarea></label><button class="btn primary" type="submit"${state.busy ? ' disabled' : ''}>${state.busy ? 'Checking…' : 'Ask'}</button></form>
    <div class="ask-chips" role="group" aria-label="Suggested questions">${suggestions().map(q => `<button type="button" class="chipbtn" data-ask-question="${esc(q)}">${esc(q)}</button>`).join('')}</div>${answerHTML(state.answer)}</div>`;
}

/* Shows what an action points at (nothing is changed) */
export function performAgentAction(target, id){
  if(target === 'bill') return openBillView(id);
  if(target === 'product') return openProductView(id);
  if(target === 'customer') return openCustHistory(id);
  // Reports for a period, at one of its cards: reconciliation, the cash book (last 7 days) or the bank book (last 30)
  const card = { reconcile: 'reconcileCard', cashbook: 'cashBook', bankbook: 'bankBook' }[target];
  if(target === 'report' || card){
    store.prefs.period = id || (target === 'cashbook' ? '7d' : target === 'report' ? 'today' : '30d'); store.showAllBills = false; savePrefs(); setTab('report');
    const c = card && document.getElementById(card); if(c) c.scrollIntoView({ block: 'start' });
    return;
  }
  if(target === 'customers' || target === 'bills') return setTab(target);
  if(target === 'banks') return openSettings('payments');
  if(target === 'reorder'){ chooseSubview('stock', 'smart'); setTab('stock'); renderAll(); }
  if(target === 'pos'){ chooseSubview('stock', 'pos'); setTab('stock'); renderAll(); }
  if(target === 'stock'){ chooseSubview('stock', 'levels'); setTab('stock'); renderAll(); }
}

/* Every answer that read the shop's records is in Activity (governance.js answerAudit): who asked, why, the tools, before and
   after (nothing changes by answering), the outcome — a greeting or a question it couldn't answer isn't */
const READ_KINDS = new Set(['greeting', 'thanks', 'help']);
function auditAnswer(question, answer){
  if(!answer || answer.source === 'unavailable' || answer.supported === false) return;
  const intent = answer.intent || null; if(intent && READ_KINDS.has(intent.kind)) return;
  const tools = answer.toolsUsed && answer.toolsUsed.length ? answer.toolsUsed : intent ? ['read: ' + intent.kind] : [];
  if(!tools.length) return;
  try{ logAutomation({ ...answerAudit({ question, tools, proposal: answer.proposal, refused: answer.refused }), key: 'agent:answer:' + Date.now() }); }
  catch(e){ logger.event('agent', 'audit-failed', { op: 'answer', code: e && e.code }, 'warn'); }
}
async function ask(question){
  if(refuse('view_reports', 'ask questions about business data')) return;
  const q = String(question || '').trim(); if(!q) return;
  const version = ++requestVersion;
  state = { busy: true, question: q, answer: null, saved: null }; renderAssistantPage();
  // the question's chain (Settings → Diagnostics → Agent chain): request → tools → result → action → approval → outcome
  const trace = startTrace("ask"), t0 = Date.now();
  traceStep(trace, "request", { op: "question" });
  let answer;
  try{ answer = await assistant().ask(q); }
  catch{ answer = { source: 'unavailable', title: 'Could not answer that', text: 'The shop’s data or the AI service couldn’t be reached. Try again in a moment.', rows: [] }; }
  endTrace(trace);
  traceStep(trace, "outcome", { op: !answer || answer.source === 'unavailable' ? 'unavailable' : answer.supported === false ? 'not-understood' : answer.proposal ? 'proposal-shown' : 'answered',
    ok: !!answer && answer.source !== 'unavailable', ms: Date.now() - t0, count: answer && answer.rows ? answer.rows.length : 0 });
  if(version !== requestVersion) return;
  answer = answer ? { ...answer, trace } : answer;
  state = { busy: false, question: q, answer, saved: null }; renderAssistantPage();
  auditAnswer(q, answer);
  // "open bill 127": the person asked to see it, so it opens at once (the button stays to open it again)
  if(answer && answer.autoOpen && answer.actions && answer.actions[0] && answer.actions[0].kind === 'open'){ traceStep(trace, "action", { op: answer.actions[0].target }); performAgentAction(answer.actions[0].target, answer.actions[0].id); }
}
function confirmProposal(){
  const p = state.answer && state.answer.proposal; if(!p || state.saved) return;
  const r = confirmAgentProposal(p, { question: state.question, tool: p.kind === "purchase_order" ? "draft_purchase_order" : "" }), trace = state.answer.trace;
  traceStep(trace, "approval", { op: "approved" }); traceStep(trace, "outcome", { op: r.error ? "refused" : "saved", ok: !r.error });
  if(r.error){ toast(r.error); return; }
  state = { ...state, saved: { id: r.po.id, no: r.po.no } }; renderAssistantPage();
  toast(`Draft purchase order ${r.po.no} saved. It isn't sent yet.`);
}

let installed = false;
export function installAssistantEvents(){
  if(installed) return; installed = true;
  document.addEventListener('click', event => {
    const t = event.target && event.target.closest ? event.target : null; if(!t) return;
    const b = t.closest('[data-ask-question]');
    if(b){ event.preventDefault(); ask(b.dataset.askQuestion); return; }
    const o = t.closest('[data-agentopen]');
    if(o){ event.preventDefault(); const [target, id] = o.dataset.agentopen.split('|'); if(state.answer) traceStep(state.answer.trace, "action", { op: target }); performAgentAction(target, id); return; }
    if(t.closest('[data-agentconfirm]')){ event.preventDefault(); confirmProposal(); return; }
    if(t.closest('[data-agentdismiss]') && state.answer){ event.preventDefault(); dismissAgentProposal(state.answer.proposal, { question: state.question }); traceStep(state.answer.trace, "approval", { op: "dismissed" }); traceStep(state.answer.trace, "outcome", { op: "dismissed" }); state = { ...state, answer: { ...state.answer, proposal: null } }; renderAssistantPage(); }
  });
  document.addEventListener('submit', event => {
    if(!event.target || event.target.id !== 'askForm') return;
    event.preventDefault(); ask($('#askQuestion') && $('#askQuestion').value);
  });
}

export function resetAssistant(){ requestVersion++; one = null; ai = null; state = { busy: false, question: '', answer: null, saved: null }; }
