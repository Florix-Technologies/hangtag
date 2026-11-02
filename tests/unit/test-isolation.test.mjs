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
check('…no test may set the browser\'s name resolution or proxy, in any spelling Chrome reads (--, -, /, any case)',
  ['--proxy-server=http://127.0.0.1:8888', '--PROXY-SERVER=x', '/proxy-server=x', '-proxy-pac-url=x', '--proxy-auto-detect', '--proxy-bypass-list=*', '--host-rules=MAP * 1.2.3.4',
    '/Host-Resolver-Rules=MAP * 1.2.3.4', '--no-proxy-server', '--proxy'].every(iso.isForbiddenArg)
  && !['--lang=en', '--window-size=800,600', '--use-fake-ui-for-media-stream', '--proxyish', 'http://localhost:3210/'].some(iso.isForbiddenArg));
const [RULES, NOPROXY] = iso.CHROME_ARGS;
check('…what the browser itself runs with must hold the rules exactly once, no proxy and nothing else of the kind (a wrapper can\'t drop them)',
  iso.argsOk(['chrome.exe', '--headless=new', RULES, NOPROXY]) && !iso.argsOk(['chrome.exe', '--headless=new', NOPROXY]) && !iso.argsOk(['chrome.exe', RULES])
  && !iso.argsOk(['chrome.exe', RULES, NOPROXY, '--host-resolver-rules=MAP * 10.0.0.1']) && !iso.argsOk(['chrome.exe', RULES, NOPROXY, '/proxy-server=127.0.0.1:8888'])
  && !iso.argsOk(['chrome.exe', '--host-resolver-rules=MAP * ~NOTFOUND', NOPROXY]) && !iso.argsOk(null));
check('…and the canary to a reserved name must fail at name resolution: an answer, a proxy error or silence refuses the browser',
  iso.CANARY === 'http://isolation-canary.test/' && iso.canaryOk('net::ERR_NAME_NOT_RESOLVED')
  && !['answered 200', 'answered 502', 'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_CONNECTION_REFUSED', 'no answer'].some(iso.canaryOk));
let sentinel = null; try { iso.chromeArgs(LIVE_HOST); } catch (e) { sentinel = e.message; }
check('…the tripwire\'s own test name must be a reserved *.test name: a live host can\'t be mapped to this computer', /must be a \*\.test name/.test(sentinel || ''), sentinel);

// every file that starts a browser loads the settings that isolate it, and the runner isolates every file it starts
const files = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? files(p) : /\.(mjs|cjs|js)$/.test(f) ? [p] : []; });
const launching = files(path.join(ROOT, 'tests')).filter((f) => /puppeteer\.(launch|connect)\(/.test(readFileSync(f, 'utf8')) && !/[\\/]_/.test(f));
const loose = launching.filter((f) => !/helpers\/(env\.(mjs|cjs)|app\.mjs)|\.\/env\.mjs/.test(readFileSync(f, 'utf8').replace(/\\/g, '/')));
check(`every file that starts a browser (${launching.length}) loads the test settings (env.cjs / env.mjs / app.mjs), which install the isolation`,
  launching.length > 40 && loose.length === 0, loose.map((f) => path.relative(ROOT, f)));
check('…no test connects to a browser it didn\'t start (only the isolation test tries, to show it is refused)',
  !launching.filter((f) => !/[\\/]e2e[\\/]network-isolation\.test\.mjs$/.test(f)).some((f) => /puppeteer\.connect\(/.test(readFileSync(f, 'utf8'))));
const runner = readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
check('…and the runner starts every file with the isolation (--import isolation-hook.mjs; Chrome\'s for browser files), also in NODE_OPTIONS for the Node processes a test starts',
  /'--import', ISOLATION, file/.test(runner) && /isolation-hook\.mjs/.test(runner) && /HANGTAG_TEST_BROWSER: usesBrowser\(file\)/.test(runner)
  && /NODE_OPTIONS: \[process\.env\.NODE_OPTIONS, '--import=' \+ ISOLATION\]/.test(runner));
{
  // a Node process a test starts, with NODE_OPTIONS as the runner sets it: isolated too (example.com: harmless if it weren't)
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const hook = pathToFileURL(path.join(ROOT, 'tests', 'helpers', 'isolation-hook.mjs')).href;
  const code = "fetch('http://example.com/').then(() => console.log('answered'), (e) => console.log((e.cause && e.cause.code) || e.message)).finally(() => process.exit(0))";
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--import=' + hook } });
  check('…a Node process started by a test, with the runner\'s NODE_OPTIONS: refused before connecting too', /^ETESTISOLATION/m.test(r.stdout), { out: r.stdout.trim().slice(0, 200), err: r.stderr.trim().slice(0, 200) });
  // a file run on its own (no runner, no NODE_OPTIONS): the worker threads and Node processes it starts are isolated too
  const own = [
    `require(${JSON.stringify(path.join(ROOT, 'tests', 'helpers', 'isolation.cjs'))}).install();`,
    `const { Worker } = require('node:worker_threads');`,
    `const w = new Worker("fetch('http://example.com/').then(() => console.log('worker answered'), (e) => console.log('worker ' + ((e.cause && e.cause.code) || e.message)))", { eval: true });`,
    `w.on('exit', () => { const c = require('node:child_process').spawnSync(process.execPath, ['-e', "fetch('http://example.com/').then(() => console.log('child answered'), (e) => console.log('child ' + ((e.cause && e.cause.code) || e.message))).finally(() => process.exit(0))"], { encoding: 'utf8' }); console.log(c.stdout.trim()); process.exit(0); });`,
  ].join('\n');
  // this process's own worker from code (eval): its code runs before an --import would load, so the guard comes first in it
  const { Worker } = await import('node:worker_threads');
  const here = await new Promise((resolve) => {
    let out = '';
    const w = new Worker("fetch('http://example.com/').then(() => process.stdout.write('answered'), (e) => process.stdout.write((e.cause && e.cause.code) || e.message))", { eval: true, stdout: true });
    w.stdout.on('data', (b) => { out += b; });
    w.on('exit', () => resolve(out));
  });
  check('…a worker thread a test starts from code is refused too (the guard is the first line of its code)', /ETESTISOLATION/.test(here), here.slice(0, 200));
  const d = spawnSync(process.execPath, ['-e', own], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', HANGTAG_TEST_BROWSER: '' } });
  check('…and in a file run on its own, the worker threads and Node processes it starts are refused too', /^worker ETESTISOLATION$/m.test(d.stdout) && /^child ETESTISOLATION$/m.test(d.stdout),
    { out: d.stdout.trim().slice(0, 300), err: d.stderr.trim().slice(0, 300) });
}

server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
