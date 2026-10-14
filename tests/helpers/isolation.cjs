// Network isolation for the tests: they reach this computer only — never the live Supabase project, nor any other host,
// except the three static hosts the app's pages load their pinned scripts and fonts from (cdn.jsdelivr.net with SRI,
// fonts.googleapis.com, fonts.gstatic.com), and those only from the browser. Installed for every file the runner starts
// (tests/run.mjs: --import tests/helpers/isolation-hook.mjs) and by env.cjs, which every browser test loads, so a file
// run on its own is isolated as well.
//
// Node: a socket to anything but this computer is refused before it connects (fetch, http, https, WebSocket clients and
//   database drivers all go through net.Socket#connect).
// Chrome, however a test loads puppeteer-core (the launch goes through ChromeLauncher): no host name resolves except
//   localhost, 127.0.0.1, [::1] and the static hosts (--host-resolver-rules "MAP * ~NOTFOUND, EXCLUDE …"; this covers
//   IP literals too), and no proxy is used (a proxy resolves names itself, past these rules). A launch without them is
//   refused. Puppeteer's request interception never sees WebSockets; this doesn't depend on it. Every browser target is
//   watched over CDP (tripwire): a response from the network or a WebSocket handshake from any other host is a violation,
//   and so is any request to a Supabase host that left the test's own handlers — except the app's realtime socket, which
//   the stand-in doesn't serve: refused at name resolution, counted, listed in the summary. A page that has to run the
//   real app without request interception (a service-worker test: interception would bypass the worker) is declared with
//   noBackend(page): its Supabase requests, refused at name resolution, are counted too; any contact is still a violation.
// A violation is printed at once and the process exits with 1 (also when the test itself calls process.exit(0)). Nothing
// is sent anywhere; addresses are printed without their query (no key, no token).
//
// What test configuration can't do (each refused, and tested in tests/unit/test-isolation.test.mjs and
// tests/e2e/network-isolation.test.mjs):
//   - set the browser's name resolution or proxy: --host-resolver-rules, --host-rules, --proxy-*, in any spelling Chrome
//     reads (--, - or /; any case);
//   - start the browser through a wrapper that drops the rules: what the browser itself runs with is checked
//     (Browser.getBrowserCommandLine), not what was passed;
//   - have a proxy forced on the browser (a machine policy can override --no-proxy-server): a canary request to a reserved
//     name must fail at name resolution; an answer or a proxy error refuses the launch;
//   - give a browser context its own proxy (createBrowserContext, or Target.createBrowserContext over the protocol);
//   - use a browser it didn't start (puppeteer.connect, by CDP or WebDriver BiDi);
//   - escape the Node guard through a child Node process or a worker thread (NODE_OPTIONS and the workers' execArgv carry
//     the hook, through the runner or when a file is run on its own);
//   - reach a host by its IP address: IP literals fall under the browser's rule too.
// Not prevented, because only code written to get around this file gets there: raw UDP (dgram) or DNS to a chosen
// server, Node's internal socket bindings, a child process with its environment scrubbed, a program other than Node or
// Chrome, WebRTC to an IP address, a hand-made DevTools connection, or changing this file's verdict in the process. A
// network response the tripwire sees from such a browser still fails the file.
'use strict';
const net = require('node:net');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const STATIC_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const RESOLVER_RULES = ['MAP * ~NOTFOUND', ...[...LOCAL_HOSTS, ...STATIC_HOSTS].map((h) => 'EXCLUDE ' + h)].join(', ');
const CHROME_ARGS = Object.freeze(['--host-resolver-rules=' + RESOLVER_RULES, '--no-proxy-server']);
// what a test may not set itself, in any spelling Chrome reads: the browser's name resolution and proxy belong to this file
const FORBIDDEN_ARG = /^(?:--?|\/)(?:host-resolver-rules|host-rules|proxy|proxy-[a-z0-9-]*|no-proxy-server)(?:=|$)/i;
const isForbiddenArg = (a) => FORBIDDEN_ARG.test(String(a));
/* the switches the browser actually runs with: these rules exactly once, no proxy, no other mapping */
function argsOk(argv, own = CHROME_ARGS) {
  if (!Array.isArray(argv)) return false;
  const rules = argv.filter((a) => /^(?:--?|\/)host-resolver-rules=/i.test(String(a)));
  return rules.length === 1 && rules[0] === own[0] && argv.includes('--no-proxy-server') && !argv.some((a) => isForbiddenArg(a) && !own.includes(a));
}
// a reserved name (.test never resolves anywhere): with these rules it fails at name resolution; through a proxy it would not
const CANARY = 'http://isolation-canary.test/';
const canaryOk = (result) => result === 'net::ERR_NAME_NOT_RESOLVED';
const launching = new AsyncLocalStorage();   // set while this file launches a browser: the only time a browser connection may be made
const NODE_LOCAL = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(\.\d{1,3}){3}|0\.0\.0\.0|::)$/i;
const SUPABASE = /(^|\.)supabase\.(co|com|in)$/i;
const REALTIME = /^\/realtime\/v1\/websocket\/?$/;
const WATCHED = new Set(['page', 'background_page', 'service_worker', 'shared_worker', 'webview', 'iframe', 'other']);
const GUARD = Symbol.for('hangtag.test-isolation');

