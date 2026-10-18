// An owner's device catching up on what realtime missed (src/features/sync/services/catch-up-core.js): when a check is due
// (the first connection isn't a gap; realtime joining again after a drop; back online; back on screen after a while; every
// 5 minutes), one check at a time with one more after it for what came meanwhile, its own work uploaded first (waited for
// 30 s at most), only a check that got everything counted (failed checks back off 1, 2, 4, then at most 5 minutes), a
// check that hangs not holding the next back, the whole download only for a database without the change check (at most
// every 5 minutes), and every timer and listener removed.
// Run: node tests/unit/sync-catch-up.test.mjs
import { createCatchUp, createRealtimeTracker, catchUpDue, FLUSH_WAIT_MS, POLL_MS, RESUME_MS, STUCK_MS, TICK_MS } from '../../src/features/sync/services/catch-up-core.js';
import { createRetryBackoff, retryDelay, RETRY_DELAYS_MS } from '../../src/features/sync/services/retry-backoff.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };
const tick = () => new Promise((r) => setTimeout(r, 0));

// --- the timer-free retry clock used by owner and member downloads
{
  let now = 1000;
  const retry = createRetryBackoff({ now: () => now });
  check('retry backoff: failures wait 1, 2, 4, then at most 5 minutes',
    JSON.stringify([1, 2, 3, 4, 5, 20].map(retryDelay)) === JSON.stringify([60e3, 120e3, 240e3, 300e3, 300e3, 300e3]) &&
    JSON.stringify(RETRY_DELAYS_MS) === JSON.stringify([60e3, 120e3, 240e3, 300e3]));
  retry.failed();
  check('…a routine poll waits for its retry boundary; an immediate signal bypasses it',
    !retry.canTry() && retry.canTry({ immediate: true }) && !retry.canTry({ at: now + 60e3 - 1 }) && retry.canTry({ at: now + 60e3 }));
  retry.succeeded();
  check('…success resets the failure count and retry clock', retry.canTry() && JSON.stringify(retry.state()) === '{"failures":0,"nextRetryAt":0}', retry.state());
}

// --- realtime: only a join after a drop
{
  const t = createRealtimeTracker(), seq = (list) => list.map((s) => t.status(s));
  check('realtime: the first join (connecting) is not a gap; joining again with no drop between isn\'t either',
    JSON.stringify(seq(['SUBSCRIBED', 'SUBSCRIBED'])) === '[false,false]');
  check('…a join after CHANNEL_ERROR, TIMED_OUT or CLOSED is a re-join, once each time',
    JSON.stringify(seq(['CHANNEL_ERROR', 'SUBSCRIBED', 'SUBSCRIBED', 'TIMED_OUT', 'CLOSED', 'SUBSCRIBED', 'CLOSED', 'SUBSCRIBED'])) === '[false,true,false,false,false,true,false,true]');
  const u = createRealtimeTracker();
  check('…a drop before the first join, then the join: the first join, not a re-join', JSON.stringify(['CHANNEL_ERROR', 'SUBSCRIBED'].map((s) => u.status(s))) === '[false,false]');
  t.status('CLOSED'); t.reset();
  check('…a new channel (reset) starts again: its first join is not a re-join', t.status('SUBSCRIBED') === false);
}

// --- when a check is due (the boundaries)
{
  const due = (reason, since, hiddenFor = 0) => catchUpDue({ reason, now: 1e9, lastCheckAt: 1e9 - since, hiddenFor });
  check('due: realtime joined again, or the network back: always, however recently the device looked (it missed what happened since)',
    due('realtime', 0) && due('online', 0) && due('online', 1));
  check('…back on screen: after 30 s away (or 5 minutes since the last check), not after a quick switch',
    !due('foreground', 1000, RESUME_MS - 1) && due('foreground', 1000, RESUME_MS) && due('foreground', POLL_MS, 0));
  check('…the 5-minute look: at 5 minutes, not a moment before; an unknown reason never',
    !due('poll', POLL_MS - 1) && due('poll', POLL_MS) && !due('other', POLL_MS * 10) && POLL_MS === 300000 && TICK_MS === 60000);
  const owed = (reason, since) => catchUpDue({ reason, now: 1e9, lastCheckAt: 1e9 - since, owed: true });
  check("…a check owed (the last one didn't get everything): the next look and the next time on screen, however soon",
    owed('poll', 1) && owed('foreground', 1) && STUCK_MS === 120000 && FLUSH_WAIT_MS === 30000);
}

