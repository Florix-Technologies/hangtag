import { $, esc } from '../../../shared/dom.js';
import { can, refuse } from '../../shop/services/access.js';
import { createReadOnlyBusinessQuery } from '../services/business-query.js';
import { createBusinessAssistant } from '../services/business-assistant.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';

const SUGGESTIONS = [
  'How much did I sell today?',
  'Profit this month',
  'What should I reorder?',
  'Who owes me money?',
  'Payments today',
  'Bank balances',
  'Expenses this week',
  'Open orders',
  'What can you do?',
];

let state = { busy: false, question: '', answer: null }, requestVersion = 0;
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
let one = null;
const assistant = () => one || (one = createBusinessAssistant({ query: createReadOnlyBusinessQuery({ inventory: kind => inventorySource(kind) }) }));

function answerHTML(answer){
  if(!answer) return `<div class="ask-empty"><b>Hi 👋 Ask in plain language</b><p>Sales, profit, stock, payments, customer dues, reordering and more — answered from this shop's data on this device. Ask Hangtag only reads: it never changes bills, stock, payments, prices or GST records.</p></div>`;
  return `<article class="card ask-answer" aria-live="polite">${answer.source === 'local' ? '<span class="btag ok">From your shop&rsquo;s data</span>' : answer.source === 'provider' ? '<span class="btag c">AI provider</span>' : '<span class="btag">Not understood</span>'}${state.question ? `<p class="ask-q">“${esc(state.question)}”</p>` : ''}<h3>${esc(answer.title)}</h3><p>${esc(answer.text)}</p>${answer.rows && answer.rows.length ? `<dl>${answer.rows.map(row => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join('')}</dl>` : ''}</article>`;
}

export function renderAssistantPage(){
  const host = $('#v-assistant'); if(!host) return;
  if(!can('view_reports')){ host.innerHTML = '<div class="empty"><b>Ask Hangtag is unavailable</b><p>Your role cannot view business reports.</p></div>'; return; }
  host.innerHTML = `<div class="viewhead"><div><div class="eyebrow">Read-only business assistant</div><h2 class="vt">Ask Hangtag</h2><p>Fast answers from your existing sales, payments, customers and inventory.</p></div></div>
    <div class="ask-shell"><form id="askForm" class="card ask-form"><label class="f"><span class="lab">What would you like to know?</span><textarea id="askQuestion" rows="3" maxlength="240" placeholder="e.g. What should I reorder?">${esc(state.question)}</textarea></label><button class="btn primary" type="submit"${state.busy ? ' disabled' : ''}>${state.busy ? 'Checking…' : 'Ask'}</button></form>
    <div class="ask-chips" role="group" aria-label="Suggested questions">${SUGGESTIONS.map(q => `<button type="button" class="chipbtn" data-ask-question="${esc(q)}">${esc(q)}</button>`).join('')}</div>${answerHTML(state.answer)}</div>`;
}

async function ask(question){
  if(refuse('view_reports', 'ask questions about business data')) return;
  const q = String(question || '').trim(); if(!q) return;
  const version = ++requestVersion;
  state = { busy: true, question: q, answer: null }; renderAssistantPage();
  let answer;
  try{ answer = await assistant().ask(q); }
  catch{ answer = { source: 'unavailable', title: 'Could not read the shop data', text: 'Try again after the shop finishes loading.', rows: [] }; }
  if(version !== requestVersion) return;
  state = { busy: false, question: q, answer }; renderAssistantPage();
}

let installed = false;
export function installAssistantEvents(){
  if(installed) return; installed = true;
  document.addEventListener('click', event => {
    const b = event.target && event.target.closest && event.target.closest('[data-ask-question]');
    if(!b) return; event.preventDefault(); ask(b.dataset.askQuestion);
  });
  document.addEventListener('submit', event => {
    if(!event.target || event.target.id !== 'askForm') return;
    event.preventDefault(); ask($('#askQuestion') && $('#askQuestion').value);
  });
}

export function resetAssistant(){ requestVersion++; one = null; state = { busy: false, question: '', answer: null }; }
