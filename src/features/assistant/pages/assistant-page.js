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
import { can, refuse } from '../../shop/services/access.js';
import { chooseSubview } from '../../shop/services/modules.js';
import { createReadOnlyBusinessQuery } from '../services/business-query.js';
import { createBusinessAssistant } from '../services/business-assistant.js';
import { appAgentToolHost } from '../services/agent-tools.js';
import { createAgentAI } from '../services/agent-runner.js';
import { confirmAgentProposal } from '../use-cases/agent-actions.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';
import { openBillView } from '../../receipts/components/bill-view.js';
import { openProductView } from '../../products/components/product-view.js';
import { openCustHistory } from '../../customers/components/customer-picker.js';

const SUGGESTIONS = [
  'How much did I sell today?',
  'What should I reorder?',
  'Who owes me money?',
  'Recent bills',
  'Sales trend',
  'UPI to verify',
  'Profit this month',
  'Draft a purchase order',
  'What can you do?',
];

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
    <div class="ask-chips" role="group" aria-label="Suggested questions">${SUGGESTIONS.map(q => `<button type="button" class="chipbtn" data-ask-question="${esc(q)}">${esc(q)}</button>`).join('')}</div>${answerHTML(state.answer)}</div>`;
}

/* Shows what an action points at (nothing is changed) */
export function performAgentAction(target, id){
  if(target === 'bill') return openBillView(id);
  if(target === 'product') return openProductView(id);
  if(target === 'customer') return openCustHistory(id);
  if(target === 'report' || target === 'reconcile'){
    store.prefs.period = id || 'today'; store.showAllBills = false; savePrefs(); setTab('report');
    const c = target === 'reconcile' && document.getElementById('reconcileCard'); if(c) c.scrollIntoView({ block: 'start' });
    return;
  }
  if(target === 'reorder'){ chooseSubview('stock', 'smart'); setTab('stock'); renderAll(); }
}

async function ask(question){
  if(refuse('view_reports', 'ask questions about business data')) return;
  const q = String(question || '').trim(); if(!q) return;
  const version = ++requestVersion;
  state = { busy: true, question: q, answer: null, saved: null }; renderAssistantPage();
  let answer;
  try{ answer = await assistant().ask(q); }
  catch{ answer = { source: 'unavailable', title: 'Could not answer that', text: 'The shop’s data or the AI service couldn’t be reached. Try again in a moment.', rows: [] }; }
  if(version !== requestVersion) return;
  state = { busy: false, question: q, answer, saved: null }; renderAssistantPage();
  // "open bill 127": the person asked to see it, so it opens at once (the button stays to open it again)
  if(answer && answer.autoOpen && answer.actions && answer.actions[0] && answer.actions[0].kind === 'open') performAgentAction(answer.actions[0].target, answer.actions[0].id);
}
function confirmProposal(){
  const p = state.answer && state.answer.proposal; if(!p) return;
  const r = confirmAgentProposal(p);
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
    if(o){ event.preventDefault(); const [target, id] = o.dataset.agentopen.split('|'); performAgentAction(target, id); return; }
    if(t.closest('[data-agentconfirm]')){ event.preventDefault(); confirmProposal(); return; }
    if(t.closest('[data-agentdismiss]') && state.answer){ event.preventDefault(); state = { ...state, answer: { ...state.answer, proposal: null } }; renderAssistantPage(); }
  });
  document.addEventListener('submit', event => {
    if(!event.target || event.target.id !== 'askForm') return;
    event.preventDefault(); ask($('#askQuestion') && $('#askQuestion').value);
  });
}

export function resetAssistant(){ requestVersion++; one = null; ai = null; state = { busy: false, question: '', answer: null, saved: null }; }
