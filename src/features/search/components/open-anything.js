// Open anything (the app bar's Search, Ctrl+K) and Quick actions: one search over everything (services/search-everything.js:
// bills, customers, products, serials and batches, quotations and orders, purchase orders, supplier bills, suppliers, bank,
// GST), plus settings and workspaces — exact matches first; bills narrowed the everyday way ("unpaid from Riya last week
// over 2000") with their count and total, and Show in Bills to carry the same filter there; a question goes to the Agent.
// Each result opens the record's own screen; business rules stay in their components and delegated event handlers. What a
// person can't open isn't listed.
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { sheetHTML, UI_ICON } from '../../../shared/ui/kit.js';
import { openProductView } from '../../products/components/product-view.js';
import { chooseSubview, moduleShown } from '../../shop/services/modules.js';
import { navAreas } from '../../shop/services/nav-model.js';
import { noteQuickAction, sheetActions } from '../../shop/services/quick-actions.js';
import { openSettings, settingsSearch } from '../../shop/components/settings-page.js';
import { renderAll, setTab } from '../../../shared/ui/render.js';
import { searchEverything } from '../services/search-everything.js';
import { applyBillSearch } from '../../bills/pages/bills-page.js';

const clean = value => String(value || '').trim().toLowerCase();
const includes = (query, ...values) => values.some(value => clean(value).includes(query));
const attrs = item => item.sub ? `data-navsub="${esc(item.id)}"` : `data-tab="${esc(item.tab)}"`;

export function renderGlobalActions(){
  const host = $('#globalActions'); if(!host) return;
  const news = sheetActions().list.length > 0;
  host.innerHTML = `<button type="button" class="global-btn" data-global="search" aria-label="Open anything" title="Open anything (Ctrl+K)">${UI_ICON.search}<span>Search</span></button>
    ${news ? `<button type="button" class="global-btn quick" data-global="quick" aria-label="New: a sale, purchase, order, product, customer or money in or out" title="New: a sale, purchase, order, product, customer or money in or out">${UI_ICON.plus}<span>New</span></button>` : ''}
    ${moduleShown('assistant') ? `<button type="button" class="global-btn agent" data-tab="assistant" aria-label="Open Hangtag Agent">${UI_ICON.sparkle}<span>Agent</span></button>` : ''}`;
}

const workspaceResults = query => navAreas().flatMap(area => area.items.map(item => ({ ...item, area: area.label || item.label })))
  .filter(item => !query || includes(query, item.label, item.area)).slice(0, 7);
const settingResults = query => !query || !moduleShown('settings') ? [] : settingsSearch(query).sort((a, b) => (a.block ? 0 : 1) - (b.block ? 0 : 1)).slice(0, 5);   // a named setting before a whole section
const group = (title, rows) => rows.length ? `<section class="command-group"><h4>${esc(title)}</h4><div>${rows.join('')}</div></section>` : '';

/* a result: its own screen opens (attr: the data attribute the app already handles) */
const resultRow = x => `<button type="button" class="command-row" ${x.attr}>${UI_ICON[x.icon] || UI_ICON.open}<span><b>${esc(x.title)}</b><small>${esc(x.sub || '')}</small></span></button>`;
function commandResults(query){
  const q = clean(query);
  if(!q) return group('Go to', workspaceResults(q).map(item => `<button type="button" class="command-row" ${attrs(item)}>${UI_ICON.open}<span><b>${esc(item.label)}</b><small>${esc(item.area)}</small></span></button>`));
  const S = searchEverything(query), P = S.parsed, B = S.bills, settings = settingResults(q);
  // an identifier, a phone number or an amount isn't a workspace's name
  const workspaces = P.idLike || P.phone || P.amount || P.gstin ? [] : workspaceResults(q);
  const billsHTML = B ? `<section class="command-group"><h4>Bills${B.words ? ` · ${esc(B.words)}` : ''}</h4><p class="command-sum"><span>${B.count} bill${B.count === 1 ? '' : 's'}${B.count ? ` · ${inr(B.total)}` : ''}</span>${B.count ? `<button type="button" class="link xs" data-billsearch="${esc(JSON.stringify({ period: P.period, status: P.status, method: P.method, amount: P.amount, words: P.words }))}">Show in Bills</button>` : ''}</p><div>${B.rows.map(resultRow).join('')}</div></section>` : '';
  const html = [
    S.ask ? group('Ask the Agent', [`<button type="button" class="command-row" data-tab="assistant" data-ask-question="${esc(S.ask)}">${UI_ICON.sparkle}<span><b>${esc(S.ask)}</b><small>Answered from your shop's records</small></span></button>`]) : '',
    group('Exact match', S.exact.map(resultRow)),
    billsHTML,
    ...S.groups.map(g => group(g.title, g.results.map(resultRow))),
    group('Settings', settings.map(x => `<button type="button" class="command-row" data-commandsetting="${esc(x.key + '|' + (x.blockId || ''))}">${UI_ICON.open}<span><b>${esc(x.block || x.label)}</b><small>Settings · ${esc(x.label)}</small></span></button>`)),
    group('Go to', workspaces.map(item => `<button type="button" class="command-row" ${attrs(item)}>${UI_ICON.open}<span><b>${esc(item.label)}</b><small>${esc(item.area)}</small></span></button>`)),
  ].join('');
  return html || `<div class="command-empty">${UI_ICON.search}<b>No match for “${esc(query)}”</b><p>Try a bill number, a phone number, a customer, product, serial number, supplier, an amount like ${esc(inr(2500))}, or “unpaid bills last week”.</p></div>`;
}

