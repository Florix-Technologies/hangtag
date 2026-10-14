// The tests' network isolation (tests/helpers/isolation.cjs), Node side: a test process reaches this computer only. A fetch,
// an http request, a raw socket or a WebSocket to any other host — the live Supabase project above all — is refused before
// it connects, and each attempt is a violation (the process would exit with 1). This computer stays reachable. Also pinned:
// the browser's rules, what a browser address may reach, and that every test file starting a browser loads the settings
// that install them (and the runner installs them for every file it starts).
// Run: node tests/unit/test-isolation.test.mjs
import http from 'node:http';
import net from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import iso from '../helpers/isolation.cjs';
iso.install();

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIVE = /SUPABASE_URL:\s*"([^"]+)"/.exec(readFileSync(path.join(ROOT, 'config.js'), 'utf8'))[1];
const LIVE_HOST = new URL(LIVE).hostname;

const server = http.createServer((q, s) => s.end('pong'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const text = (u) => fetch(u).then((r) => r.text(), (e) => 'failed: ' + ((e.cause && e.cause.code) || e.message));
const local = await text(`http://127.0.0.1:${port}/`), byName = await text(`http://localhost:${port}/`);
check('control: this computer answers (127.0.0.1 and localhost)', local === 'pong' && byName === 'pong', { local, byName });

const r = {};
const got = await iso.expectViolations(async () => {
  r.fetch = await fetch(LIVE + '/rest/v1/').then(() => 'answered', (e) => (e.cause && e.cause.code) || e.message);
  r.http = await new Promise((res) => http.get('http://example.com/', () => res('answered')).on('error', (e) => res(e.code)));
  r.socket = await new Promise((res) => { const s = net.connect(443, LIVE_HOST); s.on('connect', () => res('connected')); s.on('error', (e) => res(e.code)); });
  r.websocket = await new Promise((res) => { const w = new WebSocket(LIVE.replace(/^https/, 'wss') + '/realtime/v1/websocket?vsn=1.0.0'); w.onopen = () => res('open'); w.onerror = () => res('error'); });
});
check('the live project by fetch and by a raw socket, and example.com by http: refused before connecting (ETESTISOLATION); a WebSocket fails too',
  r.fetch === 'ETESTISOLATION' && r.http === 'ETESTISOLATION' && r.socket === 'ETESTISOLATION' && r.websocket === 'error', r);
check('…each attempt is a violation of the Node side, naming the host and port, never a path or a query',
  got.length === 4 && got.every((v) => v.where === 'node') && got.filter((v) => v.what === `connection to ${LIVE_HOST}:443`).length === 3
  && got.some((v) => v.what === 'connection to example.com:80') && !/rest\/v1|realtime|vsn/.test(JSON.stringify(got)), got);

check('the browser\'s rules: no name resolves except this computer and the three static hosts; no proxy',
  JSON.stringify(iso.CHROME_ARGS) === JSON.stringify(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1], '
    + 'EXCLUDE cdn.jsdelivr.net, EXCLUDE fonts.googleapis.com, EXCLUDE fonts.gstatic.com', '--no-proxy-server']), iso.CHROME_ARGS);
const may = (u) => iso.allowed(u);
check('…a browser address may reach this computer, the static hosts and non-network addresses; never Supabase or a look-alike',
  may('http://localhost:3210/') && may('http://127.0.0.1:3219/x') && may('https://cdn.jsdelivr.net/npm/x') && may('data:text/plain,x') && may('blob:http://localhost/x')
  && !may(LIVE + '/rest/v1/') && !may(LIVE.replace(/^https/, 'wss') + '/realtime/v1/websocket') && !may('https://api.supabase.com/v1/projects')
  && !may('https://cdn.jsdelivr.net.example.com/') && !may('https://example.com/'));
let sentinel = null; try { iso.chromeArgs(LIVE_HOST); } catch (e) { sentinel = e.message; }
check('…the tripwire\'s own test name must be a reserved *.test name: a live host can\'t be mapped to this computer', /must be a \*\.test name/.test(sentinel || ''), sentinel);

// every file that starts a browser loads the settings that isolate it, and the runner isolates every file it starts
const files = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? files(p) : /\.(mjs|cjs|js)$/.test(f) ? [p] : []; });
const launching = files(path.join(ROOT, 'tests')).filter((f) => /puppeteer\.(launch|connect)\(/.test(readFileSync(f, 'utf8')) && !/[\\/]_/.test(f));
const loose = launching.filter((f) => !/helpers\/(env\.(mjs|cjs)|app\.mjs)|\.\/env\.mjs/.test(readFileSync(f, 'utf8').replace(/\\/g, '/')));
check(`every file that starts a browser (${launching.length}) loads the test settings (env.cjs / env.mjs / app.mjs), which install the isolation`,
  launching.length > 40 && loose.length === 0, loose.map((f) => path.relative(ROOT, f)));
check('…no test connects to a browser it didn\'t start', !launching.some((f) => /puppeteer\.connect\(/.test(readFileSync(f, 'utf8'))));
const runner = readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
check('…and the runner starts every file with the isolation (--import isolation-hook.mjs; Chrome\'s for browser files)',
  /'--import', ISOLATION, file/.test(runner) && /isolation-hook\.mjs/.test(runner) && /HANGTAG_TEST_BROWSER: usesBrowser\(file\)/.test(runner));

server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