const state = { violations: [], refused: new Map(), answeredHere: 0, browsers: 0, targets: 0, quiet: false, reported: false };

/* an address as it may be printed: scheme, host and path, never the query (a key or a token) */
function show(u) { try { const x = new URL(u); return x.protocol + '//' + x.host + x.pathname; } catch { return String(u).split('?')[0].slice(0, 120); } }
function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch { return ''; } }
/* a browser address that needs no rule: not a network one, this computer, or a static host */
function allowed(u) {
  let x; try { x = new URL(u); } catch { return true; }
  if (!/^(https?|wss?):$/.test(x.protocol)) return true;
  const h = x.hostname.toLowerCase();
  return LOCAL_HOSTS.includes(h) || h === '::1' || STATIC_HOSTS.includes(h);
}

function violation(where, what) {
  state.violations.push({ where, what });
  if (!state.quiet) console.error(`ISOLATION VIOLATION (${where}): ${what}`);
}
const noBackendTargets = new WeakSet();
/* a page that runs the app with no backend at all (no request interception possible): see the header */
function noBackend(page) { noBackendTargets.add(page.target()); return page; }
function refused(u, kind, target) {
  const key = (kind === 'ws' ? 'WebSocket ' : '') + show(u);
  state.refused.set(key, (state.refused.get(key) || 0) + 1);
  let x; try { x = new URL(u); } catch { return; }
  // the stand-in answers or refuses every Supabase request a test makes; one that reached name resolution left the test
  if (SUPABASE.test(x.hostname) && !(kind === 'ws' && REALTIME.test(x.pathname)) && !noBackendTargets.has(target)) violation('browser', `a request to ${show(u)} left the test (refused at name resolution)`);
}
/* the violations recorded while fn ran (for the isolation tests themselves): not printed, not failing the process */
async function expectViolations(fn) {
  const before = state.violations.length, quiet = state.quiet;
  state.quiet = true;
  try { await fn(); } finally { state.quiet = quiet; }
  return state.violations.splice(before);
}

