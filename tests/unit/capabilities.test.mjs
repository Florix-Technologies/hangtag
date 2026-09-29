// Business types and capabilities (F2): the five types' defaults, the shop's own choices (override, persistence, sync —
// an older copy never wipes them), legacy profiles, the navigation module registry (by capability, by permission, by
// whether a module exists), the product form's fields, the settings sections (Team & devices for every business), and
// capabilities never granting permissions. Run: npm run test:unit
import { store } from '../../src/shared/state/store.js';
import { memStorage, installFakeDom } from '../helpers/fake-env.mjs';
import { BUSINESS_TYPES, BUSINESS_TYPE_KEYS, CAPABILITIES, CAP_KEYS, DEFAULT_CAPS, ROLE_SUGGESTIONS, TRACKING_KEYS, businessKind, businessLabel,
  capOverridesAfter, capSections, capsFor, cleanCapOverrides, cleanTracking, defaultCaps, featureShown, keepNewerCaps, productFieldsFor,
  roleSuggestionsFor } from '../../src/domain/shop/capabilities.js';
import * as permissionsModule from '../../src/domain/shop/permissions.js';
import { PERMISSIONS, ROLE_DEFAULTS, permissionsFor } from '../../src/domain/shop/permissions.js';
import { can, setAccess } from '../../src/features/shop/services/access.js';
import { hasCap, shopCaps, shopType, shopTypeLabel } from '../../src/features/shop/services/shop-caps.js';
import { chooseSubview, currentSubview, moduleShown, navSlots, registerModule, registerSubview, registeredModules, shownModules, subviewsOf } from '../../src/features/shop/services/modules.js';
import { SETTINGS_SECTIONS, registerSettingsPart, settingsPartsHTML, settingsSections } from '../../src/features/shop/services/settings-sections.js';
import { saveCapabilities } from '../../src/features/shop/use-cases/save-capabilities.js';
import { tabOpen } from '../../src/features/shop/components/access-ui.js';
import { productRow, rowToProduct } from '../../src/infrastructure/supabase/mappers.js';
import { upgradeCatalog } from '../../src/domain/catalog/catalog-migration.js';
import { DEFAULT_SETTINGS } from '../../src/domain/shop/settings.js';
import { tidyProfile, checkProfile } from '../../src/domain/shop/profile-validation.js';
import { PROFILE_FIELDS } from '../../src/domain/shop/profile.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const on = (caps) => CAP_KEYS.filter((k) => caps[k]).sort();
const RESTAURANT = ['uses_tables', 'uses_table_qr', 'uses_customer_ordering', 'uses_server_ordering', 'uses_kitchen'];
const SHOP = 'ab12cd34-ef56-4789-9abc-def012345678', MEMBER = '0f0e0d0c-0b0a-4909-8807-060504030201';

// ---------- the model ----------
check('five business types with labels (Hotel / Restaurant)', eq(BUSINESS_TYPE_KEYS, ['retail', 'grocery', 'restaurant', 'electronics', 'other'])
  && BUSINESS_TYPES.find((t) => t.key === 'restaurant').label === 'Hotel / Restaurant' && BUSINESS_TYPES.every((t) => t.label && t.hint));
check('twelve capabilities, each with a human name and a line of help', CAP_KEYS.length === 12 && eq(CAP_KEYS, ['uses_variants', 'uses_serials', 'uses_batches', 'uses_expiry',
  'uses_weight', 'uses_quotations', 'uses_sales_orders', 'uses_tables', 'uses_table_qr', 'uses_customer_ordering', 'uses_server_ordering', 'uses_kitchen'])
  && CAPABILITIES.every((c) => c.label && !/uses_/.test(c.label) && c.help));
check('human names as the owner reads them', CAPABILITIES.find((c) => c.key === 'uses_variants').label === 'Product variants'
  && CAPABILITIES.find((c) => c.key === 'uses_serials').label === 'Serial number tracking' && CAPABILITIES.find((c) => c.key === 'uses_weight').label === 'Weight-based products'
  && CAPABILITIES.find((c) => c.key === 'uses_customer_ordering').label === 'Customer table ordering');

// ---------- 1–5: the defaults of each business type ----------
check('1 retail: variants, quotations, sales orders; no restaurant capability', eq(on(defaultCaps('retail')), ['uses_quotations', 'uses_sales_orders', 'uses_variants'])
  && RESTAURANT.every((k) => !defaultCaps('retail')[k]));
