// Phase 21 (offline sync: one upload per record, order, dependencies, retries, refusals to review, never losing a bill),
// Phase 22 (Event Mode, and backup / restore: integrity, versions, shop isolation, all-or-nothing restore).
// Run: npm run test:unit
import { canDiscard, dependsOn, failureAction, isBlocked, itemKey, mergeIntoQueue, waitingKeys } from '../../src/domain/sync/queue-rules.js';
import { EVENT_STATUS, inFilter, sellingContext, sortEvents, validateEvent } from '../../src/domain/events/event.js';
import { AppError, ERROR_CODES as C } from '../../src/shared/errors/app-error.js';
import { createLocalFirstReturnRepository } from '../../src/infrastructure/repositories/local-first-return-repository.js';
import { createLocalFirstEventRepository } from '../../src/infrastructure/repositories/local-first-event-repository.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { installFakeDom, memStorage } from '../helpers/fake-env.mjs';
import { createHash } from 'crypto';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };

// ---------- queue rules ----------
{
  const q0 = [{ type: 'sale', sale: { id: 's1', total: 1 } }, { type: 'cust', id: 'c1', cust: { id: 'c1', name: 'A' } }];
  const q1 = mergeIntoQueue(q0, { type: 'cust', id: 'c1', cust: { id: 'c1', name: 'B' } });
  check('one waiting upload per record: a later change replaces it where it stands', q1.length === 2 && q1[1].cust.name === 'B');
  const q2 = mergeIntoQueue([{ ...q1[1], sending: true }], { type: 'cust', id: 'c1', cust: { id: 'c1', name: 'C' } });
  check('…but not one being sent (the new change gets its own upload)', q2.length === 2);
  check('record keys', itemKey({ type: 'sale', sale: { id: 's1' } }) === 'sale:s1' && itemKey({ type: 'return', id: 'r1' }) === 'return:r1' && itemKey({ type: 'settings' }) === null);
  check('a return waits for its bill, a cancel for its bill, a stock move for its product', dependsOn({ type: 'return', ret: { sale: 's1' } })[0] === 'sale:s1' && dependsOn({ type: 'void', id: 's1' })[0] === 'sale:s1' && dependsOn({ type: 'move', move: { p: 'p1' } })[0] === 'prod:p1');
  const w = waitingKeys([{ type: 'sale', sale: { id: 's1' } }, { type: 'prod', id: 'p1' }], [{ item: { type: 'sale', sale: { id: 's9' } } }]);
  check('waiting records include the review list', w.has('sale:s1') && w.has('prod:p1') && w.has('sale:s9') && isBlocked({ type: 'return', ret: { sale: 's9' } }, w) && !isBlocked({ type: 'return', ret: { sale: 's2' } }, w));
  check('refusals by the database go to review; network / sign-in / server errors retry; missing parents retry a few times',
    failureAction('VALIDATION', 1) === 'review' && failureAction('CONFLICT', 1) === 'review' && failureAction('NETWORK', 9) === 'retry' && failureAction('AUTH', 9) === 'retry'
    && failureAction('OUTDATED_DATABASE', 9) === 'retry' && failureAction('NOT_FOUND', 1) === 'retry' && failureAction('NOT_FOUND', 3) === 'review');
  check('a bill is never discarded from review', !canDiscard({ type: 'sale' }) && canDiscard({ type: 'return' }));
}

// ---------- the upload queue against a fake cloud ----------
installFakeDom();
const storage = memStorage();
const cloud = { calls: [], fail: {}, db: { sales: {}, returns: {}, voids: {} },
  auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
  async saveSale(s){ this.calls.push('sale:' + s.id); const f = this.fail['sale:' + s.id]; if(f) throw f(); this.db.sales[s.id] = s; },
  async setSaleVoid(id, v){ this.calls.push('void:' + id); if(!this.db.sales[id]) throw new AppError(C.NOT_FOUND, 'no bill'); this.db.voids[id] = v; },
  async saveReturn(r){ this.calls.push('return:' + r.id); const f = this.fail['return:' + r.id]; if(f) throw f(); if(!this.db.sales[r.sale]) throw new AppError(C.NOT_FOUND, 'Bill not found'); this.db.returns[r.id] = r; },
  async saveCustomer(c){ this.calls.push('cust:' + c.id); },
  async saveEvent(e){ this.calls.push('event:' + e.id); },
  async deleteEvent(id){ this.calls.push('eventdel:' + id); } };
