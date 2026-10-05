// Open anything (the app bar's Search, Ctrl+K) and Quick actions: one search over workspaces, bills, customers, products,
// orders, suppliers and settings, each result opening the record's own screen. It only opens existing pages, records and
// actions; business rules stay in their components and delegated event handlers. What a person can't open isn't listed.
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { sheetHTML, UI_ICON } from '../../../shared/ui/kit.js';
import { D } from '../../inventory/services/ledger.js';
import { liveProducts } from '../../products/services/catalog.js';
import { openProductView } from '../../products/components/product-view.js';
import { can } from '../../shop/services/access.js';
import { chooseSubview, moduleShown } from '../../shop/services/modules.js';
import { navAreas } from '../../shop/services/nav-model.js';
import { orderRepository } from '../../orders/repositories/order-repository.js';
import { KIND_LABELS } from '../../../domain/orders/orders.js';
import { suppliersList } from '../../inventory/services/purchase-state.js';
import { openSettings, settingsSearch } from '../../shop/components/settings-page.js';
import { renderAll, setTab } from '../../../shared/ui/render.js';

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
const orderResults = query => !query || !moduleShown('orders') ? [] : (() => { try { return orderRepository().list(); } catch { return []; } })()
  .filter(o => includes(query, o.no, o.cust && o.cust.name, o.cust && o.cust.phone)).sort((a, b) => b.t - a.t).slice(0, 5);
const supplierResults = query => !query || !(can('create_purchase') || can('manage_inventory')) ? [] : suppliersList(true).filter(x => includes(query, x.name, x.phone, x.gstin)).slice(0, 5);
const settingResults = query => !query || !moduleShown('settings') ? [] : settingsSearch(query).sort((a, b) => (a.block ? 0 : 1) - (b.block ? 0 : 1)).slice(0, 5);   // a named setting before a whole section
const group = (title, rows) => rows.length ? `<section class="command-group"><h4>${esc(title)}</h4><div>${rows.join('')}</div></section>` : '';

function commandResults(query){
  const q = clean(query), workspaces = workspaceResults(q), products = productResults(q), customers = customerResults(q), bills = billResults(q),
    orders = orderResults(q), suppliers = supplierResults(q), settings = settingResults(q);
  const html = [
    group('Go to', workspaces.map(item => `<button type="button" class="command-row" ${attrs(item)}>${UI_ICON.open}<span><b>${esc(item.label)}</b><small>${esc(item.area)}</small></span></button>`)),
    group('Products', products.map(p => `<button type="button" class="command-row" data-commandproduct="${esc(p.id)}">${UI_ICON.box}<span><b>${esc(p.name)}</b><small>${esc([p.sku, p.cat].filter(Boolean).join(' · ') || 'Product')}</small></span></button>`)),
    group('Customers', customers.map(c => `<button type="button" class="command-row" data-custhist="${esc(c.id)}">${UI_ICON.user}<span><b>${esc(c.name)}</b><small>${esc(c.phone || c.email || 'Customer')}</small></span></button>`)),
    group('Bills', bills.map(s => `<button type="button" class="command-row" data-billview="${esc(s.id)}">${UI_ICON.receipt}<span><b>${esc(s.no || 'Bill')}</b><small>${esc(s.cust && s.cust.name || 'Walk-in')} · ${inr(s.total)}</small></span></button>`)),
    group('Orders', orders.map(o => `<button type="button" class="command-row" data-ordopen="${esc(o.id)}">${UI_ICON.doc}<span><b>${esc(o.no || KIND_LABELS[o.kind] || 'Order')}</b><small>${esc([KIND_LABELS[o.kind], o.cust && o.cust.name].filter(Boolean).join(' · '))}</small></span></button>`)),
    group('Suppliers', suppliers.map(x => `<button type="button" class="command-row" data-commandsupplier="${esc(x.id)}">${UI_ICON.user}<span><b>${esc(x.name)}</b><small>${esc(x.phone || x.gstin || 'Supplier')}</small></span></button>`)),
    group('Settings', settings.map(x => `<button type="button" class="command-row" data-commandsetting="${esc(x.key + '|' + (x.blockId || ''))}">${UI_ICON.open}<span><b>${esc(x.block || x.label)}</b><small>Settings · ${esc(x.label)}</small></span></button>`)),
  ].join('');
  return html || `<div class="command-empty">${UI_ICON.search}<b>No match for “${esc(query)}”</b><p>Try a bill number, customer, phone, product, supplier or setting.</p></div>`;
}

export function openAnything(query = ''){
  $('#modalHost').innerHTML = sheetHTML({ id: 'openAnything', cls: 'command-sheet', title: 'Open anything', sub: 'Find a bill, customer, product, order, supplier, setting or workspace.',
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
    }
  });
}
