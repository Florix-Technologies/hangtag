// Two owner devices of one shop catching up on each other (src/features/sync/services/catch-up.js), end to end in Chrome
// with the real app and supabase-js against PGlite running the real schema.sql (tests/helpers/app.mjs). Realtime is
// refused in the tests (tests/helpers/isolation.cjs), so nothing else brings B the other till's work — the gap a dropped
// socket, a lost connection or a sleeping laptop leaves on a real device:
//   1. B goes offline; A sells a bill, takes a return and stocks in; B comes back online and, with nothing called by the
//      test, shows the bills, the return and the stock within 20 s (before: "online" only uploaded);
//   2. A sells again while B stays online: the first realtime join doesn't fetch it (connecting isn't a gap); a join after
//      a drop does, within 20 s;
//   3. both at once: B sells and counts stock offline while A sells and takes a return; B comes back: its work goes up and
//      A's comes down within 20 s, then A catches up on B's — the same stock on both, each bill and the return once.
// Run: node tests/run.mjs tests/e2e/sync-catch-up.test.mjs
import { createReport } from '../helpers/report.mjs';
import { startShop, sleep } from '../helpers/app.mjs';
import { seedShop, sellBill } from '../helpers/shop-fixtures.mjs';

const R = createReport();
const UID = 'aaaaaaaa-0000-0000-0000-0000000000d5';
const S = await startShop({ report: R, uid: UID, email: 'catchup@example.com', shop: { shop_name: 'Aura Threads', gstin: '' } });
const js = (v) => JSON.stringify(v);
const count = async (table, where, params) => (await S.sql(`SELECT count(*)::int AS n FROM public.${table} WHERE owner_id = $1 AND ${where}`, [UID, ...params]))[0].n;

const A = await S.openDevice({ label: 'A' });
const ids = await seedShop(A, { products: [{ name: 'Kurta', price: 1000, cost: 600, stock: 50 }, { name: 'Tee', price: 500, cost: 250, stock: 50 }] });
await A.sync();
const B = await S.openDevice({ label: 'B' });
const kurta = ids.products.Kurta.variant, kurtaId = ids.products.Kurta.id;
R.check('two owner devices of one shop, both connected, B with the catalog and the same Kurta stock',
  await B.until(`sbStatus==="connected"&&!!D().vIdx[${js(kurta)}]`, 20000) && await B.run(`return stockOf(${js(kurta)})`) === await A.run(`return stockOf(${js(kurta)})`));

R.section('B offline while A sells, takes a return and stocks in');
await B.net.offline();
const s1 = await sellBill(A, ids, { lines: [['Kurta', 1]], pay: 'cash' });
const s2 = await sellBill(A, ids, { lines: [['Tee', 2]], pay: 'cash' });
await A.sync();
await A.run(`openReturn(${js(s2.id)});retState.q[0]=1;saveReturn()`); await sleep(300);
await A.run(`openStockOp("in",${js(kurtaId)});stockOp.val[${js(kurta)}]="5";saveStockOp()`); await sleep(300);
await A.until('sbOfflineQueue.length===0', 20000);
R.check('A\'s two bills, the return and the stock-in are on the server', await count('hangtag_sales', 'id = ANY($2)', [[s1.id, s2.id]]) === 2
  && await count('hangtag_returns', 'sale_id = $2', [s2.id]) === 1 && await count('hangtag_stock_moves', "type = 'RESTOCK' AND variant_id = $2", [kurta]) >= 1);
const want = { stock: await A.run(`return stockOf(${js(kurta)})`), tee: await A.run(`return stockOf(${js(ids.products.Tee.variant)})`) };
const has = (D) => D.run(`return { s1: D().sales.some(s=>s.id===${js(s1.id)}), s2: D().sales.some(s=>s.id===${js(s2.id)}),
  ret: Object.values(returnsMap).some(r=>r.sale===${js(s2.id)}), stock: stockOf(${js(kurta)}), tee: stockOf(${js(ids.products.Tee.variant)}) }`);
const offB = await has(B);
R.check('…B, offline, has none of it (and still counts itself connected: the gap a dropped connection leaves)',
  !offB.s1 && !offB.s2 && !offB.ret && offB.stock !== want.stock && await B.run('return sbStatus') === 'connected', { offB, want });

await B.net.online();
const t0 = Date.now();
const back = await B.until(`D().sales.some(s=>s.id===${js(s1.id)})&&D().sales.some(s=>s.id===${js(s2.id)})&&Object.values(returnsMap).some(r=>r.sale===${js(s2.id)})`
  + `&&stockOf(${js(kurta)})===${want.stock}&&stockOf(${js(ids.products.Tee.variant)})===${want.tee}`, 20000);