// --- the scheduler, with a clock, a log and checks that can be held open
function rig(o = {}) {
  let now = o.start ?? 1_000_000;
  const log = [], holds = [], sleepers = [];
  const deps = {
    now: () => now,
    eligible: () => (o.eligible ? o.eligible() : true),
    busy: () => (o.busy ? o.busy() : false),
    flush: async () => { log.push('flush'); if (o.flushHangs) await new Promise(() => {}); },
    sleep: (ms) => new Promise((r) => sleepers.push({ ms, r })),
    check: async () => { log.push('check'); if (o.fail) throw o.fail; if (o.hold) await new Promise((r) => holds.push(r)); },
    fullPull: async () => { log.push('full'); return true; },
    isOutdated: (e) => !!(e && e.code === 'OUTDATED_DATABASE'),
    warn: (e) => { log.push('warn:' + (e && e.message)); },
  };
  return { C: createCatchUp(deps), log, o, sleepers, at: (t) => { now = t; }, add: (ms) => { now += ms; }, release: () => holds.splice(0).forEach((r) => r()), wake: () => sleepers.splice(0).forEach((x) => x.r()) };
}
{
  const r = rig(); r.C.connected();
  const first = [await r.C.realtimeStatus('SUBSCRIBED'), await r.C.catchUp('poll'), await r.C.catchUp('foreground', { hiddenFor: 1000 })];
  check('first connection: no catch-up — not the first realtime join, not a poll, not a quick look away and back', JSON.stringify(first) === '[false,false,false]' && r.log.length === 0, { first, log: r.log });
  r.add(1); const on = await r.C.catchUp('online');
  check('back online, even a moment after connecting: this device\'s work goes up first, then the change check', on === true && r.log.join() === 'flush,check', r.log);
  r.log.length = 0; await r.C.realtimeStatus('CHANNEL_ERROR'); const rj = await r.C.realtimeStatus('SUBSCRIBED');
  check('realtime joins again after a drop: one catch-up', rj === true && r.log.join() === 'flush,check', r.log);
  r.log.length = 0; r.add(POLL_MS - 1); const early = await r.C.catchUp('poll'); r.add(1); const onTime = await r.C.catchUp('poll');
  check('the 5-minute look counts from the last check: not a moment early, then once', early === false && onTime === true && r.log.join() === 'flush,check', r.log);
}
{
  const r = rig({ hold: true }); r.C.connected(); r.add(1);
  const a = r.C.catchUp('online'); await tick();
  r.C.catchUp('poll'); const s1 = r.C.state();
  const b = r.C.catchUp('online'); const s2 = r.C.state();
  check('single flight: one check in flight; a reason that comes during it shares it', r.log.join() === 'flush,check' && s1.inFlight && a === b, r.log);
  check('…during it a poll adds nothing; realtime, online or back-on-screen ask for one more', !s1.again && s2.again, { s1, s2 });
  r.release(); await tick(); await tick(); r.release(); await Promise.all([a, b]);
  check('…which runs once after it (what changed while it ran), and then no more', r.log.join() === 'flush,check,flush,check' && !r.C.state().inFlight, r.log);
}
{
  const r = rig({ eligible: () => false }); r.add(POLL_MS * 2);
  const ran = [await r.C.catchUp('online'), await r.C.realtimeStatus('SUBSCRIBED'), await r.C.catchUp('poll')];
  check('not this device (a team member\'s phone, signed out, not connected): nothing runs', JSON.stringify(ran) === '[false,false,false]' && r.log.length === 0, r.log);
  let busy = true; const b = rig({ busy: () => busy }); b.C.connected(); b.add(1);
  await b.C.catchUp('online');
  check('a full download under way: its work goes up, the check is left to the download without consuming a retry',
    b.log.join() === 'flush' && b.C.state().owed && b.C.state().failures === 0 && b.C.state().nextRetryAt === 0, { log: b.log, state: b.C.state() });
  busy = false; b.add(TICK_MS); await b.C.catchUp('poll');
  check("…but it isn't counted: owed, the next minute's look checks", b.log.join() === 'flush,flush,check' && !b.C.state().owed, b.log);
}
{
  const r = rig({ fail: Object.assign(new Error('no change check'), { code: 'OUTDATED_DATABASE' }) }); r.C.connected();
  r.add(1); await r.C.catchUp('online'); r.add(1); await r.C.catchUp('online');
  r.add(POLL_MS); await r.C.catchUp('online');
  check('a database without the change check: the whole download, at most every 5 minutes (none at once after connecting)', r.log.join() === 'flush,check,flush,check,flush,check,full', r.log);
  const w = rig({ fail: new Error('Failed to fetch') }); w.add(1); await w.C.catchUp('online');
  check('…any other failure is noted, owed, and never causes a full download',
    w.log.join() === 'flush,check,warn:Failed to fetch' && w.C.state().owed && w.C.state().lastCheckAt === 0, { log: w.log, state: w.C.state() });
  const observed = [w.C.state().nextRetryAt - 1_000_001];
  const blocked = [], ran = [];
  for(const delay of RETRY_DELAYS_MS){
    w.add(delay - 1); blocked.push(await w.C.catchUp('poll'));
    w.add(1); ran.push(await w.C.catchUp('poll'));
    observed.push(w.C.state().nextRetryAt - (1_000_001 + RETRY_DELAYS_MS.slice(0, observed.length).reduce((a, n) => a + n, 0)));
  }
  check('…routine retries follow 1, 2, 4, 5 minutes exactly, with later failures capped at 5 minutes',
    blocked.every((x) => x === false) && ran.every((x) => x === true) && JSON.stringify(observed) === JSON.stringify([60e3, 120e3, 240e3, 300e3, 300e3]),
    { blocked, ran, observed, state: w.C.state() });
  const beforeRecovery = w.C.state(); w.o.fail = null; w.add(1); const recovered = await w.C.catchUp('foreground');
  const okAt = w.C.state().lastCheckAt; w.add(TICK_MS); const after = await w.C.catchUp('poll');
  check('…foreground bypasses the delay; success resets it and the ordinary 5-minute cadence starts there',
    recovered === true && beforeRecovery.failures === 5 && !w.C.state().owed && w.C.state().failures === 0 && okAt > 0 && after === false,
    { recovered, beforeRecovery, after: w.C.state(), log: w.log });
  w.o.fail = new Error('again'); w.add(1); await w.C.catchUp('online');
  check('…after recovery, a new incident starts again at a one-minute delay',
    w.C.state().failures === 1 && w.C.state().nextRetryAt - (okAt + TICK_MS + 1) === TICK_MS, w.C.state());
}
{
  const results = [];
  for(const reason of ['online', 'realtime']){
    const r = rig({ fail: new Error('offline') }); r.add(1); await r.C.catchUp('online');
    r.o.fail = null; r.add(1); results.push({ reason, ran: await r.C.catchUp(reason), state: r.C.state(), log: r.log.slice() });
  }
  check('online and realtime signals also bypass an active retry delay and reset it on success',
    results.every((x) => x.ran === true && x.state.failures === 0 && !x.state.owed && x.log.filter((v) => v === 'check').length === 2), results);
}
{
  const r = rig({ hold: true }); r.C.connected(); r.add(1);
  r.C.catchUp('online'); await tick(); r.add(STUCK_MS - 1); const shared = r.C.catchUp('online');
  check('a check that hangs: under 2 minutes, a reason shares it', r.log.join() === 'flush,check' && r.C.state().again, r.log);
  r.add(1); r.C.catchUp('online'); await tick();
  check('…after 2 minutes it no longer holds the next back: noted, and another check runs', r.log.join() === 'flush,check,warn:A catch-up has been waiting 2 minutes; another starts.,flush,check', r.log);
  r.release(); await tick(); await tick(); r.release(); await tick(); await tick(); r.release(); await shared;
  check("…and when the hung one ends, the newer check isn't forgotten (one in flight at most, none left)", !r.C.state().inFlight, r.C.state());
  const f = rig({ flushHangs: true }); f.C.connected(); f.add(1);
  const p = f.C.catchUp('online'); await tick();
  const waited = f.log.join() === 'flush' && f.sleepers.length === 1 && f.sleepers[0].ms === FLUSH_WAIT_MS;
  f.wake(); await p;
  check('an upload that hangs: waited for 30 s at most, then the check (the downloads keep what is still going up)', waited && f.log.join() === 'flush,check', f.log);
}

