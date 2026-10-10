// Clickjacking: the shop app and the Platform Console refuse to run inside another site's frame (on any host — a static
// file host sends no frame-ancestors header), while a page of their own may still frame them.
// Run: node tests/unit/frame-guard.test.mjs
import { readFileSync } from 'node:fs';
import { framedByAnotherSite, refuseFraming } from '../../src/app/frame-guard.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); };
const win = ({ framed, crossSite, sameOrigin = true }) => {
  const self = { location: { origin: 'https://app.hangtag.in', href: 'https://app.hangtag.in/#/sell' }, document: { body: { innerHTML: '<div id="app"></div>' } } };
  self.self = self;
  self.top = !framed ? self : crossSite ? { get location() { throw new Error('SecurityError'); } } : { location: { origin: sameOrigin ? 'https://app.hangtag.in' : 'https://evil.example' } };
  return self;
};
check('not framed: runs', framedByAnotherSite(win({ framed: false })) === false && refuseFraming(win({ framed: false })) === false);
check('framed by its own site (a page of the app): runs', framedByAnotherSite(win({ framed: true })) === false);
check('framed by another site (its address can\'t be read): refused', framedByAnotherSite(win({ framed: true, crossSite: true })) === true);
check('framed by another origin whose address reads differently: refused', framedByAnotherSite(win({ framed: true, sameOrigin: false })) === true);
const w = win({ framed: true, crossSite: true });
check('…the page then says why, and links to open Hangtag in its own tab (nothing of the app is left on it)', refuseFraming(w) === true
  && /can't open inside another website/.test(w.document.body.innerHTML) && /target="_blank" rel="noopener"/.test(w.document.body.innerHTML) && !/id="app"/.test(w.document.body.innerHTML));
check('no window (a worker or a test): nothing to guard', framedByAnotherSite(null) === false);
const main = readFileSync(new URL('../../src/app/main.js', import.meta.url), 'utf8'), con = readFileSync(new URL('../../src/app/platform-main.js', import.meta.url), 'utf8');
check('the shop app checks before anything boots; the console before it starts', main.indexOf('if(refuseFraming()) throw') > 0 && main.indexOf('if(refuseFraming()) throw') < main.indexOf('installContainer();')
  && /&& !refuseFraming\(\)\)\{/.test(con) && con.indexOf('!refuseFraming()') < con.indexOf('startConsole(surface'));
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
