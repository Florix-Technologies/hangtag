// The browser tests' network isolation (tests/helpers/isolation.cjs), end to end in Chrome: no browser test can reach the
// live Supabase project — not by HTTP, not by WebSocket (which puppeteer's request interception never sees) — and the app
// runs against the stand-in on this computer. In order, stopping before any live address unless the earlier steps hold:
//   1. every browser starts with the rules (no host name resolves except this computer's and the three static hosts', no
//      proxy); a test can't set its own proxy or name resolution;
//   2. controls: this computer answers by HTTP and WebSocket (localhost, 127.0.0.1), and that is no violation; the tripwire
//      fires: a test-only name mapped to this computer (sentinel.isolation.test) that reaches a server is a violation, by
//      HTTP and by WebSocket;
//   3. a public host (example.com) is refused at name resolution, by HTTP and by WebSocket;
//   4. the live project (config.js's SUPABASE_URL): REST, Auth, Functions and Storage by HTTP, realtime by WebSocket — each
//      refused at name resolution, no answer, no handshake; an HTTP request to it that leaves a test is a violation;
//   5. the real app, signed in against the stand-in: connected, the stand-in answered it, its realtime socket to the live
//      project was refused at name resolution, and nothing reached the network.
// Run: node tests/run.mjs tests/e2e/network-isolation.test.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import iso from '../helpers/isolation.cjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const LIVE = /SUPABASE_URL:\s*"([^"]+)"/.exec(readFileSync(path.join(H.ROOT, 'config.js'), 'utf8'))[1].replace(/\/$/, '');
const LIVE_WS = LIVE.replace(/^https:/, 'wss:');
const RULES = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1], EXCLUDE cdn.jsdelivr.net, EXCLUDE fonts.googleapis.com, EXCLUDE fonts.gstatic.com';
const stop = (why) => { console.log('STOP before the live addresses: ' + why); console.log(`\n${fails || 1} FAILED`); process.exit(1); };