// --- the page's events and the timer: catching up, and every one removed
function page() {
  const listeners = new Map(), timers = new Map(); let id = 0;
  const target = () => ({ addEventListener: (k, f) => listeners.set(k, f), removeEventListener: (k, f) => { if (listeners.get(k) === f) listeners.delete(k); } });
  const doc = Object.assign(target(), { visibilityState: 'visible' }), win = target();
  win.addEventListener = (k, f) => listeners.set('win:' + k, f); win.removeEventListener = (k, f) => { if (listeners.get('win:' + k) === f) listeners.delete('win:' + k); };
  return { doc, win, listeners, timers, api: { setInterval: (f, ms) => { timers.set(++id, { f, ms }); return id; }, clearInterval: (t) => timers.delete(t) },
    fire: (k, e) => listeners.get(k) && listeners.get(k)(e) };
}
{
  const r = rig(), p = page(); r.C.connected();
  let foregrounds = 0;
  const off = r.C.install({ win: p.win, doc: p.doc, timers: p.api, onForeground: () => { foregrounds++; } });
  check('installed: back-on-screen, freeze/resume, back/forward cache, and one timer every minute',
    ['visibilitychange', 'freeze', 'resume', 'win:pageshow'].every((k) => p.listeners.has(k)) && p.timers.size === 1 && [...p.timers.values()][0].ms === TICK_MS, [...p.listeners.keys()]);
  p.doc.visibilityState = 'hidden'; p.fire('visibilitychange'); r.add(RESUME_MS - 1); p.doc.visibilityState = 'visible'; p.fire('visibilitychange'); await tick();
  const quick = r.log.length;
  p.doc.visibilityState = 'hidden'; p.fire('visibilitychange'); r.add(RESUME_MS); p.doc.visibilityState = 'visible'; p.fire('visibilitychange'); await tick();
  check('a quick switch away and back: nothing; 30 s away: one catch-up', quick === 0 && r.log.join() === 'flush,check', r.log);
  r.log.length = 0; p.fire('freeze'); r.add(10 * 60e3); p.fire('resume'); await tick();
  check('…frozen, then resumed 10 minutes later: one catch-up', r.log.join() === 'flush,check', r.log);
  r.log.length = 0; r.add(1); p.fire('win:pageshow', { persisted: true }); await tick(); p.fire('win:pageshow', { persisted: false }); await tick();
  check('…restored from the back/forward cache: one catch-up (an ordinary page show: none)', r.log.join() === 'flush,check', r.log);
  check('…the shared foreground hook sees each return/resume and persisted restore, but not an ordinary page show', foregrounds === 4, foregrounds);
  r.log.length = 0; const T = [...p.timers.values()][0];
  T.f(); await tick(); const tooSoon = r.log.length; r.add(POLL_MS); p.doc.visibilityState = 'hidden'; T.f(); await tick(); const whileHidden = r.log.length;
  p.doc.visibilityState = 'visible'; T.f(); await tick();
  check('the timer: no look before 5 minutes, none while hidden (coming back covers it), one on screen after 5 minutes', tooSoon === 0 && whileHidden === 0 && r.log.join() === 'flush,check', r.log);
  off();
  check('removed: every listener and the timer', p.listeners.size === 0 && p.timers.size === 0, [...p.listeners.keys()]);
  r.log.length = 0; r.add(POLL_MS); p.fire('resume'); T.f && p.timers.size === 0; await tick();
  check('…and nothing runs after that from the page\'s events', r.log.length === 0, r.log);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