function summary() {
  if (state.reported || (!state.browsers && !state.violations.length)) return;
  state.reported = true;
  const list = [...state.refused].map(([k, n]) => `${k} ×${n}`), refusedAll = [...state.refused.values()].reduce((a, n) => a + n, 0);
  console.log(`[isolation] browser targets watched: ${state.targets} · answered by the test: ${state.answeredHere} · refused at name resolution: ${refusedAll}`
    + `${list.length ? ' (' + list.slice(0, 6).join(', ') + (list.length > 6 ? `, +${list.length - 6} more` : '') + ')' : ''} · violations: ${state.violations.length}`);
}
function installExitGuard() {
  if (process.exit[GUARD]) return;
  const exit = process.exit;
  const guarded = function (code) { summary(); return exit.call(process, state.violations.length ? 1 : code); };
  guarded[GUARD] = true;
  process.exit = guarded;
  process.on('exit', () => { summary(); if (state.violations.length) process.exitCode = 1; });
}

/* net.Socket#connect(options[, cb]) | (port[, host][, cb]) | (path[, cb]), or the [options, cb] pair net.connect passes:
   the host it would connect to, or null for a pipe or socket path (this computer) */
function destination(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  if (a && typeof a === 'object') return a.path != null ? null : { host: a.host == null || a.host === '' ? 'localhost' : String(a.host), port: a.port };
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return { host: typeof args[1] === 'string' && args[1] ? args[1] : 'localhost', port: a };
  return null;
}
function installNodeGuard() {
  const proto = net.Socket.prototype;
  if (proto.connect[GUARD]) return;
  const connect = proto.connect;
  const guarded = function (...args) {
    const d = destination(args);
    if (d && !NODE_LOCAL.test(d.host)) {
      const where = d.host + (d.port != null ? ':' + d.port : '');
      violation('node', 'connection to ' + where);
      const err = Object.assign(new Error(`test isolation: no connection to ${where} (tests reach only this computer)`), { code: 'ETESTISOLATION' });
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return connect.apply(this, args);
  };
  guarded[GUARD] = true;
  proto.connect = guarded;
}

/* The browser's network rules; sentinel: a test-only name (*.test, reserved) mapped to this computer, for the tripwire's own test */
function chromeArgs(sentinel) {
  if (sentinel === undefined) return [...CHROME_ARGS];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/.test(sentinel)) throw new Error('test isolation: a sentinel must be a *.test name');
  return ['--host-resolver-rules=MAP ' + sentinel + ' 127.0.0.1, ' + RESOLVER_RULES, '--no-proxy-server'];
}
const watching = new WeakMap();   // target → its watch starting (once per target)
const watchers = new WeakMap();   // browser → watch(target)
async function watch(browser) {
  state.browsers++;
  const attach = (t) => { if (!watching.has(t)) watching.set(t, attachNow(t)); return watching.get(t); };
  watchers.set(browser, attach);
  browser.on('targetcreated', (t) => { attach(t); });
  await Promise.all(browser.targets().map(attach));
}
/* watch one browser target over its own CDP session (the test's own sessions and interception are untouched) */
async function attachNow(t) {
  if (!WATCHED.has(t.type())) return;
  let s; try { s = await t.createCDPSession(); await s.send('Network.enable'); } catch { return; }
  state.targets++;
  const urls = new Map(), sockets = new Map();
  s.on('Network.requestWillBeSent', (e) => { if (!allowed(e.request.url)) urls.set(e.requestId, e.request.url); });
  s.on('Network.responseReceived', (e) => {
    urls.delete(e.requestId);
    const u = e.response.url;
    if (allowed(u)) return;
    // a response the test's interception made has no remote address; one from the network has
    if (e.response.remoteIPAddress) violation('browser', `a response from ${show(u)} came from the network (${hostOf(u)})`);
    else state.answeredHere++;
  });
  s.on('Network.loadingFailed', (e) => {
    const u = urls.get(e.requestId); urls.delete(e.requestId);
    if (u && /ERR_NAME_NOT_RESOLVED/.test(e.errorText || '')) refused(u, 'http', t);
  });
  s.on('Network.webSocketCreated', (e) => { if (!allowed(e.url)) sockets.set(e.requestId, e.url); });
  s.on('Network.webSocketHandshakeResponseReceived', (e) => { const u = sockets.get(e.requestId); if (u) violation('browser', `a WebSocket opened to ${show(u)}`); });
  s.on('Network.webSocketFrameError', (e) => { const u = sockets.get(e.requestId); if (u && /ERR_NAME_NOT_RESOLVED/.test(e.errorMessage || '')) refused(u, 'ws', t); });
}
/* what the browser itself runs with (a wrapper given as executablePath could drop arguments) */
async function commandLine(browser) {
  const s = await browser.target().createCDPSession();
  try { return (await s.send('Browser.getBrowserCommandLine')).arguments; } finally { await s.detach().catch(() => {}); }
}
/* the canary request's outcome, from a throwaway context: "net::ERR_NAME_NOT_RESOLVED", "answered <status>", another error */
async function canary(browser) {
  const ctx = await browser.createBrowserContext();
  try {
    const page = await ctx.newPage(), s = await page.createCDPSession();
    await s.send('Network.enable');
    const result = new Promise((resolve) => {
      s.on('Network.responseReceived', (e) => resolve('answered ' + e.response.status));
      s.on('Network.loadingFailed', (e) => resolve(e.errorText || 'failed'));
      setTimeout(() => resolve('no answer'), 10000);
    });
    await page.evaluate((u) => { fetch(u, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); }, CANARY);
    return await result;
  } finally { await ctx.close().catch(() => {}); }
}
const refuse = (what) => { throw new Error('test isolation: ' + what + ' (tests/helpers/isolation.cjs owns the browser\'s network)'); };
/* fn wrapped once (marked), in place of obj[name] */
function wrap(obj, name, make) { if (!obj || typeof obj[name] !== 'function' || obj[name][GUARD]) return; const w = make(obj[name]); w[GUARD] = true; obj[name] = w; }
function patchPuppeteer(pp) {
  const { ChromeLauncher, FirefoxLauncher, CdpBrowserContext, CdpBrowser, CdpCDPSession, Connection } = pp;
  if (!ChromeLauncher || ChromeLauncher.prototype.launch[GUARD]) return;
  // no browser connection but this file's launch: puppeteer.connect (by CDP or WebDriver BiDi) goes through the same transport
  try {
    const file = path.join(path.dirname(require.resolve('puppeteer-core')), 'node', 'NodeWebSocketTransport.js');
    wrap(require(file).NodeWebSocketTransport, 'create', (create) => function (...args) {
      if (!launching.getStore()) refuse('a test may only use a browser it started (puppeteer.connect is refused)');
      return create.apply(this, args);
    });
  } catch (e) { if (/test isolation/.test(e.message)) throw e; /* another puppeteer layout: the CdpBrowser check below still holds */ }
  if (CdpBrowser) wrap(CdpBrowser, '_create', (create) => function (...args) {
    if (!launching.getStore()) refuse('a test may only use a browser it started (puppeteer.connect is refused)');
    return create.apply(this, args);
  });
  // no browser context with its own proxy: through puppeteer, or through the protocol itself
  if (CdpBrowser) wrap(CdpBrowser.prototype, 'createBrowserContext', (create) => async function (options = {}) {
    if (options && (options.proxyServer || options.proxyBypassList)) refuse('a browser context may not have its own proxy');
    return create.call(this, options);
  });
  for (const C of [CdpCDPSession, Connection]) if (C) wrap(C.prototype, 'send', (send) => function (method, params, ...rest) {
    if (method === 'Target.createBrowserContext' && params && (params.proxyServer || params.proxyBypassList)) {
      return Promise.reject(new Error('test isolation: a browser context may not have its own proxy (tests/helpers/isolation.cjs owns the browser\'s network)'));
    }
    return send.call(this, method, params, ...rest);
  });
  // a new page is watched before the test gets it, so its first request is seen too
  if (CdpBrowserContext && !CdpBrowserContext.prototype.newPage[GUARD]) {
    const newPage = CdpBrowserContext.prototype.newPage;
    const watchedPage = async function (...args) {
      const page = await newPage.apply(this, args);
      const attach = watchers.get(this.browser());
      if (attach) await attach(page.target());
      return page;
    };
    watchedPage[GUARD] = true;
    CdpBrowserContext.prototype.newPage = watchedPage;
  }
  const launch = ChromeLauncher.prototype.launch;
  const guarded = async function (options = {}) {
    const { isolationSentinel, ...rest } = options;
    const own = chromeArgs(isolationSentinel);
    const bad = (rest.args || []).filter(isForbiddenArg);
    if (bad.length) refuse(`a test may not set ${bad.join(' ')}`);
    const browser = await launching.run(true, () => launch.call(this, { ...rest, args: [...(rest.args || []), ...own] }));
    let why = '';
    try {
      // the browser's own command line, then the canary: no wrapper dropped the rules, no proxy is forced on it
      const argv = await commandLine(browser).catch(() => null);
      state.lastCommandLine = Array.isArray(argv) ? argv.filter((a) => isForbiddenArg(a)) : null;
      if (!argsOk(argv, own)) why = 'the browser runs without its network rules (its own command line says so)';
      else {
        state.canary = await canary(browser);
        if (!canaryOk(state.canary)) why = `a proxy answers for this browser (canary: ${state.canary}) — a machine policy may force one`;
      }
    } catch (e) { why = 'the browser\'s network rules could not be checked: ' + e.message; }
    if (why) { await browser.close().catch(() => {}); refuse(why); }
    await watch(browser);
    return browser;
  };
  guarded[GUARD] = true;
  ChromeLauncher.prototype.launch = guarded;
  if (FirefoxLauncher) FirefoxLauncher.prototype.launch = async () => { throw new Error('test isolation: only Chrome is isolated for the tests'); };
}