check('2 grocery: variants, batches, expiry, weight, quotations, sales orders; no restaurant capability',
  eq(on(defaultCaps('grocery')), ['uses_batches', 'uses_expiry', 'uses_quotations', 'uses_sales_orders', 'uses_variants', 'uses_weight']) && RESTAURANT.every((k) => !defaultCaps('grocery')[k]));
check('3 electronics: variants, serials, quotations, sales orders; no restaurant capability',
  eq(on(defaultCaps('electronics')), ['uses_quotations', 'uses_sales_orders', 'uses_serials', 'uses_variants']) && RESTAURANT.every((k) => !defaultCaps('electronics')[k]));
check('4 hotel / restaurant: tables, table QR, customer and server ordering, kitchen', eq(on(defaultCaps('restaurant')), RESTAURANT.slice().sort())
  && !defaultCaps('restaurant').uses_serials && !defaultCaps('restaurant').uses_batches);
check('5 other: the simplest general set (no serials, batches, weight, orders or restaurant)', eq(on(defaultCaps('other')), ['uses_variants']));
check('defaults cover every capability with true/false', BUSINESS_TYPE_KEYS.every((t) => eq(Object.keys(defaultCaps(t)), CAP_KEYS) && Object.values(defaultCaps(t)).every((v) => typeof v === 'boolean'))
  && BUSINESS_TYPE_KEYS.every((t) => Array.isArray(DEFAULT_CAPS[t])));

// ---------- legacy: profiles saved before business types, and profiles without one ----------
check('legacy profile values count as retail, "Other" as other, none as retail', ['Clothing boutique', 'Pop-up or exhibition stall', 'Retail store', 'Online seller', 'Wholesale'].every((v) => businessKind(v) === 'retail')
  && businessKind('Other') === 'other' && businessKind(null) === 'retail' && businessKind('') === 'retail' && businessKind(undefined) === 'retail' && businessKind('something else') === 'retail');
check('the keys and close words are understood', businessKind('grocery') === 'grocery' && businessKind('Kirana store') === 'grocery' && businessKind('Hotel') === 'restaurant'
  && businessKind('Mobile shop') === 'electronics' && businessLabel('Clothing boutique') === 'Retail' && businessLabel('restaurant') === 'Hotel / Restaurant');
check('a shop without capability choices gets its type\'s defaults', eq(capsFor('grocery', undefined), defaultCaps('grocery')) && eq(capsFor(null, null), defaultCaps('retail'))
  && eq(capsFor('retail', 'junk'), defaultCaps('retail')));
check('the settings defaults hold no capability choices (no data migration needed)', !('caps' in DEFAULT_SETTINGS) && !('capsAt' in DEFAULT_SETTINGS));

// ---------- 7: override (defaults are never restrictions) ----------
check('7 grocery + serial numbers', capsFor('grocery', { uses_serials: true }).uses_serials && capsFor('grocery', { uses_serials: true }).uses_batches);
check('7 restaurant + batch and expiry', (() => { const c = capsFor('restaurant', { uses_batches: true, uses_expiry: true }); return c.uses_batches && c.uses_expiry && c.uses_tables; })());
check('7 a default switched off stays off', !capsFor('retail', { uses_variants: false }).uses_variants && !capsFor('electronics', { uses_serials: false }).uses_serials);
check('7 one that builds on another is off while that one is (Table QR, customer ordering need tables)', (() => { const c = capsFor('restaurant', { uses_tables: false }); return !c.uses_table_qr && !c.uses_customer_ordering && !c.uses_server_ordering && c.uses_kitchen; })());
check('7 only differences from the type\'s defaults are stored', eq(capOverridesAfter('retail', {}, { uses_variants: true, uses_serials: true }).overrides, { uses_serials: true })
  && eq(capOverridesAfter('retail', { uses_serials: true }, { uses_serials: false }).overrides, {}));
check('7 an unknown capability or a value that isn\'t on/off is refused', /Unknown capability/.test(capOverridesAfter('retail', {}, { uses_magic: true }).error)
  && /on or off/.test(capOverridesAfter('retail', {}, { uses_serials: 'yes' }).error));
check('7 stored choices are cleaned (unknown keys and non-booleans dropped)', eq(cleanCapOverrides({ uses_serials: true, uses_x: true, uses_batches: 'no' }), { uses_serials: true }) && eq(cleanCapOverrides([1]), {}));

