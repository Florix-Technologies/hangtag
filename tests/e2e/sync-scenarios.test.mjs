// Offline, reconnect, conflicts and duplicates, as scenarios (spec Phase 21, items 71–76): each one runs the real app on two
// tills of one shop (tests/helpers/app.mjs) against PGlite running the real schema.sql, and checks what the shop ends up
// with — on the server and on a third device that downloads everything (the devices converge).
//   · a sale made offline is kept, then uploaded by itself when the internet returns — exactly once
//   · a UPI payment taken offline is recorded, never shown as verified by the provider
//   · the server saved a bill but its answer was lost: sent again, still one bill (and one set of its lines)
//   · the server failing (503) or unreachable: kept and tried again, not sent to the sync review
//   · two tills offline at the same time: different bill numbers, both bills on the server once
//   · the same customer changed on both tills while offline (phone on one, email on the other): both changes kept
//   · a return made offline: uploaded once; the stock is back on every device
//   · a double tap on Pay: one bill
import { createReport } from '../helpers/report.mjs';
import { startShop } from '../helpers/app.mjs';
import { seedShop, sellBill } from '../helpers/shop-fixtures.mjs';

const R = createReport();
const UID = 'aaaaaaaa-0000-0000-0000-0000000000c3';
const S = await startShop({ report: R, uid: UID, email: 'synctest@example.com', shop: { shop_name: 'Aura Threads', gstin: '' } });
const js = (v) => JSON.stringify(v);
const count = async (table, where, params) => (await S.sql(`SELECT count(*)::int AS n FROM public.${table} WHERE owner_id = $1 AND ${where}`, [UID, ...params]))[0].n;
const sales = (id) => count('hangtag_sales', 'id = $2', [id]);

const A = await S.openDevice({ label: 'A' });
const ids = await seedShop(A, { products: [{ name: 'Kurta', price: 1000, cost: 600, stock: 50 }, { name: 'Tee', price: 500, cost: 250, stock: 50 }],
  customers: [{ name: 'Riya', phone: '98765 43210', email: 'riya@example.com' }] });
await sellBill(A, ids, { lines: [['Tee', 1]], pay: 'cash' });   // the main till's first bill (INV-000001): a second till gets its own series
await A.sync();
const B = await S.openDevice({ label: 'B' });
await B.run('await pullFromSupabase(false)');
const kurta = ids.products.Kurta.variant, riya = ids.customers.Riya;
R.check('two tills of one shop, both connected, the same catalog', await B.run(`return !!D().vIdx[${js(kurta)}]&&!!customers[${js(riya)}]`));

R.section('a sale made offline');
await A.net.offline();
const s1 = await sellBill(A, ids, { lines: [['Kurta', 1]], pay: 'cash' });
R.check('made offline: a bill with its number, waiting on the device, not on the server', !!(s1 && s1.no) && await A.queued() > 0 && await sales(s1.id) === 0, s1);
R.check('…the device says it is offline', /offline/i.test(await A.run('return syncSummary().txt')), await A.run('return syncSummary().txt'));
await A.net.online();
R.check('the internet returns: uploaded by itself, nothing left waiting', await A.until('sbOfflineQueue.length===0', 20000), await A.queued());
R.check('…exactly one copy on the server, with its line', await sales(s1.id) === 1 && await count('hangtag_sale_items', 'sale_id = $2', [s1.id]) === 1);

R.section('UPI taken offline is never "verified"');
await A.net.offline();
const s2 = await sellBill(A, ids, { lines: [['Tee', 1]], pay: { method: 'upi', ref: '512345678901', confirmed: true } });
R.check('recorded on the bill, marked as checked by hand — not verified by the provider', await A.run(`return isUnverified(D().saleById[${js(s2.id)}])`));
await A.net.online(); await A.until('sbOfflineQueue.length===0', 20000);
const pay = await S.sql(`SELECT method, amount, to_jsonb(p) ->> 'verification' AS v FROM public.hangtag_payments p WHERE owner_id = $1 AND sale_id = $2`, [UID, s2.id]);
R.check('…and so on the server', pay.length === 1 && pay[0].method === 'upi' && pay[0].v !== 'verified', pay);