export function openAnything(query = ''){
  $('#modalHost').innerHTML = sheetHTML({ id: 'openAnything', cls: 'command-sheet', title: 'Open anything', sub: 'A bill, customer, phone, product, order, supplier, amount or setting — or ask a question.',
    body: `<label class="search command-search">${UI_ICON.search}<input id="commandSearch" type="search" value="${esc(query)}" placeholder="Type to search…" autocomplete="off" enterkeyhint="search" aria-label="Search Hangtag"></label><div id="commandResults">${commandResults(query)}</div>` });
  const input = $('#commandSearch'); if(input) input.focus({ preventScroll: true });
}

/* New: everything this person may start, the suggested first (this page's, then what they start most here), each with its
   number key on a keyboard */
const WHY = { here: 'For this page', often: 'You start this often' };
export function openQuickActions(){
  const Q = sheetActions();
  let n = 0;
  const row = a => { n++; return `<button type="button" class="quick-row" ${a.attr}>${UI_ICON[a.icon] || UI_ICON.plus}<span><b>${esc(a.label)}</b><small>${a.why ? `<em class="quick-why">${esc(WHY[a.why])}</em> · ` : ''}${esc(a.sub)}</small></span>${n < 10 ? `<kbd class="quick-key" aria-hidden="true">${n}</kbd>` : ''}</button>`; };
  const body = !Q.list.length ? `<p class="note">Nothing to start here with your role.</p>`
    : Q.suggested.length ? `<h4 class="quick-h">Suggested</h4><div class="quick-list">${Q.suggested.map(row).join('')}</div>${Q.rest.length ? `<h4 class="quick-h">Everything else</h4><div class="quick-list">${Q.rest.map(row).join('')}</div>` : ''}`
    : `<div class="quick-list">${Q.list.map(row).join('')}</div>`;
  $('#modalHost').innerHTML = sheetHTML({ id: 'quickActions', cls: 'quick-sheet', title: 'New', sub: 'Start a sale, a purchase or an order, add stock, a product or a customer, or record money in or out.', body });
}

let installed = false;
export function installOpenAnything(){
  if(installed) return; installed = true;
  // a quick action started (New or Home): counted for the order next time; New closes unless the action took its place
  document.addEventListener('click', event => {
    const q = event.target && event.target.closest ? event.target.closest('[data-quick]') : null; if(!q) return;
    noteQuickAction(q.dataset.quick);
    setTimeout(() => { const host = $('#modalHost'); if(host && host.querySelector('#quickActions')) host.innerHTML = ''; }, 0);
  }, true);
  document.addEventListener('click', event => {
    const target = event.target; if(!target || !target.closest) return;
    const global = target.closest('[data-global]');
    if(global){ if(global.dataset.global === 'search') openAnything(); else openQuickActions(); return; }
    // Show in Bills: the same filter in the Bills workspace
    const bs = target.closest('[data-billsearch]');
    if(bs){ let F = null; try{ F = JSON.parse(bs.dataset.billsearch); }catch{ F = null; } if(F){ applyBillSearch(F); $('#modalHost').innerHTML = ''; setTab('bills'); renderAll(); window.scrollTo(0, 0); } return; }
    // a serial number or batch: Stock → Tracking, found
    const tr = target.closest('[data-commandtrack]');
    if(tr){ chooseSubview('stock', 'tracking'); store.trackView = { q: tr.dataset.commandtrack, status: '', exp: '', open: '' }; $('#modalHost').innerHTML = ''; setTab('stock'); renderAll(); window.scrollTo(0, 0); return; }
    const product = target.closest('[data-commandproduct]');
    if(product){ openProductView(product.dataset.commandproduct); return; }
    // a supplier opens in Stock → Suppliers; a setting in its section of Settings
    const sup = target.closest('[data-commandsupplier]');
    if(sup){ chooseSubview('stock', 'suppliers'); store.supplierView = { ...(store.supplierView || {}), id: sup.dataset.commandsupplier }; $('#modalHost').innerHTML = ''; setTab('stock'); renderAll(); window.scrollTo(0, 0); return; }
    const set = target.closest('[data-commandsetting]');
    if(set){ const [key, block] = set.dataset.commandsetting.split('|'); $('#modalHost').innerHTML = ''; openSettings(key, block || undefined); }
  });
  document.addEventListener('input', event => {
    if(!event.target || event.target.id !== 'commandSearch') return;
    const value = event.target.value, pos = event.target.selectionStart, host = $('#commandResults');
    if(host) host.innerHTML = commandResults(value);
    event.target.focus({ preventScroll: true }); event.target.setSelectionRange(pos, pos);
  });
  document.addEventListener('keydown', event => {
    if((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'){
      event.preventDefault(); openAnything();
      return;
    }
    // New open: its number keys start the action
    if(/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && $('#quickActions')){
      const b = document.querySelectorAll('#quickActions .quick-row')[+event.key - 1];
      if(b){ event.preventDefault(); b.click(); }
    }
  });
}
