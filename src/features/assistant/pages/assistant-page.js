import { $, esc } from '../../../shared/dom.js';
import { can, refuse } from '../../shop/services/access.js';
import { createReadOnlyBusinessQuery } from '../services/business-query.js';
import { createBusinessAssistant } from '../services/business-assistant.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';

const SUGGESTIONS = [
  'How much did I sell today?',
  'What was my profit yesterday?',
  'What are my fastest selling products?',
  'What stock is running low?',
  'How much UPI did I receive?',
  'What are my outstanding customer dues?',
  'What should I reorder?',
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

export function configureAssistantInventory(source){ inventorySource = typeof source === 'function' ? source : () => []; }
const assistant = () => createBusinessAssistant({ query: createReadOnlyBusinessQuery({ inventory: inventorySource }) });

function answerHTML(answer){
  if(!answer) return `<div class="ask-empty"><b>Ask in plain language</b><p>Answers use the shop data already on this device. Ask Hangtag is read-only and cannot change bills, stock, payments, prices or GST records.</p></div>`;
  return `<article class="card ask-answer" aria-live="polite"><span class="btag">${answer.source === 'local' ? 'Calculated locally' : answer.source === 'provider' ? 'AI provider' : 'Unavailable'}</span><h3>${esc(answer.title)}</h3><p>${esc(answer.text)}</p>${answer.rows && answer.rows.length ? `<dl>${answer.rows.map(row => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join('')}</dl>` : ''}</article>`;
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

export function resetAssistant(){ requestVersion++; state = { busy: false, question: '', answer: null }; }