override({ cloud });
const { enqueue, flushSbQueue, retryReview, discardReview } = await import('../../src/features/sync/services/outbox.js');
const { invalidate } = await import('../../src/features/inventory/services/ledger.js');
const { saveReturns, saveEvents } = await import('../../src/shared/state/persistence.js');
Object.assign(store, { dev: 'd1', sbClient: {}, sbStatus: 'connected', sbOfflineQueue: [], syncReview: [], returnsMap: {}, remoteDays: {}, localDays: {}, moves: {}, customers: {}, events: {},
  catalog: { version: 3, products: [] }, settings: {}, prefs: {}, _d: null, dirty: new Set(), lastSyncAt: 0 });
const sale = (id) => ({ id, t: 1, total: 100, items: [{ ln: 0, p: 'p1', v: 'v1', q: 1, price: 100 }] });
const reset = () => { cloud.calls = []; cloud.fail = {}; cloud.db = { sales: {}, returns: {}, voids: {} }; store.sbOfflineQueue = []; store.syncReview = []; store.returnsMap = {}; };

// offline → reconnect: work made offline uploads in order once online
reset(); store.sbStatus = 'error';
enqueue({ type: 'sale', sale: sale('s1') }); enqueue({ type: 'void', id: 's1', isVoid: true }); enqueue({ type: 'cust', id: 'c1', cust: { id: 'c1' } });
await flushSbQueue();
check('offline: nothing is sent, everything is kept (and saved on the device)', cloud.calls.length === 0 && store.sbOfflineQueue.length === 3 && JSON.parse(storage.mem.hangtag_sb_queue).length === 3);
store.sbStatus = 'connected'; await flushSbQueue();
check('reconnect: uploaded in the order made (the bill before its cancel), queue empty', cloud.calls.join() === 'sale:s1,void:s1,cust:c1' && !store.sbOfflineQueue.length && cloud.db.voids.s1 === true, cloud.calls);
// retry after a network failure; no duplicates
reset();
cloud.fail['sale:s2'] = () => new AppError(C.NETWORK, 'offline');
enqueue({ type: 'sale', sale: sale('s2') }); enqueue({ type: 'sale', sale: sale('s2') }); enqueue({ type: 'cust', id: 'c2', cust: { id: 'c2' } });
check('the same bill queued twice is one upload', store.sbOfflineQueue.filter((q) => q.type === 'sale').length === 1);
await flushSbQueue();
check('a failed bill holds back what comes after it (order kept), and stays queued with its error', cloud.calls.join() === 'sale:s2' && store.sbOfflineQueue.length === 2 && store.sbOfflineQueue[0].tries === 1 && store.sbOfflineQueue[0].err === 'offline');
delete cloud.fail['sale:s2']; await flushSbQueue();
check('retry succeeds: each change saved exactly once', cloud.calls.filter((c) => c === 'sale:s2').length === 2 && Object.keys(cloud.db.sales).length === 1 && !store.sbOfflineQueue.length);
// a refused bill goes to review (never lost); its return waits; other work carries on
reset();
cloud.fail['sale:s3'] = () => new AppError(C.VALIDATION, 'The payments on bill s3 come to 90 but 100 is due');
store.returnsMap.r3 = { id: 'r3', sale: 's3', items: [] };
enqueue({ type: 'sale', sale: sale('s3') }); enqueue({ type: 'return', id: 'r3', ret: store.returnsMap.r3 }); enqueue({ type: 'cust', id: 'c3', cust: { id: 'c3' } });
await flushSbQueue();
check('a bill the database refuses goes to review with its reason (not retried forever, not dropped)', store.syncReview.length === 1 && store.syncReview[0].item.sale.id === 's3' && /payments/.test(store.syncReview[0].err));
check('its return waits (queued, not sent); later work still uploads', store.sbOfflineQueue.length === 1 && store.sbOfflineQueue[0].type === 'return' && cloud.calls.join() === 'sale:s3,cust:c3', cloud.calls);
check('the bill can\'t be discarded from review', discardReview(0) === false && store.syncReview.length === 1);
delete cloud.fail['sale:s3']; retryReview(0); await flushSbQueue(); await flushSbQueue();
check('send again: the bill uploads, then the return waiting for it', !store.syncReview.length && !store.sbOfflineQueue.length && cloud.db.sales.s3 && cloud.db.returns.r3, { q: store.sbOfflineQueue, r: store.syncReview, calls: cloud.calls });
// a return refused because another device returned the same pieces
reset(); cloud.db.sales.s4 = sale('s4');
cloud.fail['return:r4'] = () => new AppError(C.VALIDATION, "Can't return 1 piece(s): 1 bought, 1 already returned");
store.returnsMap.r4 = { id: 'r4', sale: 's4', items: [{ ln: 0, q: 1, v: 'v1' }] }; invalidate();
enqueue({ type: 'return', id: 'r4', ret: store.returnsMap.r4 }); await flushSbQueue();
check('a return refused on sync is not applied: out of this device\'s stock and books, kept in review with its details', !store.returnsMap.r4 && store.syncReview[0].item.ret.id === 'r4' && /already returned/.test(store.syncReview[0].err));
check('…and it can be discarded after review', discardReview(0) === true && !store.syncReview.length);
// a cancel waits for its bill
reset();
cloud.fail['sale:s5'] = () => new AppError(C.UNKNOWN, 'server error');
enqueue({ type: 'sale', sale: sale('s5') }); enqueue({ type: 'void', id: 's5', isVoid: true }); await flushSbQueue();
check('a cancel is never sent before its bill (server error: both kept, in order)', cloud.calls.join() === 'sale:s5' && store.sbOfflineQueue.map((q) => q.type).join() === 'sale,void');
delete cloud.fail['sale:s5']; await flushSbQueue();
check('…then both go, bill first', cloud.calls.join() === 'sale:s5,sale:s5,void:s5' && cloud.db.voids.s5 === true);
// two devices: both upload their own bills to one cloud; ids never clash, nothing is doubled
reset();
enqueue({ type: 'sale', sale: sale('A-1') }); await flushSbQueue();
const devA = cloud.db.sales;
store.sbOfflineQueue = []; enqueue({ type: 'sale', sale: sale('B-1') }); enqueue({ type: 'sale', sale: sale('A-1') }); await flushSbQueue();
check('two devices (and a repeated upload of the same bill) end with one copy of each bill', Object.keys(devA).sort().join() === 'A-1,B-1');

