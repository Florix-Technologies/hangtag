// Public mobile store and in-shop assisted cart. This page has no account session and no direct table access: it calls
// three deliberately public RPCs with the publishable key. Prices, GST, availability, customer linkage and deduplication
// are all decided again by the database.
import { checkMobileCustomer, mobileCartTotal, mobileOrderItems, mobileQty, mobileQtyStep, mobileStoreLink } from './src/domain/commerce/mobile-store.js';

const app = document.getElementById('app'), config = window.HANGTAG_CONFIG || {}, link = mobileStoreLink(location.hash);
let menu = null, query = '', category = '', view = 'menu', busy = false, error = '', placed = null, statusTimer = null;
const key = 'hangtag-store:' + link.token.slice(-16), saved = readLocal(key, {});
let cart = saved.cart && typeof saved.cart === 'object' ? saved.cart : {};
let customer = saved.customer && typeof saved.customer === 'object' ? saved.customer : { name:'', phone:'', email:'' };
let note = saved.note || '', payment = saved.payment || 'counter', checkoutKey = saved.checkoutKey || randomKey('ck_');

function el(tag, cls, text){ const node = document.createElement(tag); if(cls) node.className = cls; if(text != null) node.textContent = text; return node; }
function button(text, cls, fn){ const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', fn); return node; }
function readLocal(k, fallback){ try{ return JSON.parse(localStorage.getItem(k)) || fallback; }catch{ return fallback; } }
function save(){ try{ localStorage.setItem(key, JSON.stringify({ cart, customer, note, payment, checkoutKey })); }catch{ /* private mode */ } }
function randomKey(prefix){ const bytes = new Uint8Array(18); crypto.getRandomValues(bytes); return prefix + Array.from(bytes, x => x.toString(16).padStart(2, '0')).join(''); }
function money(n){ return '₹' + (+n || 0).toLocaleString('en-IN', { minimumFractionDigits:Number.isInteger(+n) ? 0 : 2, maximumFractionDigits:2 }); }
function rpc(name, body){
  return fetch(String(config.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/rpc/' + name, { method:'POST', headers:{ 'Content-Type':'application/json', apikey:config.SUPABASE_ANON_KEY }, body:JSON.stringify(body) })
    .then(async response => { const data = await response.json().catch(() => ({})); if(!response.ok) throw new Error(data.message || 'The shop could not be reached.'); return data; });
}
function allVariants(){ return (menu && menu.items || []).flatMap(p => (p.variants || []).map(v => ({ ...v, p:p.id, name:p.name, gst:p.gst, unit:p.unit || 'pcs', image:p.image, category:p.category }))); }
function variant(id){ return allVariants().find(v => v.v === id); }
function count(){ return Object.values(cart).reduce((n, q) => n + (+q || 0), 0); }
function total(){ return mobileCartTotal(cart, allVariants(), { taxOn:!!menu.tax_on, taxInclusive:menu.tax_inclusive !== false }); }
function cartItems(){ return mobileOrderItems(cart, allVariants()); }
function trimCart(){ const valid = {}; allVariants().forEach(v => { const q = mobileQty(cart[v.v], v.unit); if(q && v.available > 0) valid[v.v] = Math.min(q, +v.available); }); cart = valid; save(); }
function setQty(id, raw){ const v = variant(id), q = v && mobileQty(raw, v.unit); if(!q) delete cart[id]; else cart[id] = Math.min(q, +v.available); save(); render(); }
function add(id){ const v = variant(id); if(!v || v.available <= 0) return; const step = mobileQtyStep(v.unit); setQty(id, Math.min((+cart[id] || 0) + step, +v.available)); }
function heading(back){
  const top = el('div', 'top'), h = el('div', 'head');
  if(back) h.appendChild(button('←', 'ghost', () => { view = back; error = ''; render(); }));
  h.appendChild(el('h1', '', menu && menu.shop || 'Shop'));
  if(link.mode === 'assisted') h.appendChild(el('span', 'pill', 'In-store cart'));
  top.appendChild(h); return top;
}
function fail(message){ app.textContent = ''; app.appendChild(heading()); const card = el('div', 'card empty'); card.append(el('h2', '', 'Store unavailable'), el('p', 'muted', message)); app.appendChild(card); }
function bottom(left, label, fn, disabled){ const bar = el('div', 'bottom'), inner = el('div'); inner.appendChild(el('span', '', left)); const go = button(label, 'primary', fn); go.disabled = !!disabled; inner.appendChild(go); bar.appendChild(inner); app.appendChild(bar); }
function imageBox(p){ const box = el('div', 'photo'); if(p.image){ const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.src = p.image; box.appendChild(img); } else box.appendChild(el('span', '', String(p.name || '?').slice(0, 1).toUpperCase())); return box; }
function renderMenu(){
  app.appendChild(heading());
  const search = el('input', 'search'); search.type = 'search'; search.placeholder = 'Search products'; search.value = query;
  search.addEventListener('input', () => { query = search.value; render(true); }); app.querySelector('.top').appendChild(search);
  const cats = el('div', 'cats'); [''].concat(menu.categories || []).forEach(c => { const b = button(c || 'All', c === category ? 'on' : '', () => { category = c; render(); }); cats.appendChild(b); }); app.appendChild(cats);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean), grid = el('div', 'grid'); let shown = 0;
  (menu.items || []).forEach(p => {
    const text = [p.name, p.brand, p.category, p.description, ...(p.variants || []).map(v => v.label)].join(' ').toLowerCase();
    if((category && p.category !== category) || !words.every(w => text.includes(w))) return;
    shown++; const card = el('article', 'product'); card.appendChild(imageBox(p)); const body = el('div', 'body');
    body.appendChild(el('h2', '', p.name)); if(p.brand) body.appendChild(el('p', 'muted small', p.brand)); if(p.description) body.appendChild(el('p', 'muted small', p.description));
    if(menu.tax_on && +p.gst > 0) body.appendChild(el('p', 'muted small', 'GST ' + p.gst + '%' + (menu.tax_inclusive ? ' included' : ' added at checkout')));
    const options = (p.variants || []), select = el('select'), chosen = options.find(v => v.available > 0) || options[0];
    options.forEach(v => { const o = el('option', '', (v.label || 'Standard') + ' · ' + money(v.price) + (v.available > 0 ? '' : ' · sold out')); o.value = v.v; o.disabled = v.available <= 0; select.appendChild(o); });
    if(chosen) select.value = chosen.v; if(options.length > 1) body.appendChild(select);
    const price = el('p', 'price'), stock = el('p', 'stock small'); body.append(price, stock);
    const addButton = button('Add', 'add primary', () => add(select.value)); body.appendChild(addButton);
    const update = () => { const v = variant(select.value) || chosen; price.textContent = v ? money(v.price) + (v.unit && v.unit !== 'pcs' ? '/' + v.unit : '') : '';
      stock.textContent = !v || v.available <= 0 ? 'Sold out' : v.available + (v.unit === 'pcs' ? ' available' : ' ' + v.unit + ' available'); stock.classList.toggle('out', !v || v.available <= 0); addButton.disabled = !v || v.available <= 0;
      addButton.textContent = v && cart[v.v] ? 'Add another · ' + cart[v.v] + ' in cart' : 'Add'; };
    select.addEventListener('change', update); update(); card.appendChild(body); grid.appendChild(card);
  });
  if(shown) app.appendChild(grid); else { const empty = el('div', 'card empty'); empty.append(el('h2', '', 'No matches'), el('p', 'muted', 'Try another word or category.')); app.appendChild(empty); }
  bottom(count() ? count() + ' in cart · ' + money(total()) : 'Your cart is empty', 'View cart', () => { view = 'cart'; render(); }, !count());
}
function qtyControl(v, q){ const step = mobileQtyStep(v.unit), wrap = el('div', 'step'); wrap.appendChild(button('−', '', () => setQty(v.v, q - step)));
  const input = el('input'); input.type = 'number'; input.inputMode = 'decimal'; input.min = String(step); input.max = String(v.available); input.step = String(step); input.value = String(q); input.setAttribute('aria-label', 'Quantity for ' + v.name);
  input.addEventListener('change', () => setQty(v.v, input.value)); wrap.append(input, button('+', '', () => setQty(v.v, q + step))); return wrap; }
function cartCard(){ const card = el('section', 'card'); card.appendChild(el('h2', '', 'Your cart'));
  cartItems().forEach(item => { const v = variant(item.v), row = el('div', 'row'), info = el('div'); info.append(el('b', '', v.name), el('small', 'muted', [v.label, money(v.price) + (v.unit === 'pcs' ? '' : '/' + v.unit)].filter(Boolean).join(' · '))); row.append(info, qtyControl(v, item.q)); card.appendChild(row); });
  const sum = el('div', 'sum'); sum.append(el('b', '', 'Total'), el('b', '', money(total()))); card.appendChild(sum); return card; }
function renderCart(){ app.appendChild(heading('menu')); if(!cartItems().length){ const empty = el('div', 'card empty'); empty.append(el('h2', '', 'Your cart is empty'), el('p', 'muted', 'Go back and add something.')); app.appendChild(empty); return; } app.appendChild(cartCard());
  const noteCard = el('div', 'card'); noteCard.appendChild(el('p', 'muted small', 'Availability and price are checked again when you place the order. Nothing is charged on this page.')); app.appendChild(noteCard);
  bottom(count() + ' item' + (count() === 1 ? '' : 's') + ' · ' + money(total()), link.mode === 'assisted' ? 'Review & hand to staff' : 'Continue', () => { view = 'checkout'; render(); });
}
function field(label, name, type, value, required){ const lab = el('label'), span = el('span', '', label), input = el('input'); input.name = name; input.type = type; input.value = value || ''; input.required = !!required; if(name === 'phone') input.inputMode = 'tel'; lab.append(span, input); return { lab, input }; }
function renderCheckout(){ app.appendChild(heading('cart')); app.appendChild(cartCard()); const card = el('section', 'card fields'); card.appendChild(el('h2', '', link.mode === 'assisted' ? 'Show this order to staff' : 'Your details'));
  const name = field('Name', 'name', 'text', customer.name, true), phone = field('Mobile number', 'phone', 'tel', customer.phone, true), email = field('Email (optional)', 'email', 'email', customer.email); card.append(name.lab, phone.lab, email.lab);
  const noteLab = el('label'); noteLab.appendChild(el('span', '', 'Order note (optional)')); const noteBox = el('textarea'); noteBox.rows = 2; noteBox.maxLength = 500; noteBox.value = note; noteLab.appendChild(noteBox); card.appendChild(noteLab);
  card.appendChild(el('span', 'muted small', 'How would you prefer to pay?')); const choices = el('div', 'choice'); [['counter','At counter'],['cash','Cash'],['upi','UPI']].forEach(([id,label]) => { const lab = el('label'), radio = el('input'); radio.type = 'radio'; radio.name = 'payment'; radio.value = id; radio.checked = payment === id; lab.append(radio, el('b', '', label)); choices.appendChild(lab); }); card.appendChild(choices);
  card.appendChild(el('p', 'muted small', 'This is a preference, not a payment confirmation. Hangtag records payment only after staff verify it during billing.'));
  if(error) card.appendChild(el('p', 'bad', error)); app.appendChild(card);
  bottom(money(total()), busy ? 'Sending…' : (link.mode === 'assisted' ? 'Create staff handoff' : 'Place order'), async () => {
    customer = { name:name.input.value, phone:phone.input.value, email:email.input.value }; note = noteBox.value; payment = (card.querySelector('[name=payment]:checked') || {}).value || 'counter'; save();
    const checked = checkMobileCustomer(customer); if(checked.error){ error = checked.error; checked.customer && Object.assign(customer, checked.customer); render(); const bad = app.querySelector(`[name=${checked.field}]`); if(bad) bad.focus(); return; }
    await place();
  }, busy || !cartItems().length);
}
async function place(){ busy = true; error = ''; render(); try{
  const result = await rpc('hangtag_place_mobile_order', { p_token:link.token, p_items:cartItems(), p_customer:customer, p_checkout_key:checkoutKey, p_note:note || null, p_payment:payment, p_mode:link.mode });
  if(!result || !result.ok) throw new Error(result && result.message || 'The order could not be placed.');
  placed = result; cart = {}; note = ''; busy = false; checkoutKey = randomKey('ck_'); save(); try{ localStorage.setItem(key + ':last-order', JSON.stringify({ token:result.order_token, no:result.order_no })); }catch{ /* private mode */ }
  view = 'placed'; render(); pollStatus();
 }catch(e){ error = e && e.message || 'The order could not be placed. Check your connection and try again.'; busy = false; render(); }
}
function renderPlaced(){ app.appendChild(heading()); const card = el('section', 'card status'), tick = el('div', 'tick', '✓'); card.append(tick, el('h2', 'ok', link.mode === 'assisted' ? 'Cart ready for staff' : 'Order received'), el('b', 'order-no', placed.order_no || ''));
  card.appendChild(el('p', '', link.mode === 'assisted' ? 'Show this order number to a staff member. They can open it in Hangtag, check the items and confirm payment.' : 'The shop can now see your order. Staff will confirm availability and payment.'));
  const state = el('p', 'pill', placed.state_label || 'Awaiting staff'); state.id = 'orderState'; card.appendChild(state);
  card.appendChild(el('p', 'muted small', 'Payment is never marked successful merely because a QR or payment choice was shown. Staff confirmation is required.'));
  card.appendChild(button('Start another order', '', () => { try{ localStorage.removeItem(key + ':last-order'); }catch{ /* private mode */ } placed = null; view = 'menu'; render(); })); app.appendChild(card);
}
async function pollStatus(){ if(statusTimer) clearTimeout(statusTimer); if(!placed || !placed.order_token) return; try{ const s = await rpc('hangtag_mobile_order_status', { p_order_token:placed.order_token }); if(s && s.ok){ placed = { ...placed, ...s }; const node = document.getElementById('orderState'); if(node) node.textContent = s.state_label + (s.payment_label ? ' · ' + s.payment_label : ''); if(!['fulfilled','cancelled'].includes(s.state)) statusTimer = setTimeout(pollStatus, 15000); } }catch{ statusTimer = setTimeout(pollStatus, 30000); } }
function render(keepFocus){ const active = keepFocus && document.activeElement && document.activeElement.classList.contains('search'); const pos = active ? document.activeElement.selectionStart : null; app.textContent = ''; if(!menu) return;
  if(view === 'placed' && placed) renderPlaced(); else if(view === 'checkout') renderCheckout(); else if(view === 'cart') renderCart(); else renderMenu();
  if(active){ const input = app.querySelector('.search'); if(input){ input.focus(); try{ input.setSelectionRange(pos, pos); }catch{ /* search input */ } } }
}
async function start(){ if(!link.token){ fail('This shop link is incomplete. Ask the shop for a new link.'); return; } if(!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY){ fail('This store is not configured yet.'); return; }
  try{ const result = await rpc('hangtag_mobile_catalog', { p_token:link.token }); if(!result || !result.ok) throw new Error(result && result.message || 'This store is not available.'); menu = result; trimCart(); document.title = (menu.shop || 'Shop') + ' · Hangtag'; render();
    const last = readLocal(key + ':last-order', null); if(last && last.token && !count()){ placed = { order_token:last.token, order_no:last.no }; view = 'placed'; render(); pollStatus(); }
  }catch(e){ fail(e && e.message || 'The store could not be loaded. Check your connection and try again.'); }
}
start();
