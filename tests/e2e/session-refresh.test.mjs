// The sign-in session through a bad connection, end to end in Chrome with the real supabase-js (the version index.html pins):
// the session is about to expire when the app opens, so supabase-js refreshes it at once — and the first two refresh
// requests fail at the network (as a dropped Wi-Fi or a laptop waking does; the report of 2026-10-14 shows six such
// "connection failed (auth:token)"). supabase-js tries again by itself: the app stays signed in and connected, the two
// failures are noted (a technical event, nothing about the account), and the stored session is a fresh one. Then the
// refreshes give sessions of 100 s, which supabase-js's own 30 s tick refreshes while one is on the device (the control);
// signing out removes the session from the device, shows the sign-in screen, and a whole tick passes with no refresh.
// No token is printed by this test.
// Run: node tests/run.mjs tests/e2e/session-refresh.test.mjs
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-00000000c014', EMAIL = 'owner-refresh@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, business_type, onboarded_at)
  VALUES ($1, $2, 'Owner', 'Aura Threads', '9876543210', '12 MG Road', 'Pune', 'Maharashtra', 'retail', now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city,
    state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);

// a session that expires in 20 s: supabase-js refreshes it as soon as the app opens
const start = pg.session(UID);
start.expires_at = Math.floor(Date.now() / 1000) + 20; start.expires_in = 20;
let refreshCalls = 0, dropped = 0, short = false, afterSignOut = null;
const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
A.on('dialog', (d) => d.accept());
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/auth/v1/token') && r.method() === 'POST' && /grant_type=refresh_token/.test(u)) {
    refreshCalls++;
    if (afterSignOut !== null) afterSignOut++;
    if (dropped < 2) { dropped++; return r.abort('failed'); }   // the network drops the first two
    if (short) {   // a session of 100 s: supabase-js's tick (30 s, refresh at 3 ticks or less) refreshes it on its next tick
      const s = pg.session(UID, 'refresh'); s.expires_in = 100; s.expires_at = Math.floor(Date.now() / 1000) + 100;
      return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(s) });
    }
  }
  // Edge Functions answer as deployed ones without their provider keys do (payment-gateway: nothing set up)
  if (u.includes('.supabase.co/functions/v1/') && r.method() === 'POST') {
    const body = /payment-gateway/.test(u) ? { ok: true, provider: null, upi: false, cardLink: false } : { ok: true, available: false };
    return r.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  }
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r))) r.abort(); return; }
  r.continue();
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(start));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(150); } return false; }
async function waitFor(f, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(250); } return f(); }
/* only when the stored session expires (never the tokens) */
const storedExpiry = () => A.evaluate(() => { try { const s = JSON.parse(localStorage.getItem('hangtag-auth') || 'null'); return s && s.expires_at ? s.expires_at : null; } catch { return null; } });

check('the app opens signed in and connected although the first two refresh requests failed', await until('sbStatus==="connected"&&!!authUser'),
  { refreshCalls, dropped, state: await run('return { sbStatus, signedIn: !!authUser }').catch(() => null) });
check('…supabase-js tried again by itself until a refresh got through (the two dropped, then at least one more)', dropped === 2 && refreshCalls >= 3, { refreshCalls, dropped });
const exp = await storedExpiry();
check('…and the device keeps a fresh session (it expires about an hour from now, no longer in 20 s)', exp && exp > start.expires_at + 600, { was: start.expires_at, now: exp });
const ev = await run(`return getDiagnostics().map(e => ({ level: e.level, kind: e.kind, op: e.op || '', count: e.count || 1 }))`);
const drops = ev.filter((e) => e.kind === 'connection-failed' && e.op === 'auth:token');
check('…both dropped refreshes are noted as "connection failed (auth:token)" warnings (two in all), and no problem is',
  drops.length > 0 && drops.every((e) => e.level === 'warn') && drops.reduce((n, e) => n + e.count, 0) === 2 && !ev.some((e) => e.level === 'error'), ev);
const leaks = await run(`const s = JSON.stringify(getDiagnostics()); return { jwt: /eyJ/.test(s), refreshToken: /\\br1\\b/.test(s), tokenWords: /access_token|refresh_token/.test(s),
  email: s.includes(${JSON.stringify(EMAIL)}) }`);
check('…with nothing of the session in any field of any entry (no token, no email)', !Object.values(leaks).some(Boolean), leaks);

console.log('--- the control: refreshes now give sessions of 100 s, and supabase-js refreshes one on the device by itself ---');
short = true;
await run('await sbClient.auth.refreshSession()');
const kicked = refreshCalls;
check('control: signed in with a session of 100 s, supabase-js refreshes it by itself within a tick (30 s)', await waitFor(() => refreshCalls > kicked, 40000), { kicked, refreshCalls });

console.log('--- signing out ---');
await run('requestSignOut()');
check('signing out shows the sign-in screen and forgets the account on this page', await until('!authUser&&!document.getElementById("authGate").hidden'));
check('…the stored session is gone from the device', await A.evaluate(() => localStorage.getItem('hangtag-auth') === null));
afterSignOut = 0;
await sleep(36000);
check('…and no refresh is attempted after signing out, though a whole tick passed (one refreshed the session while it was on the device)', afterSignOut === 0, { afterSignOut });

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
