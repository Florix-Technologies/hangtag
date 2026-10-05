// The shop's public mobile store and in-shop assisted cart (store.html#s=<store token>[&mode=assisted][&o=<order token>]).
// No account session and no direct table access: three deliberately public database functions with the publishable key
// (hangtag_mobile_catalog, hangtag_place_mobile_order, hangtag_mobile_order_status). Prices, GST, availability, customer
// linkage and duplicates are decided again by the database; the order is the shop's ordinary sales order (one commerce
// engine). Money is written by the app's one formatter in the shop's region. Everything shown is set as text.
import { checkMobileCustomer, mobileCartTotal, mobileOrderItems, mobileQty, mobileQtyStep, mobileStoreLink } from './src/domain/commerce/mobile-store.js';
import { configureMoney, inrx } from './src/shared/formatting/money.js';
import { regionOf } from './src/shared/formatting/regions.js';

const app = document.getElementById('app'), config = window.HANGTAG_CONFIG || {}, link = mobileStoreLink(location.hash);
const orderInLink = (/(?:^|[#&])o=(mo_[A-Za-z0-9_-]{32,61})(?:&|$)/.exec(location.hash || '') || [])[1] || '';
const FEW = 3;   // "Only 2 left" at or below this many
let menu = null, closedMessage = '', closedShop = null, query = '', category = '', view = 'menu', busy = false, error = '', fieldError = null, placed = null, statusTimer = null;
const key = 'hangtag-store:' + (link.token || 'none').slice(-16), saved = readLocal(key, {});
let cart = saved.cart && typeof saved.cart === 'object' ? saved.cart : {};
let customer = saved.customer && typeof saved.customer === 'object' ? saved.customer : { name: '', phone: '', email: '' };
let note = saved.note || '', payment = saved.payment || 'counter', checkoutKey = saved.checkoutKey || randomKey('ck_');

/* ---------- small helpers ---------- */
function el(tag, cls, text){ const n = document.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = text; return n; }
function button(text, cls, fn, label){ const n = el('button', cls, text); n.type = 'button'; n.addEventListener('click', fn); if(label) n.setAttribute('aria-label', label); return n; }
function icon(path, cls){ const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); if(cls) s.setAttribute('class', cls);
  s.innerHTML = `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`; return s; }
const BAG = 'M6 8h12l-1 12H7L6 8zm3 0V6a3 3 0 0 1 6 0v2', SEARCH = 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.4-4.4', CHECK = 'M5 12.5 10 17 19 7', STORE = 'M4 10h16M5 10l1-5h12l1 5M6 10v9h12v-9M10 19v-5h4v5';
function readLocal(k, fallback){ try{ return JSON.parse(localStorage.getItem(k)) || fallback; }catch{ return fallback; } }
function save(){ try{ localStorage.setItem(key, JSON.stringify({ cart, customer, note, payment, checkoutKey })); }catch{ /* private mode: the cart lives on this page only */ } }
function randomKey(prefix){ const b = new Uint8Array(18); crypto.getRandomValues(b); return prefix + Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
const money = n => inrx(+n || 0);
function rpc(name, body){
  return fetch(String(config.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: config.SUPABASE_ANON_KEY }, body: JSON.stringify(body) })
    .then(async r => { const data = await r.json().catch(() => ({})); if(!r.ok) throw new Error(data.message || 'The shop could not be reached.'); return data; });
}
function allVariants(){ return (menu && menu.items || []).flatMap(p => (p.variants || []).map(v => ({ ...v, p: p.id, name: p.name, gst: p.gst, unit: p.unit || 'pcs', image: p.image, category: p.category }))); }
function variant(id){ return allVariants().find(v => v.v === id); }
function count(){ return Object.values(cart).reduce((n, q) => n + (+q || 0), 0); }
function total(){ return mobileCartTotal(cart, allVariants(), { taxOn: !!menu.tax_on, taxInclusive: menu.tax_inclusive !== false }); }
function cartItems(){ return mobileOrderItems(cart, allVariants()); }
function trimCart(){ const ok = {}; allVariants().forEach(v => { const q = mobileQty(cart[v.v], v.unit); if(q && v.available > 0) ok[v.v] = Math.min(q, +v.available); }); cart = ok; save(); }
function setQty(id, raw){ const v = variant(id), q = v && mobileQty(raw, v.unit); if(!q) delete cart[id]; else cart[id] = Math.min(q, +v.available); save(); render(); }
function add(id){ const v = variant(id); if(!v || v.available <= 0) return; const step = mobileQtyStep(v.unit); setQty(id, Math.min((+cart[id] || 0) + step, +v.available)); }
const itemsText = n => n + ' item' + (n === 1 ? '' : 's');
const unitText = v => v.unit && v.unit !== 'pcs' ? '/' + v.unit : '';
function stockOf(v){
  if(!v || v.available <= 0) return { text: 'Sold out', cls: 'out' };
  if(v.available <= FEW) return { text: v.unit === 'pcs' ? `Only ${v.available} left` : `Only ${v.available} ${v.unit} left`, cls: 'few' };
  return { text: 'In stock', cls: '' };
}

/* ---------- the parts ---------- */
function header(back){
  const top = el('header', 'top'), inner = el('div', 'top-in'), brand = el('div', 'brand');
  if(back) brand.appendChild(button('←', 'back ghost', () => { view = back; error = ''; fieldError = null; render(); }, 'Back'));
  if(menu && typeof menu.logo === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(menu.logo)){ const img = el('img', 'logo'); img.alt = ''; img.src = menu.logo; brand.appendChild(img); }
  else { const m = el('span', 'mono'); m.appendChild(icon(STORE)); brand.appendChild(m); }
  const t = el('div', 't'), h = el('h1', '', (menu && menu.shop) || (placed && placed.shop) || (closedShop && closedShop.shop) || 'Shop'); h.tabIndex = -1; t.appendChild(h);
  const city = (menu && menu.city) || (placed && placed.shop_city) || (closedShop && closedShop.city); if(city) t.appendChild(el('span', '', city));
  brand.appendChild(t);
  if(link.mode === 'assisted') brand.appendChild(el('span', 'pill', 'In-store cart'));
  else if(closedMessage) brand.appendChild(el('span', 'pill closed', 'Closed'));
  inner.appendChild(brand); top.appendChild(inner); return { top, inner };
}
function imageBox(p){
  const box = el('div', 'pc-img');
  if(p.image){ const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = p.image; box.appendChild(img); }
  else box.appendChild(icon(BAG));
  return box;
}
function stepper(v, q){
  const step = mobileQtyStep(v.unit), wrap = el('div', 'stepper');
  wrap.appendChild(button('−', '', () => setQty(v.v, +(q - step).toFixed(3)), 'One less ' + v.name));
  const input = el('input'); input.type = 'number'; input.inputMode = 'decimal'; input.min = String(step); input.max = String(v.available); input.step = String(step); input.value = String(q);
  input.setAttribute('aria-label', 'Quantity of ' + v.name + (v.label ? ' ' + v.label : ''));
  input.addEventListener('change', () => setQty(v.v, input.value));
  wrap.append(input, button('+', '', () => add(v.v), 'One more ' + v.name));
  const plus = wrap.lastChild; plus.disabled = q >= +v.available;
  return wrap;
}
function productCard(p){
  const options = p.variants || [], chosen0 = options.find(v => v.available > 0) || options[0];
  const card = el('article', 'pc'), body = el('div', 'pc-body');
  card.appendChild(imageBox(p));
  body.appendChild(el('h2', 'pc-name', p.name));
  const meta = [p.brand, p.category].filter(Boolean).join(' · '); if(meta) body.appendChild(el('p', 'pc-meta', meta));
  if(p.description) body.appendChild(el('p', 'pc-desc', p.description));
  let current = chosen0 ? chosen0.v : '';
  const holder = el('div');
  function draw(){
    holder.textContent = '';
    const v = variant(current) || chosen0;
    if(options.length > 1 && options.length <= 8){
      const chips = el('div', 'vchips'); chips.setAttribute('role', 'radiogroup'); chips.setAttribute('aria-label', 'Options for ' + p.name);
      options.forEach(o => { const c = button(o.label || 'Standard', 'vchip' + (o.available > 0 ? '' : ' out'), () => { current = o.v; draw(); });
        c.setAttribute('role', 'radio'); c.setAttribute('aria-checked', String(o.v === current)); c.title = (o.label || 'Standard') + (o.available > 0 ? '' : ' · sold out'); chips.appendChild(c); });
      holder.appendChild(chips);
    } else if(options.length > 8){
      const select = el('select'); select.setAttribute('aria-label', 'Options for ' + p.name);
      options.forEach(o => { const opt = el('option', '', (o.label || 'Standard') + ' · ' + money(o.price) + (o.available > 0 ? '' : ' · sold out')); opt.value = o.v; select.appendChild(opt); });
      select.value = current; select.addEventListener('change', () => { current = select.value; draw(); }); holder.appendChild(select);
    }
    const foot = el('div', 'pc-foot'), price = el('span', 'price', v ? money(v.price) : ''), st = stockOf(v);
    if(v && unitText(v)) price.appendChild(el('small', '', unitText(v)));
    foot.append(price, el('span', 'stock ' + st.cls, st.text)); holder.appendChild(foot);
    if(v && cart[v.v]) holder.appendChild(stepper(v, +cart[v.v]));
    else { const b = button(v && v.available > 0 ? 'Add' : 'Sold out', 'add primary', () => add(current)); b.disabled = !v || v.available <= 0; if(v) b.setAttribute('aria-label', 'Add ' + p.name + (v.label ? ' ' + v.label : '')); holder.appendChild(b); }
    card.classList.toggle('out', !v || v.available <= 0);
  }
  draw(); body.appendChild(holder); card.appendChild(body); return card;
}
function cartLines(container, editable){
  cartItems().forEach(item => {
    const v = variant(item.v), row = el('div', 'line'), info = el('div');
    info.append(el('b', '', v.name), el('small', '', [v.label, money(v.price) + unitText(v)].filter(Boolean).join(' · ')));
    row.appendChild(info);
    row.appendChild(editable ? stepper(v, item.q) : el('span', 'muted small', '× ' + item.q));
    const lt = el('div', 'lt'); lt.append(el('span', '', ''), el('span', '', money(+v.price * item.q))); row.appendChild(lt);
    container.appendChild(row);
  });
  const tot = el('div', 'tot'); tot.append(el('span', '', 'Total'), el('span', '', money(total()))); container.appendChild(tot);
  if(menu.tax_on) container.appendChild(el('p', 'note', menu.tax_inclusive !== false ? 'Prices include GST.' : 'GST is added to these prices.'));
}
function cartPanel(){
  const panel = el('aside', 'panel card'); panel.setAttribute('aria-label', 'Your cart');
  panel.appendChild(el('h2', '', 'Your cart'));
  if(!count()){ panel.appendChild(el('p', 'muted small', 'Nothing here yet. Tap Add on a product.')); return panel; }
  cartLines(panel, true);
  const go = button(link.mode === 'assisted' ? 'Review for staff' : 'Checkout', 'primary', () => { view = 'checkout'; render(); });
  go.style.width = '100%'; go.style.marginTop = '12px'; panel.appendChild(go);
  return panel;
}
function cartBar(cls, left, sub, label, fn, disabled){
  const bar = el('div', 'cartbar ' + (cls || '')), inner = el('div', 'cartbar-in'), t = el('div');
  t.append(el('b', '', left)); if(sub) t.appendChild(el('span', '', sub));
  const go = button(label, 'primary', fn); go.disabled = !!disabled;
  inner.append(t, go); bar.appendChild(inner); app.appendChild(bar);
}

/* ---------- views ---------- */
function renderMenu(){
  const { top, inner } = header();
  const tools = el('div', 'tools'), sw = el('div', 'search'), input = el('input');
  input.type = 'search'; input.placeholder = 'Search products'; input.value = query; input.setAttribute('aria-label', 'Search products'); input.autocomplete = 'off';
  input.addEventListener('input', () => { query = input.value; render(true); });
  sw.append(icon(SEARCH), input); tools.appendChild(sw);
  const cats = menu.categories || [];
  if(cats.length){
    const row = el('div', 'cats'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Categories');
    [''].concat(cats).forEach(c => { const b = button(c || 'All', '', () => { category = c; render(); }); b.setAttribute('aria-pressed', String(c === category)); row.appendChild(b); });
    tools.appendChild(row);
  }
  inner.appendChild(tools); app.appendChild(top);
  const page = el('main', 'page'), layout = el('div', 'layout'), left = el('section');
  left.setAttribute('aria-label', 'Products');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean), grid = el('div', 'grid'); let shown = 0;
  (menu.items || []).forEach(p => {
    const text = [p.name, p.brand, p.category, p.description, ...(p.variants || []).map(v => v.label)].join(' ').toLowerCase();
    if((category && p.category !== category) || !words.every(w => text.includes(w))) return;
    shown++; grid.appendChild(productCard(p));
  });
  if(shown){ left.appendChild(el('p', 'count', shown + ' product' + (shown === 1 ? '' : 's') + (category ? ' in ' + category : ''))); left.appendChild(grid); }
  else { const e = el('div', 'empty'); e.append(el('h2', '', (menu.items || []).length ? 'No matches' : 'Nothing on sale yet'), el('p', 'muted', (menu.items || []).length ? 'Try another word or category.' : 'The shop hasn\'t put products in its store yet. Please check back soon.')); left.appendChild(e); }
  layout.appendChild(left); layout.appendChild(cartPanel()); page.appendChild(layout); app.appendChild(page);
  cartBar('menu', count() ? itemsText(count()) + ' · ' + money(total()) : 'Your cart is empty', count() ? 'Tap to review' : '', 'View cart', () => { view = 'cart'; render(); }, !count());
}
function renderCart(){
  app.appendChild(header('menu').top);
  const page = el('main', 'page narrow'), card = el('section', 'card'); card.appendChild(el('h2', '', 'Your cart'));
  if(!cartItems().length){ card.appendChild(el('p', 'muted', 'Your cart is empty. Go back and add something.')); page.appendChild(card); app.appendChild(page); return; }
  cartLines(card, true); page.appendChild(card);
  page.appendChild(el('p', 'note', 'Availability and prices are checked again when you place the order. Nothing is charged on this page.'));
  app.appendChild(page);
  cartBar('', itemsText(count()) + ' · ' + money(total()), '', link.mode === 'assisted' ? 'Review for staff' : 'Continue', () => { view = 'checkout'; render(); });
}
function field(label, name, type, value, opts = {}){
  const wrap = el('div', 'field'), id = 'f-' + name, lab = el('label', '', label), input = el(type === 'textarea' ? 'textarea' : 'input');
  lab.htmlFor = id; input.id = id; input.name = name; if(type !== 'textarea') input.type = type; input.value = value || '';
  if(opts.required) input.required = true; if(opts.autocomplete) input.autocomplete = opts.autocomplete; if(opts.inputMode) input.inputMode = opts.inputMode; if(opts.max) input.maxLength = opts.max;
  wrap.append(lab, input);
  if(fieldError && fieldError.field === name){ input.setAttribute('aria-invalid', 'true'); const e = el('span', 'err', fieldError.message); e.id = id + '-err'; input.setAttribute('aria-describedby', e.id); wrap.appendChild(e); }
  return { wrap, input };
}
function renderCheckout(){
  app.appendChild(header('cart').top);
  const page = el('main', 'page narrow'), form = el('form', 'card fields'); form.noValidate = true;
  form.appendChild(el('h2', '', link.mode === 'assisted' ? 'Your details for the staff' : 'Your details'));
  const name = field('Name', 'name', 'text', customer.name, { required: true, autocomplete: 'name', max: 60 });
  const phone = field('Mobile number', 'phone', 'tel', customer.phone, { required: true, autocomplete: 'tel', inputMode: 'tel', max: 20 });
  const email = field('Email (optional)', 'email', 'email', customer.email, { autocomplete: 'email', max: 120 });
  const noteF = field('Note for the shop (optional)', 'note', 'textarea', note, { max: 500 });
  form.append(name.wrap, phone.wrap, email.wrap, noteF.wrap);
  const choice = el('fieldset', 'choice'), lg = el('legend', '', 'How would you like to pay?'); choice.appendChild(lg);
  [['counter', 'At the counter'], ['cash', 'Cash'], ['upi', 'UPI']].forEach(([id, label]) => { const lab = el('label'), r = el('input'); r.type = 'radio'; r.name = 'payment'; r.value = id; r.checked = payment === id; lab.append(r, el('span', '', label)); choice.appendChild(lab); });
  form.appendChild(choice);
  form.appendChild(el('p', 'note', 'This only tells the shop how you\'d like to pay — nothing is charged here. The shop confirms payment when it makes your bill.'));
  if(error) { const a = el('p', 'alert', error); a.setAttribute('role', 'alert'); form.appendChild(a); }
  const sum = el('section', 'card'); sum.appendChild(el('h2', '', 'Your order')); cartLines(sum, false);
  page.append(form, sum); app.appendChild(page);
  const submit = async () => {
    customer = { name: name.input.value, phone: phone.input.value, email: email.input.value }; note = noteF.input.value; payment = (form.querySelector('[name=payment]:checked') || {}).value || 'counter'; save();
    const checked = checkMobileCustomer(customer);
    if(checked.error){ fieldError = { field: checked.field, message: checked.error }; error = ''; render(); const bad = document.getElementById('f-' + checked.field); if(bad) bad.focus(); return; }
    fieldError = null; await place();
  };
  form.addEventListener('submit', e => { e.preventDefault(); submit(); });
  cartBar('', money(total()), itemsText(count()), busy ? 'Sending…' : (link.mode === 'assisted' ? 'Hand to staff' : 'Place order'), submit, busy || !cartItems().length);
}
async function place(){
  busy = true; error = ''; render();
  try{
    const result = await rpc('hangtag_place_mobile_order', { p_token: link.token, p_items: cartItems(), p_customer: customer, p_checkout_key: checkoutKey, p_note: note || null, p_payment: payment, p_mode: link.mode });
    if(!result || !result.ok) throw new Error(result && result.message || 'The order could not be placed.');
    placed = { ...result, shop: menu && menu.shop }; cart = {}; note = ''; busy = false; checkoutKey = randomKey('ck_'); save();
    try{ localStorage.setItem(key + ':last-order', JSON.stringify({ token: result.order_token, no: result.order_no })); }catch{ /* private mode */ }
    view = 'placed'; render(); pollStatus();
  }catch(e){ error = (e && e.message) || 'The order could not be placed. Check your connection and try again.'; busy = false; render(); }
}
const STAGES = [['received', 'Received'], ['confirmed', 'Confirmed'], ['ready', 'Ready'], ['completed', 'Completed']];
function stagesList(state){
  const list = el('ol', 'stages'); list.setAttribute('aria-label', 'Order progress');
  const at = state === 'partial' ? 1 : Math.max(0, STAGES.findIndex(s => s[0] === state));
  STAGES.forEach(([id, label], i) => { const li = el('li', i < at ? 'past' : i === at ? 'on' : '', label); if(i === at) li.setAttribute('aria-current', 'step'); list.appendChild(li); });
  return list;
}
function statusLink(){
  try{ const u = new URL(location.href); u.hash = 's=' + link.token + (link.mode === 'assisted' ? '&mode=assisted' : '') + '&o=' + placed.order_token; return u.href; }catch{ return ''; }
}
function renderPlaced(){
  app.appendChild(header(menu ? 'menu' : '').top);
  const page = el('main', 'page narrow'), card = el('section', 'card done');
  const tick = el('div', 'tick'); tick.appendChild(icon(CHECK)); card.appendChild(tick);
  const fresh = view === 'placed';
  card.appendChild(el('h2', '', placed.state === 'cancelled' ? 'Order cancelled' : fresh ? (link.mode === 'assisted' ? 'Cart ready for staff' : 'Order received') : 'Your order'));
  card.appendChild(el('p', 'order-no', placed.order_no || ''));
  if(fresh) card.appendChild(el('p', 'muted small', link.mode === 'assisted' ? 'Show this number to a staff member: they will check the items and take payment.' : 'The shop has your order. They will get it ready and confirm payment when they bill it.'));
  if(placed.state === 'cancelled'){ card.appendChild(el('span', 'cancelled', 'Cancelled by the shop')); }
  else { const st = stagesList(placed.state || 'received'); st.id = 'orderStages'; card.appendChild(st); }
  if(placed.payment_label){ const pl = el('p', 'pay', placed.payment_label); pl.id = 'orderPay'; card.appendChild(pl); }
  const href = statusLink();
  if(href){
    card.appendChild(el('p', 'muted small', 'Keep this link to check your order later:'));
    const box = el('div', 'linkbox'), inp = el('input'); inp.readOnly = true; inp.value = href; inp.setAttribute('aria-label', 'Order status link');
    const copy = button('Copy', '', async () => { try{ await navigator.clipboard.writeText(href); copy.textContent = 'Copied'; }catch{ inp.select(); } });
    box.append(inp, copy); card.appendChild(box);
  }
  if(placed.shop_phone){ const c = el('div', 'contact'), a = el('a', '', 'Call ' + (placed.shop || 'the shop')); a.href = 'tel:' + String(placed.shop_phone).replace(/[^\d+]/g, ''); c.appendChild(a); card.appendChild(c); }
  page.appendChild(card);
  if(Array.isArray(placed.items) && placed.items.length){
    const sum = el('section', 'card'); sum.appendChild(el('h2', '', 'Items'));
    placed.items.forEach(i => { const row = el('div', 'line'), info = el('div'); info.append(el('b', '', i.name), el('small', '', i.label || '')); row.append(info, el('span', 'muted small', '× ' + (+i.qty))); sum.appendChild(row); });
    const tot = el('div', 'tot'); tot.append(el('span', '', 'Total'), el('span', '', money(placed.total))); sum.appendChild(tot);
    page.appendChild(sum);
  }
  if(menu && !closedMessage) page.appendChild(button('Start another order', '', () => { try{ localStorage.removeItem(key + ':last-order'); }catch{ /* private mode */ } placed = null; view = 'menu'; history.replaceState(null, '', location.pathname + location.search + '#s=' + link.token + (link.mode === 'assisted' ? '&mode=assisted' : '')); render(); }));
  app.appendChild(page);
}
async function pollStatus(){
  if(statusTimer) clearTimeout(statusTimer);
  if(!placed || !placed.order_token) return;
  try{
    const s = await rpc('hangtag_mobile_order_status', { p_order_token: placed.order_token });
    if(s && s.ok){
      const changed = s.state !== placed.state || s.payment_label !== placed.payment_label || !placed.items;
      placed = { ...placed, ...s };
      if(s.region) configureMoney(regionOf(s.region));
      if(changed && (view === 'placed' || view === 'status')) render();
      if(!['completed', 'cancelled'].includes(s.state)) statusTimer = setTimeout(pollStatus, 15000);
    } else if(view === 'status'){ fail(s && s.message || 'That order was not found.'); }
  }catch{ statusTimer = setTimeout(pollStatus, 30000); }
}
function fail(message){
  app.textContent = ''; app.appendChild(header().top);
  const page = el('main', 'page narrow'), card = el('div', 'empty');
  card.append(el('h2', '', closedMessage ? 'This store is closed right now' : 'Store unavailable'), el('p', 'muted', closedMessage ? 'The shop isn\'t taking orders online at the moment. Please check back later, or visit the shop.' : message));
  const last = readLocal(key + ':last-order', null);
  if(last && last.token){ const b = button('See my last order', '', () => openStatus(last.token, last.no)); b.style.marginTop = '12px'; card.appendChild(b); }
  page.appendChild(card); app.appendChild(page);
}
function openStatus(token, no){ placed = { order_token: token, order_no: no || '' }; view = 'status'; render(); pollStatus(); }
function render(keepFocus){
  const active = keepFocus && document.activeElement && document.activeElement.type === 'search', pos = active ? document.activeElement.selectionStart : null;
  const before = view;
  app.textContent = '';
  if((view === 'placed' || view === 'status') && placed){ renderPlaced(); }
  else if(!menu){ fail(closedMessage || 'The store could not be loaded.'); return; }
  else if(view === 'checkout') renderCheckout();
  else if(view === 'cart') renderCart();
  else renderMenu();
  if(active){ const input = app.querySelector('input[type=search]'); if(input){ input.focus(); try{ input.setSelectionRange(pos, pos); }catch{ /* search box */ } } }
  else if(!keepFocus && before === view && document.activeElement === document.body){ /* same view redrawn: leave the scroll where it is */ }
}
let lastView = '';
const observer = new MutationObserver(() => { if(view !== lastView){ lastView = view; window.scrollTo(0, 0); const h = app.querySelector('h1'); if(h && view !== 'menu') h.focus({ preventScroll: true }); } });
observer.observe(app, { childList: true });

async function start(){
  if(!link.token){ app.textContent = ''; const p = el('main', 'page narrow'), e = el('div', 'empty'); e.append(el('h2', '', 'This link is incomplete'), el('p', 'muted', 'Ask the shop for its store link again.')); p.appendChild(e); app.appendChild(p); return; }
  if(!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY){ fail('This store is not set up yet.'); return; }
  if(orderInLink){ openStatus(orderInLink, ''); }
  try{
    const result = await rpc('hangtag_mobile_catalog', { p_token: link.token });
    if(!result || !result.ok){ closedMessage = (result && result.message) || 'This store is not open right now.'; if(result && result.shop) closedShop = { shop: result.shop, city: result.city }; if(!orderInLink) fail(closedMessage); return; }
    menu = result; configureMoney(regionOf(menu.region)); trimCart();
    document.title = (menu.shop || 'Shop') + ' · Order online';
    if(orderInLink){ render(); return; }
    render();
    const last = readLocal(key + ':last-order', null);
    if(last && last.token && !count()) openStatus(last.token, last.no);
  }catch(e){ if(!orderInLink) fail((e && e.message) || 'The store could not be loaded. Check your connection and try again.'); }
}
start();