const HOOK = require('node:url').pathToFileURL(path.join(__dirname, 'isolation-hook.mjs')).href;
/* the Node processes and worker threads this one starts load the same isolation (as the runner gives every file), also
   when a file is run on its own */
function installForDescendants() {
  const opts = process.env.NODE_OPTIONS || '';
  if (!opts.includes('isolation-hook.mjs')) process.env.NODE_OPTIONS = (opts + ' --import=' + HOOK).trim();
  const wt = require('node:worker_threads');
  if (wt.Worker[GUARD]) return;
  const Base = wt.Worker;
  // a worker from a file loads the hook first (--import); a worker from code (eval) runs its code before an --import has
  // loaded, so the guard is installed at the top of that code itself
  const first = `require(${JSON.stringify(__filename)}).install({ browser: process.env.HANGTAG_TEST_BROWSER === '1' });\n`;
  class IsolatedWorker extends Base {
    constructor(file, options = {}) {
      const execArgv = [...((options && options.execArgv) || process.execArgv)];
      if (!execArgv.some((a) => String(a).includes('isolation-hook.mjs'))) execArgv.push('--import=' + HOOK);
      const code = options && options.eval && typeof file === 'string' ? first + file : file;
      super(code, { ...options, execArgv });
    }
  }
  IsolatedWorker[GUARD] = true;
  wt.Worker = IsolatedWorker;
  require('node:module').syncBuiltinESMExports();   // `import { Worker } from 'node:worker_threads'` gets it too
}
/* browser: also isolate Chrome (loads puppeteer-core) */
function install({ browser = false } = {}) {
  installNodeGuard();
  installExitGuard();
  installForDescendants();
  if (browser) patchPuppeteer(require('puppeteer-core'));
  return module.exports;
}

module.exports = { install, chromeArgs, expectViolations, noBackend, allowed, show, state, isForbiddenArg, argsOk, canaryOk, CANARY,
  CHROME_ARGS, RESOLVER_RULES, STATIC_HOSTS, LOCAL_HOSTS };