// ---------- events ----------
check('event checks: name, dates, end not before start', validateEvent({ name: '', start: '2026-10-01', end: '2026-10-02' }) === 'Give the event a name.' && validateEvent({ name: 'X', start: '2026-10-02', end: '2026-10-01' }) === "The end date can't be before the start date." && validateEvent({ name: 'X', start: '2026-10-01', end: '2026-10-01' }) === null);
const evs = { e1: { id: 'e1', name: 'Fair', start: '2026-10-01', end: '2026-10-03', status: 'active' }, e2: { id: 'e2', name: 'Old', start: '2026-09-01', end: '2026-09-02', status: 'closed' } };
check('selling context: store, an active event, a closed one (no tag), a missing one, outside its dates',
  sellingContext(evs, 'store', '2026-10-02').event === null && sellingContext(evs, 'e1', '2026-10-02').event.id === 'e1' && !sellingContext(evs, 'e1', '2026-10-02').outside
  && sellingContext(evs, 'e2', '2026-10-02').event === null && sellingContext(evs, 'e2', '2026-10-02').notice === 'closed' && sellingContext(evs, 'e9', '2026-10-02').notice === 'missing' && sellingContext(evs, 'e1', '2026-10-09').outside);
check('report filter: everything, the store, one event', inFilter({ event: 'e1' }, '') && !inFilter({ event: 'e1' }, 'store') && inFilter({}, 'store') && inFilter({ event: 'e1' }, 'e1') && !inFilter({}, 'e1'));
check('events listed active first', sortEvents(Object.values(evs))[0].id === 'e1');
override({ eventRepository: createLocalFirstEventRepository({ store, persist: { saveEvents }, outbox: { enqueue, dropQueued: (f) => { store.sbOfflineQueue = store.sbOfflineQueue.filter((q) => !f(q)); } } }),
  returnRepository: createLocalFirstReturnRepository({ store, persist: { saveReturns }, outbox: { enqueue }, invalidate }) });
