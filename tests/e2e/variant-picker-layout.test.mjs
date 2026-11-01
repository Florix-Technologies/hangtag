// The Sell screen's variant picker at every size, end to end in Chrome: products with 1, 6, 30 (ten colours' worth of
// long size names, as the owner's "Socks" showed: Newborn, Kids 5.5", …), 96 and 40 (sizes only) variants, on a wide
// desktop, a laptop, a tablet and a phone. For each: no sideways scroll anywhere (page, sheet, the variants), every
// variant's cell inside the sheet and wide enough to read its size, stock and price, as many sizes per line as fit,
// one scroll (the variants) between a header and a footer that stay in view. Then the picking itself: taps and typed
// quantities on different colours become separate bill lines with the right variant, quantity and price; more than is
// in stock is capped; a sold-out size can't be tapped; choosing a colour keeps the place in a long list; on a phone the
// colours are chips and only the chosen colour's sizes show.
// Run: node tests/e2e/variant-picker-layout.test.mjs
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';

if (!H.CHROME) { console.log('skipped: ' + H.NO_BROWSER); process.exit(77); }
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); };

const SOCK_SIZES = ['Newborn', 'Kids 5.5"', 'Kids 6.5"', 'Small', 'Medium', 'Large'];
const SOCK_COLOURS = ['Slate Grey', 'Lilac Grey', 'Mist Blue', 'Sea Green', 'Lemon Yellow'];
const WIDE_SIZES = Array.from({ length: 12 }, (_, i) => String(28 + 2 * i));
const WIDE_COLOURS = ['Black', 'White', 'Navy', 'Olive', 'Maroon', 'Sand', 'Grey', 'Rust'];
const MANY_SIZES = Array.from({ length: 40 }, (_, i) => 'R' + (i + 1));
// the catalog: built in the page with the app's own shapes (a product, its options and variants, opening stock records)
const SEED = `
  const mk=(id,name,price,colors,sizes,stockOf)=>{
    const opts=[...(colors.length?[{n:"Colour",v:colors}]:[]),...(sizes.length?[{n:"Size",v:sizes}]:[])], variants=[];
    (colors.length?colors:[""]).forEach((c,ci)=>(sizes.length?sizes:[""]).forEach((s,si)=>variants.push({id:id+":"+ci+"-"+si,o:[c,s].filter(Boolean),sku:"",bc:"",
      price:si>=3?price+250:null,cost:null,active:true,q:stockOf(ci,si)})));
    return {id,name,cat:"Test",brand:"",desc:"",price,cost:Math.round(price/2),color:"#5b6cff",archived:false,hsn:"",gst:null,code:"",opts,variants};
  };
  const list=[mk("one","One Tote",399,[],[],()=>5),
    mk("six","Six Tee",599,["Black","White"],["S","M","L"],(c,s)=>c===1&&s===2?0:4+s),
    mk("socks","Socks",500,${JSON.stringify(SOCK_COLOURS)},${JSON.stringify(SOCK_SIZES)},(c,s)=>c===4&&s===0?0:10),
    mk("wide","Cargo Pants",1099,${JSON.stringify(WIDE_COLOURS)},${JSON.stringify(WIDE_SIZES)},(c,s)=>(c+s)%5),
    mk("rings","Ring",250,[],${JSON.stringify(MANY_SIZES)},(c,s)=>s%3+1)];
  const t=Date.now(), mv={};
  list.forEach(p=>p.variants.forEach(v=>{const q=v.q;delete v.q;if(q){const id="open:"+v.id;mv[id]={id,v:v.id,p:p.id,type:"OPENING",q,cost:null,note:"Test opening stock",t,dev:dev}}}));
  catalog={version:3,products:list};moves=mv;saveCatalog();saveMoves();cart=[];saveCart();setTab("sell");renderAll();`;