const onB = await has(B);
console.log(`B caught up ${((Date.now() - t0) / 1000).toFixed(1)} s after coming back online`);
R.check('B back online, nothing called by the test: within 20 s it shows A\'s two bills, the return and the stock (Kurta and Tee as on A)', back, { onB, want, secs: (Date.now() - t0) / 1000 });
R.check('…each bill once, the return once', await B.run(`return [D().sales.filter(s=>s.id===${js(s1.id)}).length, D().sales.filter(s=>s.id===${js(s2.id)}).length,`
  + ` Object.values(returnsMap).filter(r=>r.sale===${js(s2.id)}).length].join()`) === '1,1,1');

R.section('realtime: connecting is not a gap; joining again after a drop is');
const s3 = await sellBill(A, ids, { lines: [['Kurta', 1]], pay: 'cash' });
await A.sync();
await B.run('onRealtimeStatus("SUBSCRIBED")');   // the channel's first join
await sleep(3000);
R.check('the first join: no catch-up (the bill A just made isn\'t fetched by it)', !(await B.run(`return D().sales.some(s=>s.id===${js(s3.id)})`)));
await B.run('onRealtimeStatus("CHANNEL_ERROR")'); await B.run('onRealtimeStatus("SUBSCRIBED")');
R.check('…dropped, then joined again: within 20 s B has it', await B.until(`D().sales.some(s=>s.id===${js(s3.id)})&&stockOf(${js(kurta)})===${await A.run(`return stockOf(${js(kurta)})`)}`, 20000),
  await has(B));

R.section('both at once: B sells and counts stock offline while A sells and takes a return; B comes back');
const K0 = await A.run(`return stockOf(${js(kurta)})`);
const movesBefore = await count('hangtag_stock_moves', 'variant_id = $2', [kurta]);
await B.net.offline();
const sB = await sellBill(B, ids, { lines: [['Kurta', 1]], pay: 'cash' });
await B.run(`openStockOp("adjust",${js(kurtaId)});stockOp.val[${js(kurta)}]=String(stockOf(${js(kurta)})-2);saveStockOp()`); await sleep(300);
const s4 = await sellBill(A, ids, { lines: [['Kurta', 1]], pay: 'cash' });
await A.sync();
await A.run(`openReturn(${js(s4.id)});retState.q[0]=1;saveReturn()`); await sleep(300);
await A.until('sbOfflineQueue.length===0', 20000);
const waitingOnB = await B.queued();
const wantK = K0 - 1 - 2 - 1 + 1;   // B's bill, B's count (−2), A's bill, A's return
await B.net.online();
const t1 = Date.now();
const bothB = await B.until(`sbOfflineQueue.length===0&&D().sales.some(s=>s.id===${js(s4.id)})&&Object.values(returnsMap).some(r=>r.sale===${js(s4.id)})&&stockOf(${js(kurta)})===${wantK}`, 20000);
console.log(`B uploaded its own work and caught up ${((Date.now() - t1) / 1000).toFixed(1)} s after coming back online`);
R.check('B back online with its own bill and stock count waiting: within 20 s they are up and it shows A\'s bill and return; Kurta = before − 1 − 2 − 1 + 1 on B',
  bothB && waitingOnB >= 2, { waitingOnB, wantK, onB: await has(B), secs: (Date.now() - t1) / 1000 });
R.check('…on the server: B\'s bill once, A\'s bill once, the return once, B\'s count once', await count('hangtag_sales', 'id = $2', [sB.id]) === 1 && await count('hangtag_sales', 'id = $2', [s4.id]) === 1
  && await count('hangtag_returns', 'sale_id = $2', [s4.id]) === 1 && await count('hangtag_stock_moves', 'variant_id = $2', [kurta]) === movesBefore + 1);
await A.run('onRealtimeStatus("SUBSCRIBED")');   // A's channel joined (realtime is refused in the tests), then drops and joins again
await A.run('onRealtimeStatus("CHANNEL_ERROR")'); await A.run('onRealtimeStatus("SUBSCRIBED")');
R.check('…A, its realtime dropped and joined again, shows B\'s bill and count within 20 s: both devices the same Kurta stock',
  await A.until(`D().sales.some(s=>s.id===${js(sB.id)})&&stockOf(${js(kurta)})===${wantK}`, 20000), await has(A));
const once = (D) => D.run(`return [${js(sB.id)},${js(s4.id)}].map(id=>D().sales.filter(s=>s.id===id).length).concat(Object.values(returnsMap).filter(r=>r.sale===${js(s4.id)}).length).join()`);
R.check('…on both devices each bill once and the return once (nothing doubled, nothing lost)', await once(A) === '1,1,1' && await once(B) === '1,1,1', { A: await once(A), B: await once(B) });
R.check('…and nothing is left waiting or refused on either device', await A.queued() === 0 && await B.queued() === 0 && await A.review() === 0 && await B.review() === 0);

await R.done(() => S.close());