// ---------- Settings → Capabilities: grouped and recommended by type ----------
{
  const r = capSections('retail'), g = capSections('grocery'), h = capSections('restaurant');
  check('recommended group first, with the type\'s defaults', r[0].key === 'recommended' && r[0].open && eq(r[0].caps.map((c) => c.key).sort(), DEFAULT_CAPS.retail.slice().sort())
    && g[0].label === 'Recommended for Grocery' && eq(h[0].caps.map((c) => c.key).sort(), RESTAURANT.slice().sort()));
  check('every capability listed once', BUSINESS_TYPE_KEYS.every((t) => eq(capSections(t).flatMap((s) => s.caps.map((c) => c.key)).sort(), CAP_KEYS.slice().sort())));
  check('restaurant capabilities folded away for a retail shop (open once one is switched on)', r.find((s) => s.key === 'restaurant').open === false
    && capSections('retail', capsFor('retail', { uses_kitchen: true })).find((s) => s.key === 'restaurant').open === true);
}

// ---------- 6: persistence and sync ----------
const mem = memStorage();
installFakeDom();
Object.assign(store, { access: null, authUser: { id: SHOP, user_metadata: {} }, profile: { shop_name: 'Aura', business_type: 'retail' }, settings: Object.assign({}, DEFAULT_SETTINGS),
  sbOfflineQueue: [], syncReview: [], prefs: { tab: 'sell' } });
{
  const r = saveCapabilities({ uses_serials: true, uses_variants: true });
  check('6 saved into the shop\'s settings (only the difference) with when it changed', r.ok && eq(store.settings.caps, { uses_serials: true }) && typeof store.settings.capsAt === 'number' && r.caps.uses_serials);
  check('6 kept on this device and queued for upload with the settings', eq(JSON.parse(mem.mem.rc_settings).caps, { uses_serials: true }) && store.sbOfflineQueue.some((q) => q.type === 'settings'));
  const reloaded = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(mem.mem.rc_settings));
  check('6 after a restart (or offline) the same capabilities', capsFor('retail', reloaded.caps).uses_serials && eq(capsFor('retail', reloaded.caps), shopCaps()));
  const at = store.settings.capsAt;
  saveCapabilities({ uses_kitchen: true });
  check('6 a later change is later even when this clock is behind', store.settings.capsAt > at && store.settings.caps.uses_kitchen && store.settings.caps.uses_serials);
  const kept = store.settings;
  const old = keepNewerCaps({ lowStock: 9 }, kept), older = keepNewerCaps({ lowStock: 8, caps: {}, capsAt: at - 5 }, kept), newer = keepNewerCaps({ lowStock: 7, caps: { uses_weight: true }, capsAt: kept.capsAt + 10 }, kept);
  check('6 a copy without capabilities (older phone or app) never wipes them; its other settings still arrive', eq(old.caps, kept.caps) && old.capsAt === kept.capsAt && old.lowStock === 9);
  check('6 an older copy of the choices loses, a newer one wins', eq(older.caps, kept.caps) && older.lowStock === 8 && eq(newer.caps, { uses_weight: true }));
  check('6 nothing kept yet: the download is taken as it is', eq(keepNewerCaps({ caps: { uses_tables: true }, capsAt: 1 }, {}), { caps: { uses_tables: true }, capsAt: 1 }));
  store.settings = Object.assign({}, DEFAULT_SETTINGS); store.sbOfflineQueue = [];
}

// ---------- the shop's type and capabilities (read model) ----------
store.profile = { shop_name: 'Aura', business_type: 'Clothing boutique' };
check('12 an existing shop (older profile value, no choices) is a retail shop with retail defaults', shopType() === 'retail' && shopTypeLabel() === 'Retail' && eq(shopCaps(), defaultCaps('retail')));
store.profile = { shop_name: 'Aura' };
check('12 a profile without a type is retail', shopType() === 'retail' && hasCap('uses_variants') && !hasCap('uses_tables'));

