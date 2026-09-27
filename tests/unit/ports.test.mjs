// Unit tests for the ports registry (shared/di), the render bus (shared/ui/render.js), state persistence through the
// "storage" port (shared/state/persistence.js) and the runtime config, in Node with fakes instead of the browser.
// Run: npm run test:unit
import { override, provide, resetPorts, use } from '../../src/shared/di/services.js';
import { renderAll, setTab } from '../../src/shared/ui/render.js';
import { persistLocal, saveCart, saveImgs, saveLastSync, storage } from '../../src/shared/state/persistence.js';
import { store } from '../../src/shared/state/store.js';
import { APP_ENV, HOME_URL, cloudConfigured, cloudWanted } from '../../src/shared/config/app-config.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
// A storage port over a Map, with the same JSON behaviour as infrastructure/storage/local-storage.js
function fakeStorage({ full = false } = {}) {
  const m = new Map();
  return { m,
    get(k, d) { try { return m.has(k) ? JSON.parse(m.get(k)) : d; } catch (e) { return d; } },
    set(k, v) { if (full) return false; m.set(k, JSON.stringify(v)); return true; },
    getRaw: (k) => (m.has(k) ? m.get(k) : null),
    setRaw: (k, v) => { if (full) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    remove: (k) => { m.delete(k); } };
}

// ---- ports registry ----
resetPorts();
const missing = throws(() => use('storage'));
check('use() of a port nobody provided throws, naming the port', missing && /"storage" port/.test(missing.message), missing && missing.message);
const s1 = fakeStorage();
check('provide() returns the implementation', provide('storage', s1) === s1);
check('use() returns what was provided', use('storage') === s1);
const s2 = fakeStorage();
const restore = override({ storage: s2, files: { saveFile: async () => true } });
check('override() swaps in fakes', use('storage') === s2 && typeof use('files').saveFile === 'function');
restore();
check('the function override() returns puts the previous ports back', use('storage') === s1 && !!throws(() => use('files')));

// ---- render bus ----
const noRenderer = throws(() => renderAll());
check('renderAll() without a renderer says the port is missing', noRenderer && /"renderer" port/.test(noRenderer.message));
const calls = [];
provide('renderer', { renderAll: () => calls.push('all'), setTab: (t) => calls.push('tab:' + t) });
renderAll(); setTab('stock');
check('renderAll() and setTab() reach the provided renderer', calls.join() === 'all,tab:stock', calls);

// ---- persistence through the "storage" port (same keys and JSON as before) ----
Object.assign(store, { cart: [{ v: 'p1:M', q: 2 }], disc: 50, cartCust: { id: 'c1', name: 'Asha' }, imgs: { p1: 'data:image/jpeg;base64,x' },
  localDays: { d1: { sales: [] } }, dirty: new Set(['d1']), warnedFull: false, lastSyncAt: 1700000000000 });
saveCart(); saveImgs(); saveLastSync(); persistLocal();
check('saveCart() writes rc_cart, rc_disc and rc_cartcust as JSON', s1.m.get('rc_cart') === '[{"v":"p1:M","q":2}]' && s1.m.get('rc_disc') === '50' && s1.m.get('rc_cartcust') === '{"id":"c1","name":"Asha"}', [...s1.m]);
check('saveImgs() and saveLastSync() keep their keys', s1.m.get('rc_imgs') === '{"p1":"data:image/jpeg;base64,x"}' && s1.m.get('hangtag_last_sync') === '1700000000000');
check('persistLocal() writes rc_local and the dirty set as a list', s1.m.get('rc_local') === '{"d1":{"sales":[]}}' && s1.m.get('rc_dirty') === '["d1"]' && store.warnedFull === false);
check('storage.get() reads JSON with a fallback', storage.get('rc_disc', 0) === 50 && storage.get('nothing', 'x') === 'x');
storage.setRaw('raw', '{"a":1}');
check('storage raw strings go through unchanged', storage.getRaw('raw') === '{"a":1}' && storage.getRaw('nope') === null);
storage.remove('raw');
check('storage.remove() removes the key', storage.getRaw('raw') === null);
// The port is looked up on every call: a fake provided later is used
const s3 = fakeStorage();
const back = override({ storage: s3 });
saveCart();
check('the state savers use the port provided at call time', s3.m.has('rc_cart') && s3.m.get('rc_disc') === '50');
back();

// Storage full: persistLocal() warns once, with the same message as before
const host = { innerHTML: '', querySelector: () => null };
globalThis.document = { querySelector: (sel) => (sel === '#toastHost' ? host : null) };
const backFull = override({ storage: fakeStorage({ full: true }) });
persistLocal(); persistLocal();
check('storage full: persistLocal() marks the warning as shown', store.warnedFull === true);
check('storage full: the raw setter throws, so callers can react', !!throws(() => storage.setRaw('k', 'v')));
await new Promise((r) => setTimeout(r, 80));
clearTimeout(store.toastT);
check('storage full: the toast says "Browser storage is full…" once', host.innerHTML.includes('Browser storage is full. Download a backup from Products now.'), host.innerHTML);
backFull();
delete globalThis.document;

// ---- runtime config (no window in Node) ----
check('config: no config.js means no cloud', cloudWanted === false && cloudConfigured === false && HOME_URL === '');
check('config: APP_ENV is one of production/development/test', ['production', 'development', 'test'].includes(APP_ENV), APP_ENV);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
