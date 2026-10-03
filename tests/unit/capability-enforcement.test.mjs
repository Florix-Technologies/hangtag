// Capabilities are more than switches (Wave 3, part 8): what a shop doesn't use isn't in its navigation, can't be opened
// directly, and its use cases refuse it — tables, table QR, guest and server ordering, kitchen, quotations and sales
// orders, serial numbers, batches, expiry dates and selling by weight. With the capability on, the workflow works; roles
// still decide who does what (a server takes orders but doesn't bill or set up tables; the kitchen moves tickets only).
// Business types give the defaults (domain/shop/capabilities.js); the owner's choices override them.
// Run: npm run test:unit
import { capsFor } from '../../src/domain/shop/capabilities.js';
import { createLocalFirstOrderRepository } from '../../src/infrastructure/repositories/local-first-order-repository.js';
import { createLocalFirstTableRepository } from '../../src/infrastructure/repositories/local-first-table-repository.js';
import { createLocalFirstProductRepository } from '../../src/infrastructure/repositories/local-first-product-repository.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };

// ---------- the defaults by type of business (the owner can change them) ----------
console.log('=== defaults ===');
const on = (type, over) => Object.entries(capsFor(type, over)).filter(([, v]) => v).map(([k]) => k.replace('uses_', '')).sort().join(',');
check('retail: basic POS and inventory (variants, quotations, sales orders, purchase orders)', on('retail') === 'purchase_orders,quotations,sales_orders,variants', on('retail'));
check('grocery: batches, expiry, weight', /batches/.test(on('grocery')) && /expiry/.test(on('grocery')) && /weight/.test(on('grocery')) && !/serials|tables/.test(on('grocery')), on('grocery'));
check('electronics: serial numbers', /serials/.test(on('electronics')) && !/batches|weight|tables/.test(on('electronics')), on('electronics'));
check('hotel / restaurant: tables, table QR, customer and server ordering, kitchen', ['tables', 'table_qr', 'customer_ordering', 'server_ordering', 'kitchen'].every((k) => on('restaurant').split(',').includes(k)), on('restaurant'));
check('other: a simple generic POS', !/serials|batches|weight|tables|kitchen|quotations/.test(on('other')), on('other'));
check('the owner overrides (grocery + serials; restaurant without the kitchen)', /serials/.test(on('grocery', { uses_serials: true })) && !/kitchen/.test(on('restaurant', { uses_kitchen: false })));

// ---------- the app ----------
const el = installFakeDom();
globalThis.document.addEventListener = () => {};
globalThis.window = globalThis.window || { addEventListener(){} };
globalThis.confirm = () => true;
globalThis.location = { href: 'https://florix-technologies.github.io/hangtag/' };
memStorage();
const P = await import('../../src/shared/state/persistence.js');
const OB = await import('../../src/features/sync/services/outbox.js');
const outbox = { enqueue: OB.enqueue, dropQueued: OB.dropQueued };
const { invalidate } = await import('../../src/features/inventory/services/ledger.js');
override({
  orderRepository: createLocalFirstOrderRepository({ store, persist: { saveOrders: P.saveOrders, saveHeldCarts: P.saveHeldCarts }, outbox }),
  tableRepository: createLocalFirstTableRepository({ store, persist: { saveTables: P.saveTables, saveTableSessions: P.saveTableSessions }, outbox }),
  productRepository: createLocalFirstProductRepository({ store, persist: P, outbox, invalidate }),
  cloud: { auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) } },
});
Object.assign(store, { dev: 'd1', remoteDays: {}, localDays: {}, dirty: new Set(), returnsMap: {}, _d: null, customers: { c1: { id: 'c1', name: 'Asha', phone: '9876543210' } }, cartCust: null, cartOrder: null, cartTable: null,
  disc: null, cart: [], sbOfflineQueue: [], syncReview: [], sbClient: null, sbStatus: 'disconnected', events: {}, prefs: { event: '', tab: 'sell' }, lastCheckout: 0, deliveries: {}, channels: null,
  settings: { taxOn: false, prefix: 'INV-' }, profile: { business_type: 'retail' }, moves: {}, cashMoves: {}, dayCloses: {}, deliveryQueue: [], payConfig: null, collections: {}, heldCarts: {}, orders: {}, tables: {}, tableSessions: {},
  access: null, imgs: {}, pend: { cat: false, img: {} }, quoteSends: [],
  catalog: { version: 3, products: [{ id: 'p1', name: 'Dosa', price: 120, opts: [], variants: [{ id: 'p1:', o: [], active: true }] }] } });