R.section('the server saved, the answer was lost');
A.net.dropAfterSave((r) => /\/rpc\/hangtag_save_sales/.test(r.url()));
const s3 = await sellBill(A, ids, { lines: [['Kurta', 2]], pay: 'cash' });
await A.sync();
R.check('saved on the server, but the till never heard back: still waiting on the till', A.net.dropped >= 1 && await sales(s3.id) === 1 && await A.queued() > 0, { dropped: A.net.dropped, queued: await A.queued() });
await A.net.online(); await A.sync();
R.check('sent again: still one bill on the server, with its one line of 2', await A.queued() === 0 && await sales(s3.id) === 1
  && (await S.sql(`SELECT sum(quantity)::float AS q, count(*)::int AS n FROM public.hangtag_sale_items WHERE owner_id = $1 AND sale_id = $2`, [UID, s3.id]))[0].q === 2);

R.section('the server failing, or not reachable');
A.net.failing(503);
const s4 = await sellBill(A, ids, { lines: [['Tee', 1]], pay: 'cash' });
await A.sync();
R.check('503: kept on the till (tried again later), not sent to the sync review', await A.queued() > 0 && await A.review() === 0 && await sales(s4.id) === 0);
A.net.down();
await A.sync();
R.check('unreachable: the same', await A.queued() > 0 && await A.review() === 0);
await A.net.online(); await A.sync();
R.check('…uploaded once it answers', await A.queued() === 0 && await sales(s4.id) === 1);

R.section('two tills offline at the same time');
await A.net.offline(); await B.net.offline();
const a5 = await sellBill(A, ids, { lines: [['Kurta', 1]], pay: 'cash' }), b5 = await sellBill(B, ids, { lines: [['Kurta', 1]], pay: 'cash' });
R.check('different bill numbers (the second till has a series of its own)', a5.no !== b5.no && /^INV-B-\d+$/.test(b5.no), [a5.no, b5.no]);
await A.net.online(); await B.net.online();
await A.until('sbOfflineQueue.length===0', 20000); await B.until('sbOfflineQueue.length===0', 20000);
const nos = await S.sql(`SELECT bill_no, count(*)::int AS n FROM public.hangtag_sales WHERE owner_id = $1 AND bill_no IS NOT NULL GROUP BY bill_no HAVING count(*) > 1`, [UID]);
R.check('both on the server once; no bill number twice in the shop', await sales(a5.id) === 1 && await sales(b5.id) === 1 && nos.length === 0, nos);

R.section('the same customer changed on both tills while offline');
await A.net.offline(); await B.net.offline();
const ea = await A.run(`const c=customers[${js(riya)}];return saveCustomer({name:c.name,phone:"90000 11111",email:c.email||""},{id:c.id})`);
await new Promise((r) => setTimeout(r, 50));
const eb = await B.run(`const c=customers[${js(riya)}];return saveCustomer({name:c.name,phone:c.phone||"",email:"riya.new@example.com"},{id:c.id})`);
R.check('each till saved its own change', !(ea && ea.error) && !(eb && eb.error), [ea, eb]);
await A.net.online(); await A.until('sbOfflineQueue.length===0', 20000);
await B.net.online(); await B.until('sbOfflineQueue.length===0', 20000);
const cr = (await S.sql(`SELECT phone, email FROM public.hangtag_customers WHERE owner_id = $1 AND id = $2`, [UID, riya]))[0];
R.check('the server keeps BOTH changes: the new phone from one till and the new email from the other', String(cr.phone).replace(/\D/g, '').slice(-10) === '9000011111' && cr.email === 'riya.new@example.com', cr);
await A.run('await pullFromSupabase(false)'); await B.run('await pullFromSupabase(false)');
const seenA = await A.run(`const c=customers[${js(riya)}];return [String(c.phone).replace(/\\D/g,"").slice(-10),c.email]`), seenB = await B.run(`const c=customers[${js(riya)}];return [String(c.phone).replace(/\\D/g,"").slice(-10),c.email]`);
R.check('…and both tills show both after downloading', js(seenA) === js(['9000011111', 'riya.new@example.com']) && js(seenB) === js(seenA), [seenA, seenB]);

