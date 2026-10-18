// The app's lock against the answer the live database actually gives (features/billing/services/subscription.js with
// hangtag_subscription_status as the live project runs it: the 3t version — state, access_until, plan_code, the trial's
// dates, days_left, server_now, is_owner, suspended; no AutoPay or lifecycle fields). A trial that ended locks; when the
// owner's console extends it, the app opens again on its next question to the server — on reconnecting, coming back to the
// screen (after 30 s away), the network returning, "Check again", or an upload refused with HT402 — without a reload.
// Offline or when the server can't be asked, the saved answer stands; a database without plans never locks.
// Run: node tests/unit/subscription-refresh.test.mjs
import { provide } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { ERROR_CODES } from '../../src/shared/errors/app-error.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };
const DAY = 864e5, iso = (t) => new Date(t).toISOString();

// a stand-in window and document: the service listens for focus, online and visibilitychange
const listeners = {};
const on = (target) => (type, fn) => { (listeners[target + ':' + type] ||= []).push(fn); };
globalThis.window = { addEventListener: on('window') };
globalThis.document = { visibilityState: 'visible', addEventListener: on('document') };
const fire = async (key) => { for (const fn of listeners[key] || []) fn(); await new Promise((r) => setTimeout(r, 0)); };
let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine: online }) });
// the device's clock, moved by the test (the service measures "30 s away" and its 5 s guard with it)
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

const mem = new Map();
provide('storage', { get: (k, d) => (mem.has(k) ? JSON.parse(mem.get(k)) : d), set: (k, v) => { mem.set(k, JSON.stringify(v)); return true; }, getRaw: (k) => mem.get(k) ?? null, setRaw: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k) });
let answer = null, asked = 0;
provide('subscriptionService', { status: async () => { asked++; if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer() : answer; } });
store.authUser = { id: 'u1' }; store.sbClient = {};
const S = await import('../../src/features/billing/services/subscription.js');

// the live (3t) answer, field for field: a trial started 20 days ago, set to 15 days when the shop finished setting up
const START = realNow() - 20 * DAY;
const live = (state, ends) => ({ state, plan_code: null, plan_label: null, trial_days: 15, trial_started_at: iso(START), trial_ends_at: iso(ends), period_start: null,
  period_end: null, access_until: iso(ends), days_left: state === 'trial_active' ? Math.max(0, Math.ceil((ends - Date.now()) / DAY)) : 0, server_now: iso(Date.now()),
  is_owner: true, suspended: false, suspended_reason: null });
const changes = []; S.onSubscriptionChange((locked) => changes.push(locked));
const extended = START + 30 * DAY;   // the console's Extend: 30 days from its start
const ask = async (opts) => { const n = asked; const r = await S.refreshSubscription(opts); return { r, calls: asked - n }; };

console.log('=== the trial that ended, then the console extends it ===');
answer = live('trial_expired', START + 15 * DAY);
await ask({ force: true });
check('the live answer for an ended 15-day trial locks the app ("trial ended")', S.subscriptionLocked() && S.subscriptionState() === 'trial_expired' && changes.at(-1) === true, S.subscriptionStatus());
S.installSubscription({ onConnected: (fn) => { listeners['cloud:connected'] = [fn]; } });
answer = live('trial_active', extended);
skew += 10e3;
await fire('window:focus');
check('back on screen after 10 s: not asked again yet (still locked)', asked === 1 && S.subscriptionLocked());
skew += 31e3;
await fire('window:focus');
check('back on screen after more than 30 s: asked, and the extended trial opens the app without a reload', asked === 2 && !S.subscriptionLocked() && S.subscriptionState() === 'trial_active' && changes.at(-1) === false);
check('…its end is the console\'s (30 days from the start), from the server\'s own answer', Date.parse(S.subscriptionStatus().access_until) === extended && S.subscriptionStatus().trial_days === 15);

console.log('=== every way the app asks again ===');
for (const [what, act] of [
  ['the cloud reconnecting', () => listeners['cloud:connected'][0]()],
  ['the network coming back', () => fire('window:online')],
  ['"Check again" on the lock screen (forced)', () => S.refreshSubscription({ force: true })],
  ['an upload refused with HT402 (the server knows better)', () => S.noteSubscriptionRefused()],
]) {
  answer = live('trial_expired', START + 15 * DAY);
  const n = asked; await act(); await new Promise((r) => setTimeout(r, 0));
  const lockedNow = S.subscriptionLocked();
  answer = live('trial_active', extended);
  await act(); await new Promise((r) => setTimeout(r, 0));
  check(`${what}: asked each time; the answer locks and opens the app as the server says`, asked - n === 2 && lockedNow && !S.subscriptionLocked(), { calls: asked - n, lockedNow });
}
skew += 31e3; document.visibilityState = 'visible';
{ const n = asked; await fire('document:visibilitychange'); check('the page shown again after 30 s away: asked', asked - n === 1); }
{ const n = asked; await S.refreshSubscription(); await S.refreshSubscription(); check('two ordinary asks within 5 s: the server is asked once', asked - n <= 1); }

console.log('=== when the server can\'t be asked ===');
answer = live('trial_expired', START + 15 * DAY); await ask({ force: true });
online = false; answer = live('trial_active', extended);
{ const { r, calls } = await ask({ force: true }); check('offline: nothing is asked, the saved answer stands (still locked)', r === null && calls === 0 && S.subscriptionLocked()); }
online = true; answer = Object.assign(new Error('offline'), { code: ERROR_CODES.NETWORK });
{ const { r } = await ask({ force: true }); check('the call fails (network): the saved answer stands', r === null && S.subscriptionLocked()); }
answer = live('trial_active', extended); await ask({ force: true });
check('…and the next answer opens it', !S.subscriptionLocked());
answer = Object.assign(new Error('no such function'), { code: ERROR_CODES.OUTDATED_DATABASE });
await ask({ force: true });
check('a database without Plans & Billing never locks the app ("unavailable")', !S.subscriptionLocked() && S.subscriptionStatus().state === 'unavailable');

console.log('=== the server\'s clock, not the device\'s ===');
answer = live('trial_active', extended); await ask({ force: true });
skew += 400 * DAY;
check('the device clock moved 400 days on after the answer: the trial still runs in this session (server time + elapsed time)', !S.subscriptionLocked());
skew -= 800 * DAY;
check('…moved 400 days back: no time is gained either (still the server\'s time)', !S.subscriptionLocked() && S.subscriptionNow() >= Date.parse(S.subscriptionStatus().server_now));
skew += 400 * DAY;
const soon = () => ({ ...live('trial_active', realNow() + skew + 300), access_until: iso(realNow() + skew + 300), trial_ends_at: iso(realNow() + skew + 300) });
answer = soon; await ask({ force: true });
{ const n = asked, c = changes.length; answer = live('trial_expired', realNow() + skew); await new Promise((r) => setTimeout(r, 1600));
  check('a trial ending while the app is open locks at its end, and the server is asked again then', S.subscriptionLocked() && asked - n >= 1 && changes.length > c, { asked: asked - n }); }

Date.now = realNow;
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
