// A download that keeps failing must not flood Diagnostics (src/features/sync/services/download-health.js,
// retry-backoff.js): one entry when it starts failing, none while it keeps failing (no generic "Catching up" or
// "Member refresh" warning on top), retries after 1, 2, 4, then every 5 minutes, one entry when it comes down again, and
// nothing more while healthy. Earlier entries survive. Run with the real catch-up (catch-up.js), the real team-phone poller
// (connection.js memberPoll), the real downloads (pull.js) and the real Diagnostics store; only the cloud and the clock
// are fakes. Realtime isn't involved: what real Supabase realtime does on a reconnect is not tested here.
// Run: node tests/unit/sync-diagnostics-noise.test.mjs
let clock = Date.parse('2026-10-16T04:00:00Z');
Date.now = () => clock;
const { override } = await import('../../src/shared/di/services.js');
const { store } = await import('../../src/shared/state/store.js');
const { installFakeDom, memStorage } = await import('../helpers/fake-env.mjs');
installFakeDom();
const storage = memStorage();

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info).slice(0, 700) : '')); };
const MIN = 60e3, eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- the cloud: products (and stock moves) that can be made to fail; every attempt is timed ----------
const err = () => Object.assign(new Error('Failed to fetch'), { code: 'NETWORK' });
const fail = { products: false, moves: false, touch: false };
const attempts = { products: [], moves: [], touch: [] };
let hold = null, active = 0, maxActive = 0;
const cloudProducts = [{ id: 'p1', name: 'Tee', price: 1, opts: [] }, { id: 'p2', name: 'Kurta', price: 2, opts: [] }];
const hasProduct = (id) => store.catalog.products.some((x) => x.id === id);
let marks = { catalog: 'c1', images: 'i1', moves: 'm1', returns: 'r1', customers: 'u1', events: 'e1', cash: 'k1', settings: 's1', sales: '0|t|0', sales_count: 0, sales_since: null, sales_voids: '0' };
const cloud = new Proxy({
  auth: { getSession: async () => ({ data: { session: { user: { id: store.authUser && store.authUser.id } } } }) },
  shopChanges: async () => ({ ...marks }),
  purchaseChanges: async () => 'p1',
  orderChanges: async () => ({ orders: 'o', held: 'h', credit: 'c', tables: 't' }),
  bizChanges: async () => ({ pl: 'x' }),
  fetchProducts: async () => {
    attempts.products.push(clock); active++; maxActive = Math.max(maxActive, active);
    try { if (hold) await hold; if (fail.products) throw err(); return cloudProducts.map((x) => ({ ...x, variants: [] })); }
    finally { active--; }
  },
  fetchVariants: async () => [],
  fetchMoves: async () => { attempts.moves.push(clock); if (fail.moves) throw err(); return []; },
}, { get: (o, k) => (k in o ? o[k] : async () => (k === 'fetchSettings' ? null : k === 'fetchLogo' ? '' : [])) });
const team = {
  touch: async () => { attempts.touch.push(clock); if (fail.touch) throw err(); return { shopId: 'shop-1', role: 'cashier', deviceId: 'dev-1' }; },
  members: async () => [{ userId: 'member-1', role: 'cashier', name: 'Asha' }],
  roles: async () => [],
};
override({ cloud, teamService: team });

const { recordDiagnostic, DIAGNOSTICS_KEY } = await import('../../src/shared/logging/diagnostics.js');
const { logger } = await import('../../src/shared/logging/logger.js');
const { pullFromSupabase, forgetShopChanges } = await import('../../src/features/sync/services/pull.js');
const { catchUp, catchUpConnected } = await import('../../src/features/sync/services/catch-up.js');
const { memberPoll, memberPollConnected, memberPollState } = await import('../../src/features/sync/services/connection.js');
const { resetDownloadHealthForTests } = await import('../../src/features/sync/services/download-health.js');

const entries = () => storage.get(DIAGNOSTICS_KEY, []);
const messages = () => entries().map((e) => e.message);
const count = (re) => messages().filter((m) => re.test(m)).length;
/* runs f now, without the app's console lines (its Diagnostics entries are what the checks read) */
const quiet = async (f) => { const w = console.warn, e = console.error, i = console.info; console.warn = console.error = console.info = () => {}; try { return await f(); } finally { console.warn = w; console.error = e; console.info = i; } };
const seedEarlier = () => { storage.set(DIAGNOSTICS_KEY, []); for (let i = 0; i < 20; i++) { clock += 1000; recordDiagnostic({ level: 'warn', source: 'app', kind: 'event', message: 'earlier incident ' + i }); } };
const gaps = (list) => list.slice(1).map((t, i) => (t - list[i]) / MIN);
const base = () => ({ dev: 'd1', sbClient: {}, sbStatus: 'connected', sbOfflineQueue: [], syncReview: [], returnsMap: {}, remoteDays: {}, localDays: {},
  moves: {}, customers: {}, events: {}, imgs: {}, biz: {}, catalog: { version: 3, products: [] }, settings: {}, prefs: {}, _d: null, dirty: new Set(), lastSyncAt: 0 });

