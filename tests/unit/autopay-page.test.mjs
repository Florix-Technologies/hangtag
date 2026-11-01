// The app's AutoPay page script (autopay-checkout.js, loaded by autopay.html) in a stand-in browser: it opens Cashfree's
// subscription checkout only for a session this app on this device was just given (Plans & Billing stores it in
// localStorage right before opening the page) — so a link someone else made with their own Cashfree session can't use
// Hangtag's own page to ask an owner for a mandate. Where the browser keeps no storage at all, it can't be checked.
// Run: node tests/unit/autopay-page.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };
const SRC = fs.readFileSync(new URL('../../autopay-checkout.js', import.meta.url), 'utf8');
const KEY = 'hangtag.autopay.session', SESSION = 'sub_session_abcdefghij1234';

function open({ hash = `#cf=${SESSION}&env=sandbox`, stored, storage = true, cashfree = true, now = 1_800_000_000_000 } = {}) {
  const items = new Map(stored === undefined ? [] : [[KEY, JSON.stringify(stored)]]), opened = [], msg = { textContent: '' };
  const localStorage = storage ? { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)), removeItem: (k) => items.delete(k) }
    : { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => { throw new Error('SecurityError'); } };
  const ctx = { document: { getElementById: () => msg }, location: { hash }, localStorage, URLSearchParams, JSON, Date: class extends Date { static now() { return now; } } };
  ctx.window = ctx;
  if (cashfree) ctx.Cashfree = (opts) => ({ subscriptionsCheckout: (x) => { opened.push({ mode: opts.mode, ...x }); return undefined; } });
  vm.runInNewContext(SRC, ctx);
  return { opened, msg: msg.textContent, left: items.get(KEY) };
}

const fresh = { cf: SESSION, at: 1_800_000_000_000 - 60e3 };
const mine = open({ stored: fresh });
check('the session this app was given a minute ago: Cashfree\'s checkout opens for it (the environment named), and the stored session is used up',
  mine.opened.length === 1 && mine.opened[0].subsSessionId === SESSION && mine.opened[0].mode === 'sandbox' && mine.left === undefined, mine);
const foreign = open({});
const other = open({ stored: { cf: 'sub_session_someone_else_1', at: fresh.at } });
const stale = open({ stored: { cf: SESSION, at: 1_800_000_000_000 - 31 * 60e3 } });
check('a link this app didn\'t just open (nothing stored, another session stored, or one stored over 30 minutes ago): refused with a way back, Cashfree never asked',
  [foreign, other, stale].every((r) => r.opened.length === 0 && /didn't come from your Hangtag app/.test(r.msg)), { foreign: foreign.msg, other: other.opened, stale: stale.opened });
const noStorage = open({ storage: false });
check('a browser that keeps no storage at all: can\'t be checked, so the page still opens (it can\'t tell either way)', noStorage.opened.length === 1, noStorage);
const broken = open({ hash: '#cf=x&env=elsewhere', stored: fresh });
const noScript = open({ stored: fresh, cashfree: false });
check('an incomplete link: refused before anything; Cashfree\'s script missing: said so, and the stored session kept for a retry',
  broken.opened.length === 0 && /isn't complete/.test(broken.msg) && noScript.opened.length === 0 && /couldn't load/.test(noScript.msg) && !!noScript.left, { broken, noScript });

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
