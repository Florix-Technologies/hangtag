// The layout checks themselves (tests/helpers/responsive.mjs), on a page made to break each rule once — and to keep the
// things that look alike but are fine: two buttons drawn over each other, a button cut off by a box that hides overflow,
// the last button stuck under a bar fixed to the bottom; and a voice button set inside a search box, a link folded in a
// closed <details>, a chip scrolled out of its row under the button beside it, a page that leaves room above its tab bar.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { coveredAtEnd, layoutIssues } from '../helpers/responsive.mjs';

let fails = 0;
const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const BROKEN = `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;font:16px sans-serif">
  <main style="padding:16px 16px 0">
    <div style="position:relative;height:60px"><button id="a" style="position:absolute;left:0;top:0;width:120px;height:44px">Save</button><button id="b" style="position:absolute;left:60px;top:10px;width:120px;height:44px">Delete</button></div>
    <div style="overflow:hidden;width:150px;height:60px;border:1px solid"><button id="c" style="margin-left:100px;width:120px;height:44px">Cut off</button></div>
    <form style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;width:328px"><b style="font-size:14px">Stock in by barcode</b><input aria-label="Barcode" style="flex:1;min-width:0;padding:10px"><button style="height:44px;width:72px">Find</button><button style="height:44px;width:72px">Scan</button></form>
    <div style="display:grid;grid-template-columns:1fr"><section class="card" style="height:80px;margin-bottom:-40px">One</section><section class="card" style="height:80px;background:#ffd">Two</section></div>
    <div style="height:900px"></div><button id="last" style="height:44px">Last</button>
  </main>
  <nav style="position:fixed;left:0;right:0;bottom:0;height:64px;background:#eee"><button style="height:44px">Home</button></nav></body>`;
const FINE = `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;font:16px sans-serif">
  <main style="padding:16px 16px 96px">
    <div style="position:relative;width:300px"><input aria-label="Search" style="width:100%;height:44px;box-sizing:border-box"><button aria-label="Search by voice" style="position:absolute;right:2px;top:2px;width:40px;height:40px">🎤</button></div>
    <details><summary>More</summary><a href="#x">Open the cash book</a></details>
    <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;width:300px">
      <div style="overflow-x:auto;white-space:nowrap"><button style="height:44px">Ethnic</button><button style="height:44px">Casual</button><button style="height:44px">Accessories</button><button style="height:44px">Footwear</button></div>
      <button aria-label="Grid view" style="height:44px;width:44px">▦</button>
    </div>
    <div style="height:900px"></div><button style="height:44px">Last</button>
  </main>
  <nav style="position:fixed;left:0;right:0;bottom:0;height:64px;background:#eee"><button style="height:44px">Home</button></nav></body>`;

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 360, height: 740, isMobile: true, hasTouch: true });
await page.setContent(BROKEN);
let issues = await layoutIssues(page, { touch: true }), cov = await coveredAtEnd(page, { scope: 'main' });
check('two buttons drawn over each other: "overlap"', issues.some((x) => x.kind === 'overlap' && /Save/.test(x.el) && /Delete/.test(x.with)), issues);
check('two cards drawn over each other: "overlap"', issues.some((x) => x.kind === 'overlap' && /section.card/.test(x.el) && /section.card/.test(x.with)), issues);
check('a text field squeezed too narrow to type in: "narrow-field"', issues.some((x) => x.kind === 'narrow-field' && /Barcode/.test(x.el) && x.w < 80), issues);
check('a button cut off by a box that hides overflow: "clipped"', issues.some((x) => x.kind === 'clipped' && /Cut off/.test(x.el)), issues);
check('the last button stuck under the bar fixed to the bottom: "covered"', cov.some((x) => x.kind === 'covered' && /Last/.test(x.el)), cov);
await page.setContent(FINE);
issues = await layoutIssues(page, { touch: true }); cov = await coveredAtEnd(page, { scope: 'main' });
check('fine: a voice button inside a search box, a link folded in <details>, a chip scrolled under the button beside its row', !issues.some((x) => ['overlap', 'clipped', 'unnamed', 'narrow-field'].includes(x.kind)), issues);
check('fine: a page with room to scroll its last button above the bar', cov.length === 0, cov);
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