// =============== an owner's device: the products' download fails for three hours ===============
await quiet(async () => {
  Object.assign(store, base(), { authUser: { id: 'owner-1' }, access: null });
  seedEarlier();
  check('connected: the full download gets through', await pullFromSupabase(false) === true && store.catalog.products.length === 2);
  catchUpConnected();
  const start = clock;
  cloudProducts.push({ id: 'p3', name: 'Shawl', price: 3, opts: [] });                        // another till added a product…
  marks = { ...marks, catalog: 'c2' }; fail.products = true; attempts.products.length = 0;   // …and this device can't download products
  logger.warn('Printer:', new Error('paper out'));                                            // an unrelated problem meanwhile
  for (let m = 1; m <= 180; m++) {
    clock = start + m * MIN;
    if (m === 30) { marks = { ...marks, moves: 'm2' }; fail.moves = true; }                  // stock moves fail too for a while…
    if (m === 50) fail.moves = false;                                                         // …then come down again
    await catchUp('poll');
  }
  const g = gaps(attempts.products);
  check('three hours of failures: the first look after the 5-minute mark, then retries after 1, 2, 4 and then every 5 minutes (never sooner)',
    attempts.products[0] - start === 5 * MIN && eq(g.slice(0, 5), [1, 2, 4, 5, 5]) && g.every((x) => x >= 1 && x <= 5) && g.slice(3).every((x) => x === 5) && attempts.products.length === 37,   // minutes 5, 6, 8, 12, then 17, 22 … 177: 4 + 33
    { first: (attempts.products[0] - start) / MIN, gaps: g.slice(0, 8), attempts: attempts.products.length });
  check('…every retry asks for the products again (a failed download never moves their marker); the new product isn\'t here yet', attempts.products.length === 37 && !hasProduct('p3'));
  check('…Diagnostics: one "download failed (catalog)" for the whole incident, no generic "Catching up" warning',
    count(/^download failed \(catalog\)/) === 1 && count(/Catching up/) === 0 && count(/Not downloaded/) === 0, messages().slice(-8));
  check('…another part failing meanwhile gets its own one entry, and one when it comes down again (with the part named)',
    count(/^download failed \(moves\)/) === 1 && count(/^download recovered \(moves\)/) === 1, messages().filter((m) => /moves/.test(m)));
  check('…the unrelated problem is still there, and so are all 20 earlier entries',
    // 24 = the 20 earlier + the printer + catalog failed + moves failed + moves recovered
    count(/paper out/) === 1 && count(/^earlier incident/) === 20 && entries().length === 24, { n: entries().length, last: messages().slice(-6) });

  // immediate signals during the 5-minute retry delay: they look at once, one at a time
  let release; hold = new Promise((r) => { release = r; }); maxActive = 0;
  const before = attempts.products.length;
  clock += 10e3;
  const a = catchUp('online'), b = catchUp('foreground', { hiddenFor: 0 }), c = catchUp('realtime');
  await new Promise((r) => setTimeout(r, 0));
  const during = attempts.products.length - before;
  release(); hold = null; await Promise.all([a, b, c]);
  check('back online during a retry delay: a check at once; foreground and realtime meanwhile share it and run one more after it — never two at once',
    during === 1 && attempts.products.length - before === 2 && maxActive === 1 && a === b && b === c, { during, total: attempts.products.length - before, maxActive });

  // recovery
  fail.products = false; clock += 10e3;
  const recovered = await catchUp('online');
  check('the products come down again: the missing product (added meanwhile) is here, and one "download recovered (catalog)"',
    recovered === true && hasProduct('p3') && count(/^download recovered \(catalog\)/) === 1 && count(/^download failed \(catalog\)/) === 1, messages().slice(-4));
  const n = entries().length, polls = attempts.products.length, healthyFrom = clock;
  marks = { ...marks, catalog: 'c3' };   // and the products change once more later: a healthy download
  for (let m = 1; m <= 30; m++) { clock = healthyFrom + m * MIN; await catchUp('poll'); }
  check('…healthy checks afterwards: the 5-minute cadence again, no further entry (no repeated recovery)',
    entries().length === n && count(/^download recovered \(catalog\)/) === 1 && attempts.products.length - polls === 1, { added: messages().slice(n), fetched: attempts.products.length - polls });
  fail.products = true; marks = { ...marks, catalog: 'c4' }; clock += 5 * MIN; await catchUp('poll');
  check('…a new incident later is noted again (once), with a fresh 1-minute retry',
    count(/^download failed \(catalog\)/) === 2, messages().slice(-3));
  fail.products = false; clock += MIN; await catchUp('poll');
});