// ---------- 8: navigation — by capability, by permission, and whether the module exists ----------
const ids = () => shownModules().map((d) => d.id);
{
  store.profile = { shop_name: 'Aura', business_type: 'retail' };
  check('8 the core modules are registered with the existing tab ids', ['home', 'sell', 'orders', 'stock', 'products', 'customers', 'report', 'settings'].every((id) => registeredModules().includes(id)));
  check('8 retail owner: Home, Sell, Inventory, Products, Customers, Reports, Settings (no Orders while none of its parts exists)',
    eq(ids(), ['home', 'sell', 'stock', 'products', 'customers', 'report', 'settings']) && !moduleShown('orders'));
  check('8 the first version\'s tabs still open', ['sell', 'stock', 'report', 'products', 'customers'].every(tabOpen) && !tabOpen('settings') && !tabOpen('nope'));
  registerSubview('orders', { id: 'quotes', label: 'Quotations', order: 20, caps: ['uses_quotations'], perms: ['create_order'], render() {} });
  registerSubview('orders', { id: 'tableorders', label: 'Table orders', order: 40, caps: ['uses_tables'], perms: ['create_order'], render() {} });
  check('8 Orders appears once a part of it exists and the shop uses it', moduleShown('orders') && ids().includes('orders') && eq(subviewsOf('orders').map((d) => d.id), ['quotes']));
  check('8 table orders never for a normal retail shop', !subviewsOf('orders').some((d) => d.id === 'tableorders'));
  store.settings = Object.assign({}, DEFAULT_SETTINGS, { caps: { uses_quotations: false, uses_sales_orders: false } });
  check('8 Orders hidden again when the shop uses none of its parts', !moduleShown('orders'));
  store.settings = Object.assign({}, DEFAULT_SETTINGS);
  check('8 Tables and Kitchen stay hidden until their module exists (even for a restaurant)', (() => { store.profile.business_type = 'restaurant'; const r = !ids().includes('tables') && !ids().includes('kitchen'); store.profile.business_type = 'retail'; return r; })());
  registerModule({ id: 'tables', label: 'Tables', order: 32, phone: 25, caps: ['uses_tables'], render() {} });
  registerModule({ id: 'kitchen', label: 'Kitchen', order: 34, phone: 25, caps: ['uses_kitchen'], render() {} });
  check('8 registered: not for retail, grocery or electronics', ['retail', 'grocery', 'electronics', 'other'].every((t) => { store.profile.business_type = t; return !ids().includes('tables') && !ids().includes('kitchen'); }));
  store.profile.business_type = 'restaurant';
  check('8 a restaurant sees Tables and Kitchen, and its table orders', ids().includes('tables') && ids().includes('kitchen') && subviewsOf('orders').some((d) => d.id === 'tableorders'));
  store.profile.business_type = 'retail'; store.settings = Object.assign({}, DEFAULT_SETTINGS, { caps: { uses_tables: true } });
  check('8 any shop that switches on a capability gets its module', ids().includes('tables') && !ids().includes('kitchen'));
  store.settings = Object.assign({}, DEFAULT_SETTINGS);
  registerSubview('stock', { id: 'levels', label: 'Stock', order: 10, main: true, render() {} });
  check('8 Inventory with one part shows no part bar; a later part adds itself', subviewsOf('stock').length === 1
    && (registerSubview('stock', { id: 'purchases', label: 'Purchases', order: 20, perms: ['create_purchase'], render() {} }), subviewsOf('stock').length === 2));
  check('8 the part chosen last is remembered', (chooseSubview('stock', 'purchases'), currentSubview('stock').id === 'purchases') && (chooseSubview('stock', 'gone'), currentSubview('stock').id === 'levels'));
  // by permission (a team member)
  store.authUser = { id: MEMBER, user_metadata: { staff: true } };
  setAccess({ userId: MEMBER, shopId: SHOP, role: 'cashier', perms: ROLE_DEFAULTS.cashier, overrides: {} });
  check('8 a cashier: no Reports; Sell, Home, Customers shown', !ids().includes('report') && ['home', 'sell', 'customers', 'settings'].every((id) => ids().includes(id)) && !tabOpen('report'));
  check('8 a cashier doesn\'t see Purchases (a permission it lacks)', !subviewsOf('stock').some((d) => d.id === 'purchases'));
  setAccess({ userId: MEMBER, shopId: SHOP, role: 'kitchen', perms: ROLE_DEFAULTS.kitchen, overrides: {} });
  store.profile.business_type = 'restaurant';
  check('8 a kitchen member in a restaurant: Kitchen, no Sell or Reports', ids().includes('kitchen') && !ids().includes('sell') && !ids().includes('report'));
  store.profile.business_type = 'retail';
  check('8 ...and nothing of the kitchen in a shop without it', !ids().includes('kitchen'));
  setAccess(null); store.authUser = { id: SHOP, user_metadata: {} };
  check('8 featureShown: capabilities, permissions and availability all have to agree', featureShown({ caps: ['uses_tables'] }, { uses_tables: true }, () => true)
    && !featureShown({ caps: ['uses_tables'] }, {}, () => true) && !featureShown({ perms: ['view_reports'] }, {}, () => false)
    && !featureShown({ available: () => false }, {}, () => true) && !featureShown(null, {}, () => true));
}
// the tab bar on a phone: the most needed stay, the rest go behind More
{
  const list = shownModules();
  const s = navSlots(list, 'sell', 6);
  check('phone tab bar: at most 5 buttons + More, the rest behind More', s.bar.length === 5 && s.more.length === list.length - 5 && s.bar.includes('sell') && s.bar.includes('home'));
  check('phone tab bar: the page on screen keeps its button', navSlots(list, 'settings', 6).bar.includes('settings') || navSlots(list, 'products', 6).bar.includes('products'));
  check('wide screen: everything fits, no More', navSlots(list, 'sell', 11).more.length === 0);
}