// this computer: an HTTP server that also accepts WebSockets, counting what reaches it
let hits = 0;
const server = http.createServer((q, s) => { hits++; s.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); s.end('pong'); });
server.on('upgrade', (q, sock) => {
  hits++;
  const accept = crypto.createHash('sha1').update(q.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.on('error', () => {});
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
/* from a page with no request interception: each address by fetch (no-cors: any answer counts) and by WebSocket */
const probe = (page, { http: hs = [], ws = [] }) => page.evaluate(async (hs, ws) => ({
  http: await Promise.all(hs.map((u) => fetch(u, { mode: 'no-cors', cache: 'no-store' }).then(() => 'answered', () => 'refused'))),
  ws: await Promise.all(ws.map((u) => new Promise((res) => { const s = new WebSocket(u); s.onopen = () => { s.close(); res('open'); }; s.onerror = () => res('refused'); setTimeout(() => res('no answer'), 8000); }))),
}), hs, ws);
const refusedCount = (u) => iso.state.refused.get(u) || 0;

// 1. the launch
const refusedLaunches = [];
for (const arg of ['--proxy-server=http://127.0.0.1:9', '--PROXY-SERVER=http://127.0.0.1:9', '/proxy-server=http://127.0.0.1:9', '-proxy-pac-url=http://127.0.0.1:9/p.pac', '--host-rules=MAP * 127.0.0.1']) {
  let msg = null; try { const b = await puppeteer.launch({ executablePath: H.CHROME, headless: true, args: [arg] }); await b.close(); } catch (e) { msg = e.message; }
  refusedLaunches.push(/^test isolation: a test may not set /.test(msg || ''));
}
check('1. a test can\'t set the browser\'s proxy or name resolution itself, in any spelling Chrome reads: each such launch is refused', refusedLaunches.every(Boolean), refusedLaunches);
const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const spawned = browser.process().spawnargs;
check('…every browser starts with the rules: no host name resolves except this computer\'s and the three static hosts\', and no proxy',
  spawned.includes(RULES) && spawned.includes('--no-proxy-server'), spawned.filter((a) => /resolver|proxy/.test(a)));
if (!spawned.includes(RULES)) stop('the browser has no name-resolution rule');
check('…and that is what the browser itself runs with (its own command line, so no wrapper dropped them), and a canary to a reserved name failed at name resolution (no proxy forced on it)',
  JSON.stringify(iso.state.lastCommandLine) === JSON.stringify([RULES, '--no-proxy-server']) && iso.state.canary === 'net::ERR_NAME_NOT_RESOLVED',
  { commandLine: iso.state.lastCommandLine, canary: iso.state.canary });
let ctxProxy = null, cdpProxy = null, connectCdp = null, connectBidi = null;
try { await browser.createBrowserContext({ proxyServer: 'http://127.0.0.1:9' }); } catch (e) { ctxProxy = e.message; }
const bs = await browser.target().createCDPSession();
try { await bs.send('Target.createBrowserContext', { proxyServer: 'http://127.0.0.1:9' }); } catch (e) { cdpProxy = e.message; }
await bs.detach();
check('…a browser context can\'t have its own proxy: through puppeteer or through the protocol itself',
  /a browser context may not have its own proxy/.test(ctxProxy || '') && /a browser context may not have its own proxy/.test(cdpProxy || ''), { ctxProxy, cdpProxy });
try { const c = await puppeteer.connect({ browserWSEndpoint: browser.wsEndpoint() }); await c.disconnect(); } catch (e) { connectCdp = e.message; }
try { const c = await puppeteer.connect({ browserWSEndpoint: browser.wsEndpoint(), protocol: 'webDriverBiDi' }); await c.disconnect(); } catch (e) { connectBidi = e.message; }
check('…and a test can only use a browser it started: puppeteer.connect is refused, by CDP and by WebDriver BiDi',
  /a test may only use a browser it started/.test(connectCdp || '') && /a test may only use a browser it started/.test(connectBidi || ''), { connectCdp, connectBidi });
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/`);

// 2. controls
const h0 = hits;
const ctlV = await iso.expectViolations(async () => {
  const r = await probe(page, { http: [`http://localhost:${port}/ping`, `http://127.0.0.1:${port}/ping`], ws: [`ws://localhost:${port}/`, `ws://127.0.0.1:${port}/`] });
  await sleep(300);
  check('2. control: this computer answers, by HTTP and by WebSocket (localhost and 127.0.0.1) — what a connection looks like', r.http.every((x) => x === 'answered')
    && r.ws.every((x) => x === 'open') && hits - h0 >= 4, { r, reached: hits - h0 });
});
check('…and that is no violation', ctlV.length === 0, ctlV);
const sb = await puppeteer.launch({ executablePath: H.CHROME, headless: true, isolationSentinel: 'sentinel.isolation.test' });
const sp = await sb.newPage();
await sp.goto(`http://localhost:${port}/`);
let sr = null;
const caught = await iso.expectViolations(async () => {
  sr = await probe(sp, { http: [`http://sentinel.isolation.test:${port}/ping`], ws: [`ws://sentinel.isolation.test:${port}/`] });
  await sleep(500);
});
await sb.close();
check('…the tripwire fires: a name that isn\'t this computer\'s reaching a server (a test-only name mapped here) is a violation, by HTTP and by WebSocket',
  sr.http[0] === 'answered' && sr.ws[0] === 'open' && caught.some((v) => v.what === `a response from http://sentinel.isolation.test:${port}/ping came from the network (sentinel.isolation.test:${port})`)
  && caught.some((v) => v.what === `a WebSocket opened to ws://sentinel.isolation.test:${port}/`), { sr, caught });

// 3. a public host, before any live address
let pr = null;
const pubV = await iso.expectViolations(async () => { pr = await probe(page, { http: ['https://example.com/'], ws: ['wss://example.com/'] }); await sleep(500); });
const pubOk = pr.http[0] === 'refused' && pr.ws[0] === 'refused' && refusedCount('https://example.com/') >= 1 && refusedCount('WebSocket wss://example.com/') >= 1;
check('3. a public host (example.com) is refused at name resolution, by HTTP and by WebSocket — no answer, no handshake, no violation', pubOk && pubV.length === 0,
  { pr, refused: [...iso.state.refused], pubV });
if (!pubOk) stop('a public host was not refused at name resolution');
// an address by its IP: 192.0.2.1 is reserved for documentation (RFC 5737) and routed nowhere
let ipr = null;
await iso.expectViolations(async () => { ipr = await probe(page, { http: ['http://192.0.2.1/'], ws: ['ws://192.0.2.1/'] }); await sleep(500); });
check('…and so is a host given by its IP address (no name to resolve): refused by the same rule, by HTTP and by WebSocket',
  ipr.http[0] === 'refused' && ipr.ws[0] === 'refused' && refusedCount('http://192.0.2.1/') >= 1 && refusedCount('WebSocket ws://192.0.2.1/') >= 1, { ipr, refused: [...iso.state.refused] });

// 4. the live project
const liveHttp = [LIVE + '/rest/v1/', LIVE + '/auth/v1/health', LIVE + '/functions/v1/subscription', LIVE + '/storage/v1/bucket'];
const before = liveHttp.map(refusedCount), wsBefore = refusedCount('WebSocket ' + LIVE_WS + '/realtime/v1/websocket');
let lr = null;
const liveV = await iso.expectViolations(async () => { lr = await probe(page, { http: liveHttp, ws: [LIVE_WS + '/realtime/v1/websocket?vsn=1.0.0'] }); await sleep(800); });
check('4. the live project by HTTP — REST, Auth, Functions, Storage — is refused at name resolution: no answer',
  lr.http.every((x) => x === 'refused') && liveHttp.every((u, i) => refusedCount(u) === before[i] + 1), { lr, refused: [...iso.state.refused] });
check('…and its realtime by WebSocket too: refused at name resolution, no handshake', lr.ws[0] === 'refused' && refusedCount('WebSocket ' + LIVE_WS + '/realtime/v1/websocket') === wsBefore + 1,
  { lr, refused: [...iso.state.refused] });
check('…an HTTP request to the live project that leaves a test is itself a violation (4 here); nothing came from the network',
  liveV.length === 4 && liveV.every((v) => /left the test \(refused at name resolution\)$/.test(v.what)) && !liveV.some((v) => /came from the network|WebSocket opened/.test(v.what)), liveV);

// 5. the real app, signed in against the stand-in
const UID = 'aaaaaaaa-0000-0000-0000-00000000f014', EMAIL = 'owner-isolation@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, business_type, onboarded_at)
  VALUES ($1, $2, 'Owner', 'Aura Threads', '9876543210', '12 MG Road', 'Pune', 'Maharashtra', 'retail', now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city,
    state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const A = await (await browser.createBrowserContext()).newPage();
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r))) r.abort(); return; }
  r.continue();
});
const answered0 = iso.state.answeredHere, rt0 = refusedCount('WebSocket ' + LIVE_WS + '/realtime/v1/websocket'), v0 = iso.state.violations.length;
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session(UID)));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
let connected = false;
for (let i = 0; i < 100 && !connected; i++) { connected = await A.evaluate(() => __ev('(async()=>sbStatus==="connected"&&!!authUser)()')).catch(() => false); if (!connected) await sleep(150); }
for (let i = 0; i < 60 && refusedCount('WebSocket ' + LIVE_WS + '/realtime/v1/websocket') === rt0; i++) await sleep(150);
check('5. the app, signed in against the stand-in on this computer, is connected — the stand-in answered its calls', connected && iso.state.answeredHere > answered0,
  { connected, answered: iso.state.answeredHere - answered0 });
check('…its realtime socket to the live project was refused at name resolution', refusedCount('WebSocket ' + LIVE_WS + '/realtime/v1/websocket') > rt0, [...iso.state.refused]);
check('…and nothing of it reached the network: no violation', iso.state.violations.length === v0, iso.state.violations.slice(v0));

await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