// =============== a team member's phone: an hour of failures every 30 seconds, then its team check offline ===============
await quiet(async () => {
  resetDownloadHealthForTests(); forgetShopChanges();
  Object.assign(store, base(), { authUser: { id: 'member-1', user_metadata: {} }, access: { userId: 'member-1', shopId: 'shop-1', role: 'cashier', perms: [], overrides: {} } });
  seedEarlier();
  check('a team member\'s phone connected: the full download gets through', await pullFromSupabase(false) === true);
  memberPollConnected();
  const start = clock;
  cloudProducts.push({ id: 'p4', name: 'Stole', price: 4, opts: [] });
  marks = { ...marks, catalog: 'm-c2' }; fail.products = true; attempts.products.length = 0;
  for (let s = 1; s <= 120; s++) { clock = start + s * 30e3; await memberPoll('poll'); }   // the app's 30-second look, for an hour
  const g = gaps(attempts.products);
  check('an hour of failures on a phone that looks every 30 s: retries after 1, 2, 4, then every 5 minutes',
    attempts.products[0] - start === 30e3 && eq(g.slice(0, 5), [1, 2, 4, 5, 5]) && g.every((x) => x >= 1 && x <= 5) && attempts.products.length === 14,
    { gaps: g, attempts: attempts.products.length });
  check('…one "download failed (catalog)", no "Member refresh" warning, all 20 earlier entries kept',
    count(/^download failed \(catalog\)/) === 1 && count(/Member refresh/) === 0 && count(/^earlier incident/) === 20 && entries().length === 21, messages().slice(-5));
  const st = memberPollState();
  let release; hold = new Promise((r) => { release = r; }); maxActive = 0;
  const before = attempts.products.length;
  const a = memberPoll('online'), b = memberPoll('foreground'), c = memberPoll('poll');
  await new Promise((r) => setTimeout(r, 0));
  const during = attempts.products.length - before;
  release(); hold = null; await Promise.all([a, b, c]);
  check('back online during its retry delay: at once; back on screen meanwhile runs one more after it; never two at once',
    st.failures > 3 && during === 1 && attempts.products.length - before === 2 && maxActive === 1, { st, during, total: attempts.products.length - before, maxActive });
  const hadP4 = hasProduct('p4');
  fail.products = false; clock += 10e3; await memberPoll('online');
  check('…the products come down (the one added meanwhile is here): one "download recovered (catalog)", the retry clock reset',
    !hadP4 && hasProduct('p4') && count(/^download recovered \(catalog\)/) === 1 && memberPollState().failures === 0, { state: memberPollState(), last: messages().slice(-3) });

  // its team check can't get through (offline): one entry, no warning per retry, one when it gets through again
  fail.touch = true; attempts.touch.length = 0; const offFrom = clock, n = entries().length;
  for (let s = 1; s <= 60; s++) { clock = offFrom + s * 30e3; await memberPoll('poll'); }
  check('offline for 30 minutes: the team check retried after 1, 2, 4, 5… minutes, one "download failed (access)", nothing else',
    eq(gaps(attempts.touch).slice(0, 4), [1, 2, 4, 5]) && entries().length === n + 1 && count(/^download failed \(access\)/) === 1 && count(/Member refresh/) === 0, { gaps: gaps(attempts.touch), added: messages().slice(n) });
  fail.touch = false; clock += 10e3; await memberPoll('online'); for (let s = 1; s <= 10; s++) { clock += 30e3; await memberPoll('poll'); }
  check('…back online: one "download recovered (access)", then quiet', count(/^download recovered \(access\)/) === 1 && entries().length === n + 2, messages().slice(n));
});

// =============== the full download keeps its own words for what stopped it (the 2026-10-13 incident's diagnosis) ===============
await quiet(async () => {
  resetDownloadHealthForTests();
  Object.assign(store, base(), { authUser: { id: 'owner-1' }, access: null });
  storage.set(DIAGNOSTICS_KEY, []);
  const real = cloud.fetchSettings;
  override({ cloud: new Proxy(cloud, { get: (o, k) => (k === 'fetchSettings' ? async () => { throw Object.assign(new Error('more than one row (table:hangtag_meta)'), { code: 'PGRST116' }); } : o[k]) }) });
  for (let i = 0; i < 3; i++) { clock += 2 * MIN; await pullFromSupabase(false); }
  check('a full download stopped by a table: "Pull from Supabase failed … (table:hangtag_meta)" once, not on every try',
    count(/^Pull from Supabase failed.*table:hangtag_meta/) === 1 && entries().length === 1, messages());
  override({ cloud });
  clock += 2 * MIN; await pullFromSupabase(false);
  check('…and one "download recovered (shop)" when a whole download gets through again', count(/^download recovered \(shop\)/) === 1 && entries().length === 2, messages());
  void real;
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