// ---------- 9: product fields by capability ----------
{
  const f = (t, prod, own) => productFieldsFor(capsFor(t, own), prod);
  check('9 retail: variants; no tracking, expiry or weight fields', f('retail').variants && !f('retail').tracking && !f('retail').expiry && !f('retail').weight);
  check('9 electronics: variants and tracking None / Serial number', f('electronics').variants && f('electronics').tracking && eq(f('electronics').trackingModes, ['none', 'serial']));
  check('9 grocery: tracking None / Batch, the expiry note and weight guidance', eq(f('grocery').trackingModes, ['none', 'batch']) && f('grocery').expiry && f('grocery').weight);
  check('9 hotel / restaurant: kept simple (no variants, tracking, expiry or weight)', !f('restaurant').variants && !f('restaurant').tracking && !f('restaurant').expiry && !f('restaurant').weight);
  check('9 a product that already has variants keeps showing them', f('restaurant', { hasOpts: true }).variants && f('retail', { hasOpts: true }, { uses_variants: false }).variants);
  check('9 a saved tracking stays visible with the capability off', f('retail', { tracking: 'serial' }).tracking && eq(f('retail', { tracking: 'serial' }).trackingModes, ['none', 'serial']));
  check('9 grocery + serials: all three modes', eq(f('grocery', null, { uses_serials: true }).trackingModes, TRACKING_KEYS));
  check('9 tracking typed: one of the modes, else none', cleanTracking('serial') === 'serial' && cleanTracking('batch') === 'batch' && cleanTracking('x') === 'none' && cleanTracking(undefined) === 'none');
  const row = productRow({ id: 'p', name: 'Phone', price: 100, tracking: 'serial', opts: [], variants: [] }, 0), row0 = productRow({ id: 'q', name: 'Tee', price: 1, opts: [], variants: [] }, 1);
  check('9 tracking uploads with the product (none when not set)', row.tracking === 'serial' && row0.tracking === 'none' && productRow({ id: 'r', name: 'x', price: 1, tracking: 'bad', opts: [], variants: [] }, 0).tracking === 'none');
  check('9 tracking downloads with the product (not stored when none)', rowToProduct({ id: 'p', name: 'Phone', price: 1, tracking: 'serial', options: { opts: [] } }).tracking === 'serial'
    && !('tracking' in rowToProduct({ id: 'p', name: 'Tee', price: 1, tracking: 'none', options: { opts: [] } })) && !('tracking' in rowToProduct({ id: 'p', name: 'Tee', price: 1, options: null })));
  const cat = upgradeCatalog({ version: 3, products: [{ id: 'p', name: 'Phone', price: 1, tracking: 'batch', opts: [], variants: [{ id: 'v', o: [], sku: '', bc: '', price: null, cost: null, active: true }] }] }, { deviceId: 'd', now: 1 }).cat;
  check('9 tracking survives a backup restore (catalog upgrade)', cat.products[0].tracking === 'batch');
}