store.moves = { m1: { id: 'm1', v: 'p1:', p: 'p1', q: 50, type: 'in', t: 1 } };
invalidate();
const { installModules } = await import('../../src/app/modules.js');
installModules();
const MOD = await import('../../src/features/shop/services/modules.js');
const T = await import('../../src/features/restaurant/use-cases/tables.js');
const RS = await import('../../src/features/restaurant/services/restaurant-state.js');
const OU = await import('../../src/features/orders/use-cases/orders.js');
const HC = await import('../../src/features/orders/use-cases/held-carts.js');
const SP = await import('../../src/features/products/use-cases/save-product.js');
const shown = () => MOD.shownModules().map((d) => d.id);
const member = (role, perms) => { store.access = { role, perms, shopId: 'owner1' }; };
const owner = () => { store.access = null; };
const setType = (t, caps) => { store.profile = { business_type: t }; store.settings = { ...store.settings, caps: caps || undefined }; if(!caps) delete store.settings.caps; };

console.log('\n=== off: hidden, unreachable, refused ===');
setType('retail');
check('a retail shop: no Tables or Kitchen in the navigation', !shown().includes('tables') && !shown().includes('kitchen') && shown().includes('sell'), shown());
check('…and they can\'t be opened directly (the route is closed)', !MOD.moduleShown('tables') && !MOD.moduleShown('kitchen'));
check('…set up a table: refused', /doesn't use tables/.test(T.saveTable({ name: 'T1' }).error || ''));
check('…seat guests, take a table order, move a kitchen ticket, bill a table: refused', /doesn't use tables/.test(T.seatTable('x').error || '') && /doesn't use tables/.test(T.sendTableOrder('x', [{ v: 'p1:', q: 1 }]).error || '')
  && /doesn't use tables/.test(T.setTableOrderStatus('x', 'accepted').error || '') && /doesn't use tables/.test(T.billTable('x').error || ''));
setType('other');
const qd = { ...OU.newOrderDraft('quote', { cust: { id: 'c1', name: 'Asha' } }), items: [OU.orderLine('p1:', 1)] };
check('a shop without quotations or sales orders: saving one is refused', /Quotations are switched off/.test(OU.saveOrder(qd).error || '') && /Sales orders are switched off/.test(OU.saveOrder({ ...qd, id: 'o2', kind: 'sales' }).error || ''));
const draft = (over) => ({ id: 'np' + Math.random().toString(36).slice(2, 6), name: 'Phone X', price: '9000', cost: '', color: '', archived: false, hsn: '', gst: '', unit: 'pcs', tracking: 'none', hasOpts: false, opts: [],
  cells: { '': { id: '', o: [], sku: '', bc: '', price: '', cost: '', stock: '', active: true } }, codesOn: false, code: '', ...over });
check('serial numbers off: a product can\'t start being tracked by serial', /Serial numbers are switched off/.test(SP.saveProduct({ draft: draft({ tracking: 'serial' }) }).error || ''));
check('batches off: …nor by batch; expiry off: …nor keep expiry dates', /Batch tracking is switched off/.test(SP.saveProduct({ draft: draft({ tracking: 'batch' }) }).error || '')
  && /(Batch tracking|Expiry dates) is switched off|Expiry dates are switched off/.test(SP.saveProduct({ draft: draft({ tracking: 'expiry' }) }).error || ''));
check('weight off: a product can\'t start being sold by the kg', /Selling by weight is switched off/.test(SP.saveProduct({ draft: draft({ unit: 'kg', tracking: 'none' }) }).error || ''));
check('…a plain product is still fine', !SP.saveProduct({ draft: draft({ name: 'Cap' }) }).error);

console.log('\n=== on: the workflows work ===');
setType('grocery');
check('grocery: batches with expiry and selling by the kg are allowed', !SP.saveProduct({ draft: draft({ name: 'Rice', unit: 'kg', tracking: 'expiry' }) }).error);
setType('electronics');
check('electronics: serial numbers are allowed', !SP.saveProduct({ draft: draft({ name: 'Phone S', tracking: 'serial' }) }).error);
setType('retail', { uses_serials: true });
check('retail with Serial numbers switched on by the owner: allowed', !SP.saveProduct({ draft: draft({ name: 'Phone R', tracking: 'serial' }) }).error);
setType('restaurant');
check('a restaurant: Tables and Kitchen in the navigation', shown().includes('tables') && shown().includes('kitchen'), shown());
let r = T.saveTable({ name: 'T1', seats: '4' });
const t1 = r.table;
check('the owner sets up a table; it gets its own QR token', !r.error && /^[A-Za-z0-9_-]{43}$/.test(t1.qr) && RS.tablesList().length === 1, r);
r = T.sendTableOrder(t1.id, [{ v: 'p1:', q: 2, note: 'crisp' }]);
check('an order for the table: a New table order for its session', !r.error && r.order.kind === 'table' && r.order.status === 'new' && r.order.tableId === t1.id && r.order.items[0].note === 'crisp' && RS.tableStateOf(t1.id) === 'preparing', r);
const ord = r.order;

console.log('\n=== roles still decide ===');
member('server', ['view_products', 'create_order', 'send_to_kitchen', 'manage_tables']);
check('a server (server ordering on) works the tables and takes orders', RS.mayWorkTables() && RS.mayTakeTableOrder() && !T.sendTableOrder(t1.id, [{ v: 'p1:', q: 1 }]).error);
check('…but never gets the owner\'s or the till\'s rights: no table set-up, no billing', /set up tables/.test(T.saveTable({ name: 'T9' }).error || '') && /bill tables/.test(T.billTable(t1.id).error || '')
  && !RS.maySetUpTables());
store.settings.caps = { uses_server_ordering: false };
check('server ordering switched off: a server can\'t take table orders (nor see the tables)', !RS.mayTakeTableOrder() && !RS.mayWorkTables() && /take table orders/.test(T.sendTableOrder(t1.id, [{ v: 'p1:', q: 1 }]).error || ''));
delete store.settings.caps;
member('kitchen', ['manage_kitchen']);
check('the kitchen sees its screen (not the tables) and moves tickets', MOD.moduleShown('kitchen') && !MOD.moduleShown('tables') && !T.setTableOrderStatus(ord.id, 'accepted').error && OU.orderById(ord.id).status === 'accepted');
check('…but takes no orders', !RS.mayTakeTableOrder() && !!T.sendTableOrder(t1.id, [{ v: 'p1:', q: 1 }]).error);
owner();
store.settings.caps = { uses_kitchen: false };
check('kitchen switched off: no Kitchen screen, and kitchen steps are refused (orders still go on the bill)', !MOD.moduleShown('kitchen') && /kitchen screen/.test(T.setTableOrderStatus(ord.id, 'preparing').error || ''));
delete store.settings.caps;
store.settings.caps = { uses_table_qr: false };
check('table QR switched off: no new QR codes', /table QR codes/.test(T.resetTableQr(t1.id).error || '') && !RS.tableQrOn() && !RS.guestOrderingOn());
delete store.settings.caps;

console.log('\n=== billing a table: the ordinary bill ===');
member('cashier', ['view_products', 'create_sale', 'apply_discount', 'perform_return', 'collect_credit', 'create_order', 'send_to_kitchen', 'manage_tables']);
r = T.billTable(t1.id);
check('the till bills the table: its orders\' lines go on the bill (2 + 1 dosa), marked as the table\'s', !r.error && store.cart.length === 1 && store.cart[0].q === 3 && store.cartTable && store.cartTable.table === t1.id
  && RS.tableStateOf(t1.id) === 'billing', { r, cart: store.cart });
check('a table\'s bill can\'t be held (Clear puts it back on the table)', /can't be held/.test(HC.holdCart().error || ''));
T.releaseTableBill(); store.cart = [];
check('Clear: the table goes back to its orders', RS.tableStateOf(t1.id) !== 'billing' && !store.cartTable);
owner();
check('a table with guests seated can\'t be removed', /bill them first/.test(T.archiveTable(t1.id).error || ''));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