const VIEWS = [
  { name: 'wide desktop 1600×900', vp: { width: 1600, height: 900 }, matrix: true },
  { name: 'laptop 1280×720', vp: { width: 1280, height: 720 }, matrix: true },
  { name: 'tablet 768×1024', vp: { width: 768, height: 1024, isMobile: true, hasTouch: true }, matrix: true },
  { name: 'phone 375×740', vp: { width: 375, height: 740, isMobile: true, hasTouch: true }, matrix: false },
];
const PRODUCTS = [
  { id: 'one', n: 1, colours: 0, sizes: 0 },
  { id: 'six', n: 6, colours: 2, sizes: 3 },
  { id: 'socks', n: 30, colours: 5, sizes: 6 },
  { id: 'wide', n: 96, colours: 8, sizes: 12 },
  { id: 'rings', n: 40, colours: 0, sizes: 40 },
];

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function device(vp) {
  const ctx = await browser.createBrowserContext(), p = await ctx.newPage();
  await p.setViewport(vp);
  p.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
  await p.setRequestInterception(true);
  p.on('request', (r) => { const u = r.url(); if (u === H.BASE_URL + '/') r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }); else if (u.includes('supabase.co')) r.abort(); else r.continue(); });
  await p.goto(H.BASE_URL + '/', { waitUntil: 'domcontentloaded' }); await sleep(700);
  p.run = (b) => p.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
  await p.run('hideGate();hideSetup();' + SEED);
  return { p, ctx };
}
/* What the open picker looks like: overflow, the cells' boxes, the footer, the scroll */
const measure = (p) => p.evaluate(() => {
  // the variants' own scroll area (or, in a picker without one, the sheet itself)
  const sheet = document.querySelector('#sheetHost .sheet.picker'), body = sheet && (sheet.querySelector('.pk-body') || sheet), foot = sheet && sheet.querySelector('.sh-foot');
  if (!sheet || !body || !foot) return null;
  const br = body.getBoundingClientRect(), cells = [...sheet.querySelectorAll('.vc:not(.na)')].map((c) => {
    const r = c.getBoundingClientRect(), b = c.querySelector('.vc-tap b');
    return { l: r.left, r: r.right, t: Math.round(r.top + body.scrollTop), w: r.width, label: b ? b.textContent : '', font: b ? parseFloat(getComputedStyle(b).fontSize) : 0,
      left: (c.querySelector('.vc-tap small') || {}).textContent || '', price: (c.querySelector('.vp') || {}).textContent || '' };
  });
  // anything inside the sheet that scrolls sideways (or would): none may
  const sideways = [...sheet.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowX)).map((e) => e.className);
  const fr = foot.getBoundingClientRect(), add = document.getElementById('addPickBtn').getBoundingClientRect();
  return { pageOver: document.documentElement.scrollWidth > innerWidth + 1, sheetW: sheet.clientWidth, sheetOver: sheet.scrollWidth > sheet.clientWidth + 1,
    bodyOver: body.scrollWidth > body.clientWidth + 1, sideways, cells, outside: cells.filter((c) => c.l < br.left - 1 || c.r > br.right + 1).length,
    bodyScrolls: body.scrollHeight > body.clientHeight + 1, sheetScrolls: sheet.scrollHeight > sheet.clientHeight + 1,
    footInView: fr.top >= 0 && fr.bottom <= innerHeight + 1 && add.bottom <= innerHeight + 1, chips: !!sheet.querySelector('.vchips'), rows: sheet.querySelectorAll('.vmx-row').length,
    sheetRight: sheet.getBoundingClientRect().right, vw: innerWidth };
});