// ---------- 10: Team & devices and Roles & permissions for every business ----------
{
  check('10 the settings sections: Business, Capabilities, Receipt, Taxes, Team & devices, Roles & permissions, Hardware, Account',
    eq(SETTINGS_SECTIONS.map((s) => s.label), ['Business', 'Capabilities', 'Receipt', 'Taxes', 'Team & devices', 'Roles & permissions', 'Hardware', 'Account']));
  check('10 the owner of every type of business has Team & devices and Roles & permissions', BUSINESS_TYPE_KEYS.concat(['Clothing boutique', null]).every((t) => {
    store.profile = { shop_name: 'S', business_type: t }; const k = settingsSections().map((s) => s.key); return k.includes('team') && k.includes('roles') && k.length === 8; }));
  check('10 roles offered by type (one source): restaurant adds server and kitchen', eq(roleSuggestionsFor('restaurant'), ['manager', 'cashier', 'server', 'kitchen']) && eq(roleSuggestionsFor('Clothing boutique'), ['manager', 'cashier'])
    && eq(ROLE_SUGGESTIONS.grocery, ['manager', 'cashier']) && !('ROLE_SUGGESTIONS' in permissionsModule));
  store.authUser = { id: MEMBER, user_metadata: { staff: true } };
  setAccess({ userId: MEMBER, shopId: SHOP, role: 'cashier', perms: ROLE_DEFAULTS.cashier, overrides: {} });
  check('10 a cashier: only Hardware and its own account (no team, no shop settings)', eq(settingsSections().map((s) => s.key), ['hardware', 'account']));
  setAccess({ userId: MEMBER, shopId: SHOP, role: 'custom', perms: ['view_products', 'manage_settings'], overrides: {} });
  check('10 a member allowed to manage settings: the shop\'s settings, still no team screens', eq(settingsSections().map((s) => s.key), ['business', 'capabilities', 'receipt', 'taxes', 'hardware', 'account']));
  registerSettingsPart('hardware', { id: 'scale', order: 20, perms: ['manage_settings'], html: () => '<div id="scaleSet"></div>' });
  check('10 later batches add parts to a section (with their own permission)', settingsPartsHTML('hardware') === '<div id="scaleSet"></div>');
  setAccess({ userId: MEMBER, shopId: SHOP, role: 'cashier', perms: ROLE_DEFAULTS.cashier, overrides: {} });
  check('10 ...hidden from a role without it', settingsPartsHTML('hardware') === '');
}

// ---------- 11: capabilities never grant permissions ----------
{
  store.profile = { shop_name: 'S', business_type: 'restaurant' }; store.settings = Object.assign({}, DEFAULT_SETTINGS); store.sbOfflineQueue = [];
  check('11 a cashier in a restaurant with every capability on still can\'t manage settings, tables or the kitchen', (() => {
    store.settings.caps = Object.fromEntries(CAP_KEYS.map((k) => [k, true]));
    return !can('manage_settings') && !can('manage_users') && !can('manage_kitchen') && !can('view_reports'); })());
  const before = JSON.stringify(store.settings);
  const r = saveCapabilities({ uses_weight: true });
  check('11 a role without manage_settings can\'t change capabilities: refused before anything changes', /can't change what this shop uses/.test(r.error || '') && JSON.stringify(store.settings) === before && store.sbOfflineQueue.length === 0, r);
  check('11 a role\'s permissions are the same whatever the business type', ['retail', 'grocery', 'restaurant', 'electronics', 'other'].every((t) => { store.profile.business_type = t; return eq(permissionsFor('cashier', {}), ROLE_DEFAULTS.cashier) && !can('manage_settings'); }));
  setAccess(null); store.authUser = { id: SHOP, user_metadata: {} }; store.settings = Object.assign({}, DEFAULT_SETTINGS);
  check('11 the owner may do everything in every type of business, with or without capabilities', ['retail', 'restaurant'].every((t) => { store.profile.business_type = t; return PERMISSIONS.every(can); }));
  check('11 turning a capability off never removes a permission', (() => { store.settings = Object.assign({}, DEFAULT_SETTINGS, { caps: { uses_variants: false, uses_quotations: false } }); return PERMISSIONS.every(can); })());
  store.settings = Object.assign({}, DEFAULT_SETTINGS);
}

// ---------- the profile: type asked at setup, kept in settings ----------
{
  check('setup asks the type after the shop name', PROFILE_FIELDS[0].k === 'shop_name' && PROFILE_FIELDS[1].k === 'business_type' && PROFILE_FIELDS[1].select.length === 5);
  const base = { shop_name: 'S', full_name: 'A', phone: '9876543210', city: 'Pune', state: 'MH' };
  check('setup: the type must be chosen', /Choose the type of business/.test((checkProfile(tidyProfile(base), { needType: true }) || {}).error || ''));
  check('settings: a profile without a type still saves (legacy)', checkProfile(tidyProfile(base)) === null);
  check('a legacy value typed is stored as its type key', tidyProfile({ ...base, business_type: 'Clothing boutique' }).business_type === 'retail' && tidyProfile({ ...base, business_type: 'grocery' }).business_type === 'grocery');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