R.section('the same product changed on both tills while offline');
const kp = ids.products.Kurta.id;
await A.net.offline(); await B.net.offline();
const pa = await A.run(`openEditor(${js(kp)});editor.price="1100";const r=saveProduct({draft:editor});closeModal();return r`);
await new Promise((r) => setTimeout(r, 50));
const pb = await B.run(`openEditor(${js(kp)});editor.desc="Hand-block printed cotton";const r=saveProduct({draft:editor});closeModal();return r`);
R.check('each till saved its own change to the product (in the product editor)', !!pa && !pa.error && !!pb && !pb.error, [pa, pb]);
R.check('…each queued as what it changed', js(await A.run(`return sbOfflineQueue.filter(q=>q.type==="prod").map(q=>q.fields)`)) === js([['price']])
  && js(await B.run(`return sbOfflineQueue.filter(q=>q.type==="prod").map(q=>q.fields)`)) === js([['desc']]));
await A.net.online(); await A.until('sbOfflineQueue.length===0', 20000);
await B.net.online(); await B.until('sbOfflineQueue.length===0', 20000);
const pr = (await S.sql(`SELECT price, description FROM public.hangtag_products WHERE owner_id = $1 AND id = $2`, [UID, kp]))[0];
R.check('the server keeps BOTH changes: the new price from one till and the description from the other', +pr.price === 1100 && pr.description === 'Hand-block printed cotton', pr);
await A.run('await pullFromSupabase(false)'); await B.run('await pullFromSupabase(false)');
const prodOn = (D) => D.run(`const p=products().find(x=>x.id===${js(kp)});return [p.price,p.desc,stockOf(${js(kurta)})]`);
const [pva, pvb] = [await prodOn(A), await prodOn(B)];
R.check('…both tills show both after downloading, and the stock is untouched by the edits', pva[0] === 1100 && pva[1] === 'Hand-block printed cotton' && js(pva) === js(pvb), [pva, pvb]);

R.section('a return made offline');
const s7 = await sellBill(A, ids, { lines: [['Kurta', 1]], pay: 'cash' });
await A.sync();
await A.net.offline();
await A.run(`openReturn(${js(s7.id)});retState.q[0]=1;renderReturnSheet()`); await new Promise((r) => setTimeout(r, 250));
await A.click('#sheetHost [data-act="rtsave"]', 400);
R.check('recorded offline, waiting to upload', await A.run(`return Object.values(returnsMap).some(r=>r.sale===${js(s7.id)})`) && await A.queued() > 0);
await A.net.online(); await A.until('sbOfflineQueue.length===0', 20000);
R.check('…uploaded once', await count('hangtag_returns', 'sale_id = $2', [s7.id]) === 1);

R.section('a double tap on Pay');
const before = await A.run('return D().sales.length');
await A.run(`await new Promise(r=>setTimeout(r,700));closeModal();closeSheets();setTab("sell");addOne(${js(kurta)});const a=checkout("cash"),b=checkout("cash");await a;await b;closeModal();closeSheets()`);
R.check('one bill, not two', (await A.run('return D().sales.length')) === before + 1);
await A.sync();

R.section('every device ends up with the same shop');
const C = await S.openDevice({ label: 'C' });
await C.run('await pullFromSupabase(false)'); await A.run('await pullFromSupabase(false)'); await B.run('await pullFromSupabase(false)');
const view = (D) => D.run(`return JSON.stringify({ bills: D().sales.map(s=>s.no).sort(), kurta: stockOf(${js(kurta)}), tee: stockOf(${js(ids.products.Tee.variant)}), returns: Object.keys(returnsMap).length })`);
const [va, vb, vc] = [await view(A), await view(B), await view(C)];
R.check('a new device downloads the same bills, stock and returns as both tills', va === vc && vb === vc, { A: va, B: vb, C: vc });
R.check('…the stock adds up: 50 − 7 sold (one of them the double tap\'s single bill) + 1 returned Kurtas = 44', JSON.parse(vc).kurta === 44, JSON.parse(vc));

await R.done(() => S.close());