try {
  for (const view of VIEWS) {
    console.log(`=== ${view.name} ===`);
    const { p, ctx } = await device(view.vp);
    for (const prod of PRODUCTS) {
      // measured once the sheet has finished sliding up (.sheet's 0.2 s "up" animation moves it 14 px): mid-slide its footer
      // is still a few pixels below the screen
      await p.run(`closeSheets();openPicker(${JSON.stringify(prod.id)})`); await sleep(120);
      await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), { timeout: 3000 }).catch(() => {});
      const m = await measure(p);
      if (!m) { check(`${prod.n} variant${prod.n > 1 ? 's' : ''}: the picker opens`, false); continue; }
      const what = `${prod.n} variant${prod.n > 1 ? 's' : ''} (${prod.id})`;
      check(`${what}: nothing scrolls sideways — the page, the sheet, the variants, nothing inside them`, !m.pageOver && !m.sheetOver && !m.bodyOver && !m.sideways.length && m.sheetRight <= m.vw + 1,
        { pageOver: m.pageOver, sheetOver: m.sheetOver, bodyOver: m.bodyOver, sideways: m.sideways });
      const shown = prod.n === 1 ? 0 : view.matrix || !prod.colours ? prod.n - (prod.id === 'six' ? 1 : 0) - (prod.id === 'socks' ? 1 : 0) : prod.sizes;
      if (prod.n > 1) {
        // sold-out cells are cells too: count every cell shown (sold out included) against the expectation
        const all = await p.$$eval('#sheetHost .vc:not(.na)', (x) => x.length);
        const expected = view.matrix || !prod.colours ? prod.n : prod.sizes;
        check(`${what}: every variant has its cell (${expected}) — ${view.matrix || !prod.colours ? 'all colours at once' : 'the chosen colour\'s sizes, the colours as chips'}`,
          all === expected && (view.matrix && prod.colours ? m.rows === prod.colours && !m.chips : !prod.colours || m.chips), { all, expected, rows: m.rows, chips: m.chips, shown });
        check(`${what}: each cell inside the sheet, at least 88 px wide, its size in type of 16 px or more, with its stock and its price`,
          m.outside === 0 && m.cells.every((c) => c.w >= 88 && c.font >= 16 && c.label && /left|Sold out/.test(c.left) && /₹/.test(c.price)),
          { outside: m.outside, narrow: m.cells.filter((c) => c.w < 88 || c.font < 16 || !/₹/.test(c.price)).slice(0, 3) });
        // as many per line as fit: the first line holds every size when they fit the sheet, else fills its width
        const firstTop = Math.min(...m.cells.map((c) => c.t)), firstLine = m.cells.filter((c) => Math.abs(c.t - firstTop) < 4).length;
        const perLine = view.matrix || !prod.colours ? prod.sizes || prod.n : prod.sizes;
        const fitMin = Math.max(1, Math.floor((m.sheetW - (view.matrix && prod.colours && view.vp.width >= 900 ? 190 : 50)) / 120));
        check(`${what}: as many sizes on a line as fit (${firstLine} on the first)`, firstLine >= Math.min(perLine, fitMin), { firstLine, perLine, fitMin, sheetW: m.sheetW });
      }
      check(`${what}: one scroll, the variants'; the header and the footer (Add to bill) stay in view`, !m.sheetScrolls && m.footInView, { sheetScrolls: m.sheetScrolls, footInView: m.footInView, bodyScrolls: m.bodyScrolls });
      if (prod.id === 'socks' && view.vp.width >= 1280) {
        check(`${what}: on a wide screen all six sizes of a colour on one line, beside the colour's name`, (() => {
          const tops = m.cells.slice(0, 6).map((c) => c.t); return tops.every((t) => Math.abs(t - tops[0]) < 4);
        })(), m.cells.slice(0, 6).map((c) => c.t));
      }
      if (view.name.startsWith('laptop') || view.name.startsWith('phone')) await p.screenshot({ path: `${H.ARTIFACTS}/picker_${prod.id}_${view.vp.width}.png` });
    }
    if (view.vp.width === 1280) {
      // ----- picking on a laptop: taps and typed quantities on several colours become separate, correctly priced lines -----
      await p.run('closeSheets();openPicker("socks")'); await sleep(120);
      const id = (c, s) => `socks:${c}-${s}`;
      await p.click(`[data-cellplus="${id(0, 1)}"]`); await p.click(`[data-cellplus="${id(0, 1)}"]`);   // Slate Grey, Kids 5.5" ×2 (₹500)
      await p.click(`[data-cellplus="${id(2, 4)}"]`);                                                 // Mist Blue, Medium ×1 (₹750)
      await p.click(`[data-cellqty="${id(3, 5)}"]`, { count: 3 }); await p.keyboard.type('3'); await p.keyboard.press('Tab');   // Sea Green, Large ×3 typed
      await sleep(120);
      check('picking: the footer adds up the pieces and the money (6 pieces · ₹4,000)', /6 pieces · ₹4,000/.test(await p.$eval('#pickSum', (e) => e.textContent)), await p.$eval('#pickSum', (e) => e.textContent));
      // more than is in stock: capped at what is left, and the cashier told
      await p.click(`[data-cellqty="${id(1, 2)}"]`, { count: 3 }); await p.keyboard.type('25'); await p.keyboard.press('Tab'); await sleep(150);
      const capped = await p.run(`return pick.qty[${JSON.stringify(id(1, 2))}]`);
      const toastTxt = await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
      check('picking: 25 typed where 10 are left → 10, with "Only 10 left in stock."', capped === 10 && /Only 10 left in stock/.test(toastTxt), { capped, toastTxt });
      const soldOut = await p.$eval(`[data-cellplus="${id(4, 0)}"]`, (b) => b.disabled);
      check('picking: a sold-out size (Lemon Yellow, Newborn) can\'t be tapped', soldOut === true);
      await p.click('#addPickBtn'); await sleep(200);
      const lines = await p.run('return cart.map(l=>[l.v,l.q,l.price])');
      check('the bill: one line per variant, each with its own variant, quantity and price',
        JSON.stringify(lines) === JSON.stringify([[id(0, 1), 2, 500], [id(2, 4), 1, 750], [id(3, 5), 3, 750], [id(1, 2), 10, 500]]), lines);
      // a long list: choosing a colour far down keeps the place (the list doesn't jump back to the top)
      await p.run('cart=[];saveCart();closeSheets();openPicker("wide")'); await sleep(120);
      const scroller = () => document.querySelector('#sheetHost .pk-body') || document.querySelector('#sheetHost .sheet.picker');
      await p.evaluate((f) => { const b = eval(f)(); b.scrollTop = b.scrollHeight; }, `(${scroller})`); await sleep(60);
      const before = await p.evaluate((f) => eval(f)().scrollTop, `(${scroller})`);
      await p.click('#sheetHost .vmx-row:last-child .vmx-c'); await sleep(120);
      const after = await p.evaluate((f) => eval(f)().scrollTop, `(${scroller})`), act = await p.$eval('#sheetHost .vmx-row.act', (r) => r.dataset.row);
      check('96 variants: choosing the last colour makes it the active one and keeps the list where it was', before > 200 && Math.abs(after - before) < 4 && act === 'Rust', { before, after, act });
    }
    if (!view.matrix) {
      // ----- a phone: the colours are chips; a chip shows its colour's sizes; picks across two colours add up -----
      await p.run('cart=[];saveCart();closeSheets();openPicker("socks")'); await sleep(120);
      await p.click('#sheetHost [data-color="Sea Green"]'); await sleep(120);
      const ids = await p.$$eval('#sheetHost [data-cellplus]', (x) => x.map((b) => b.dataset.cellplus));
      check('phone: choosing the Sea Green chip shows its six sizes only', ids.length === 6 && ids.every((x) => x.startsWith('socks:3-')), ids);
      await p.click('#sheetHost [data-cellplus="socks:3-0"]');
      await p.click('#sheetHost [data-color="Mist Blue"]'); await sleep(120);
      await p.click('#sheetHost [data-cellplus="socks:2-5"]'); await sleep(100);
      const chipCount = await p.$eval('#sheetHost [data-color="Sea Green"] em', (e) => e.textContent).catch(() => null);
      await p.click('#addPickBtn'); await sleep(200);
      const lines = await p.run('return cart.map(l=>[l.v,l.q])');
      check('phone: a chip counts what was picked in its colour; both picks reach the bill', chipCount === '1' && JSON.stringify(lines) === JSON.stringify([['socks:3-0', 1], ['socks:2-5', 1]]), { chipCount, lines });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