const M = await import('../../src/features/events/use-cases/manage-events.js');
const { newSaleRecord, recordSale } = await import('../../src/features/sales/use-cases/checkout.js');
reset(); store.sbStatus = 'error'; store.settings = { taxOn: false }; store.profile = {}; store.catalog = { version: 3, products: [{ id: 'p1', name: 'Tee', price: 100, opts: [], variants: [{ id: 'v1', o: [], active: true }] }] };
store.moves = { o: { id: 'o', v: 'v1', p: 'p1', type: 'OPENING', q: 10, t: 1 } }; invalidate();
const today = new Date(); const d = (n) => { const x = new Date(today); x.setDate(x.getDate() + n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const e = M.saveEvent({ name: ' Diwali pop-up ', start: d(-1), end: d(2), place: 'Pune' });
check('create an event: active, saved, queued for upload', !e.error && e.event.status === EVENT_STATUS.ACTIVE && e.event.name === 'Diwali pop-up' && store.events[e.event.id] && store.sbOfflineQueue.some((q) => q.type === 'event'));
check('choose it on this device', M.setSellingAt(e.event.id).ok && store.prefs.event === e.event.id);
const b1 = newSaleRecord([{ v: 'v1', p: 'p1', name: 'Tee', q: 1, price: 100 }], null, 'cash', { cust: null }); recordSale(b1);
check('a bill made while selling at the event is tagged with it', b1.event === e.event.id);
check('an event with bills can\'t be deleted (only closed)', /can't be deleted/.test(M.deleteEvent(e.event.id).error));
check('closing it: this device goes back to the store', M.setEventStatus(e.event.id, 'closed').event.status === 'closed' && store.prefs.event === 'store');
store.prefs.event = e.event.id;   // another device that hasn't heard yet
const b2 = newSaleRecord([{ v: 'v1', p: 'p1', name: 'Tee', q: 1, price: 100 }], null, 'cash', { cust: null });
check('a device still set to a closed event makes untagged bills', !b2.event);
check('a closed event can\'t be chosen, but can be reopened', /closed/.test(M.setSellingAt(e.event.id).error) && M.setEventStatus(e.event.id, 'active').event.status === 'active');
const e2 = M.saveEvent({ name: 'Unused', start: d(0), end: d(0) });
check('an event without bills can be deleted (the delete is queued)', M.deleteEvent(e2.event.id).ok && !store.events[e2.event.id] && store.sbOfflineQueue.some((q) => q.type === 'eventdel' && q.id === e2.event.id));
check('changing an event keeps its status and id', M.saveEvent({ id: e.event.id, name: 'Diwali', start: d(-1), end: d(5) }).event.id === e.event.id && store.events[e.event.id].end === d(5));

// ---------- backup and restore ----------
override({ files: { sha256Hex: async (blob) => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex'), saveFile: async () => true } });
const B = await import('../../src/features/backup/services/backup-file.js');
store.authUser = { id: 'owner-1' }; store.profile = { shop_name: 'Riya Fashions', api_key: 'sk-should-not-leak' }; store.settings = { taxOn: false, token: 'x', prefix: 'INV-' };
store.customers = { c1: { id: 'c1', name: 'Riya' } }; store.returnsMap = {}; store.imgs = {}; store.logo = ''; store.remoteDays = {};
const file = await B.buildBackup();
check('backup: version, shop identity, record counts, SHA-256', file.version === B.BACKUP_VERSION && file.shop.owner === 'owner-1' && file.shop.name === 'Riya Fashions' && file.counts.bills === 1 && file.counts.events === 1 && /^[0-9a-f]{64}$/.test(file.integrity.hash));
check('backup holds no secrets (no key/token fields, no sign-in, no upload queue, no printer)', !JSON.stringify(file).includes('sk-should-not-leak') && !('token' in file.data.settings) && !('sbOfflineQueue' in file.data) && !('printer' in file.data));
const json = JSON.parse(JSON.stringify(file));
check('a backup file checks out', (await B.readBackup(json)).integrity === 'ok');
const tampered = JSON.parse(JSON.stringify(file)); tampered.data.customers.c1.name = 'Someone else';
check('a changed or damaged file is caught (its SHA-256 no longer matches)', (await B.readBackup(tampered)).integrity === 'bad');
check('a file from a newer Hangtag is refused', /newer version/.test(B.inspectBackup(json.data, { ...json, version: 99 }).errs[0]));
check('not a Hangtag file: refused', B.inspectBackup({ app: 'other' }).ok === false);
check('another shop\'s backup is refused while this shop has data', /another shop/.test(B.inspectBackup(json.data, { ...json, shop: { owner: 'owner-2', name: 'Other' } }).errs[0]));
check('an older backup (version 3, no check) is still readable', (await B.readBackup({ app: 'hangtag', version: 3, days: {} })).integrity === 'none');
// restore into a fresh device: all or nothing
const fresh = () => { store.catalog = { version: 3, products: [] }; store.localDays = {}; store.remoteDays = {}; store.dirty = new Set(); store.moves = {}; store.returnsMap = {}; store.customers = {}; store.events = {}; store.imgs = {}; store.logo = ''; store._d = null; store.sbOfflineQueue = []; };
fresh();
let insp = B.inspectBackup(json.data, json);
check('restore preview: what would be added, nothing changed yet', insp.ok && insp.summary.newBills === 1 && insp.summary.newEvents === 2 - 1 && insp.summary.newCustomers === 1 && !Object.keys(store.customers).length, insp.summary);
store.restoreCheck = insp; storage.fail('rc_returns');
check('restore fails half-way (device storage full): everything goes back as it was', (await B.applyRestore()) === false && !Object.keys(store.customers).length && !store.catalog.products.length && !Object.keys(store.localDays).length && !Object.keys(store.events).length);
storage.heal(); store.restoreCheck = B.inspectBackup(json.data, json);
check('restore succeeds: products, bills, customers, events are back, and queued for upload (never deletes cloud data)', (await B.applyRestore()) === true && store.catalog.products.length === 1 && Object.values(store.localDays)[0].sales.length === 1
  && store.customers.c1 && store.events[e.event.id] && store.sbOfflineQueue.some((q) => q.type === 'allsales') && !store.sbOfflineQueue.some((q) => /del/.test(q.type)));
check('restoring the same backup again adds nothing', B.inspectBackup(json.data, json).summary.newBills === 0);
check('a backup from another shop can go into an empty shop', (fresh(), B.inspectBackup(json.data, { ...json, shop: { owner: 'owner-2', name: 'Other' } }).ok));
check('restore and backup are logged on this device', (storage.get('hangtag_backup_log', []) || []).some((x) => x.type === 'restore' && x.outcome === 'restored') && storage.get('hangtag_backup_log', []).some((x) => x.outcome === 'failed'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
