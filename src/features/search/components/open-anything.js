// Global command surface for fast navigation and lookup. It only opens existing pages/records/actions; business rules
// remain in their current components and delegated event handlers.
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { sheetHTML, UI_ICON } from '../../../shared/ui/kit.js';
import { D } from '../../inventory/services/ledger.js';
import { liveProducts } from '../../products/services/catalog.js';
import { openProductView } from '../../products/components/product-view.js';
import { can } from '../../shop/services/access.js';
import { moduleShown } from '../../shop/services/modules.js';
import { navAreas } from '../../shop/services/nav-model.js';

const clean = value => String(value || '').trim().toLowerCase();
const includes = (query, ...values) => values.some(value => clean(value).includes(query));
const attrs = item => item.sub ? `data-navsub="${esc(item.id)}"` : `data-tab="${esc(item.tab)}"`;

export function renderGlobalActions(){
  const host = $('#globalActions'); if(!host) return;
  host.innerHTML = `<button type="button" class="global-btn" data-global="search" aria-label="Open anything" title="Open anything (Ctrl+K)">${UI_ICON.search}<span>Search</span></button>
    <button type="button" class="global-btn quick" data-global="quick" aria-label="Quick actions" title="Quick actions">${UI_ICON.plus}<span>Quick</span></button>
    ${moduleShown('assistant') ? `<button type="button" class="global-btn agent" data-tab="assistant" aria-label="Open Hangtag Agent">${UI_ICON.sparkle}<span>Agent</span></button>` : ''}`;
}

const workspaceResults = query => navAreas().flatMap(area => area.items.map(item => ({ ...item, area: area.label || item.label })))
  .filter(item => !query || includes(query, item.label, item.area)).slice(0, 7);
const productResults = query => !query ? [] : liveProducts().filter(p => includes(query, p.name, p.sku, p.barcode, p.cat)).slice(0, 6);
const customerResults = query => !query ? [] : Object.values(store.customers || {}).filter(c => includes(query, c.name, c.phone, c.email, c.gstin)).slice(0, 6);
const billResults = query => !query ? [] : D().sales.slice().reverse().filter(s => includes(query, s.no, s.cust && s.cust.name, s.cust && s.cust.phone,
  ...(s.items || []).flatMap(i => [i.n, i.sku, i.vl, i.s]))).slice(0, 6);
const group = (title, rows) => rows.length ? `<section class="command-group"><h4>${esc(title)}</h4><div>${rows.join('')}</div></section>` : '';

function commandResults(query){
  const q = clean(query), workspaces = workspaceResults(q), products = productResults(q), customers = customerResults(q), bills = billResults(q);
  const html = [
    group('Go to', workspaces.map(item => `<button type="button" class="command-row" ${attrs(item)}>${UI_ICON.open}<span><b>${esc(item.label)}</b><small>${esc(item.area)}</small></span></button>`)),
    group('Products', products.map(p => `<button type="button" class="command-row" data-commandproduct="${esc(p.id)}">${UI_ICON.box}<span><b>${esc(p.name)}</b><small>${esc([p.sku, p.cat].filter(Boolean).join(' · ') || 'Product')}</small></span></button>`)),
    group('Customers', customers.map(c => `<button type="button" class="command-row" data-custhist="${esc(c.id)}">${UI_ICON.user}<span><b>${esc(c.name)}</b><small>${esc(c.phone || c.email || 'Customer')}</small></span></button>`)),
    group('Bills', bills.map(s => `<button type="button" class="command-row" data-billview="${esc(s.id)}">${UI_ICON.receipt}<span><b>${esc(s.no || 'Bill')}</b><small>${esc(s.cust && s.cust.name || 'Walk-in')} · ${inr(s.total)}</small></span></button>`)),
  ].join('');
  return html || `<div class="command-empty">${UI_ICON.search}<b>No match for “${esc(query)}”</b><p>Try a bill number, customer, phone, product or workspace.</p></div>`;
}

export function openAnything(query = ''){
  $('#modalHost').innerHTML = sheetHTML({ id: 'openAnything', cls: 'command-sheet', title: 'Open anything', sub: 'Find a workspace, bill, customer or product.',
    body: `<label class="search command-search">${UI_ICON.search}<input id="commandSearch" type="search" value="${esc(query)}" placeholder="Type to search…" autocomplete="off" enterkeyhint="search" aria-label="Search Hangtag"></label><div id="commandResults">${commandResults(query)}</div>` });
  const input = $('#commandSearch'); if(input) input.focus({ preventScroll: true });
}

export function openQuickActions(){
  const actions = [
    can('create_sale') && `<button type="button" class="quick-row" data-tab="sell">${UI_ICON.plus}<span><b>New sale</b><small>Start billing</small></span></button>`,
    can('manage_inventory') && `<button type="button" class="quick-row" data-act="stockin">${UI_ICON.moneyIn}<span><b>Receive stock</b><small>Add delivered stock</small></span></button>`,
    can('manage_products') && `<button type="button" class="quick-row" data-act="addp">${UI_ICON.box}<span><b>New product</b><small>Add an item to the catalogue</small></span></button>`,
    can('create_sale') && `<button type="button" class="quick-row" data-act="custadd">${UI_ICON.user}<span><b>New customer</b><small>Save contact and GST details</small></span></button>`,
    moduleShown('bills') && `<button type="button" class="quick-row" data-tab="bills">${UI_ICON.receipt}<span><b>Find a bill</b><small>Print, send, return or cancel</small></span></button>`,
  ].filter(Boolean);
  $('#modalHost').innerHTML = sheetHTML({ id: 'quickActions', cls: 'quick-sheet', title: 'Quick actions', sub: 'Start common work without hunting through menus.', body: `<div class="quick-list">${actions.join('')}</div>` });
}

let installed = false;
export function installOpenAnything(){
  if(installed) return; installed = true;
  document.addEventListener('click', event => {
    const target = event.target; if(!target || !target.closest) return;
    const global = target.closest('[data-global]');
    if(global){ if(global.dataset.global === 'search') openAnything(); else openQuickActions(); return; }
    const product = target.closest('[data-commandproduct]');
    if(product){ openProductView(product.dataset.commandproduct); }
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
    }
  });
}
