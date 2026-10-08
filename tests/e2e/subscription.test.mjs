// Plans & Billing and the access lock, end to end in Chrome. The database is PGlite running the real schema.sql behind a
// PostgREST stand-in (row security, the HT402 guard); the subscription Edge Function is stood in by a stub that uses the
// function's own request rules and payment decision (supabase/functions/subscription/core.js) and the same database
// functions: checkout AS the user, activation as the trusted server once "the provider" says paid.
// A new shop's trial (30 days, Home banner, Plans & Billing), the plans (Monthly to 12 Months) and the launch offer from the
// database, promo codes checked by the database,
// a tampered request, Pay Now → waiting → paid → the app unlocked; the plan ending → the lock screen (nothing else
// reachable: tabs, routes, shortcuts), data kept, writes refused and kept queued; tampering with the saved status or the
// clock doesn't unlock; renewing opens everything at once and the queue goes up; another device sees the same; a team
// member sees "ask the owner"; the screens at 320 / 375 / 768 / 1280 px. AutoPay: a new trial that needs it is locked until
// the owner consents (nothing today, the plan after the trial) and the provider confirms; turning it off keeps the trial.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
import { validateRequest, verifyDecision } from '../../supabase/functions/subscription/core.js';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000b1', EMAIL = 'ownerplans@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const sql = async (q, p = []) => (await pg.db.query(q, p)).rows;   // the SQL Editor (trusted)
await sql(`UPDATE public.hangtag_plans SET price = 599 WHERE code = 'm1'`);   // a price changed in the database: the app must show it
await sql(`INSERT INTO public.hangtag_promo_codes (code, kind, value, plans, ends_at) VALUES ('LAUNCH20', 'percent', 20, NULL, NULL), ('FLAT300', 'fixed', 300, NULL, NULL),
  ('OLD', 'percent', 10, NULL, now() - interval '1 day'), ('SIXONLY', 'percent', 50, '{m6}', NULL)`);

// the subscription function, stood in: the real request rules, the real database functions
let providerPaid = new Set(), payable = true, apApproved = false;
const stub = async (r) => {
  const body = JSON.parse(r.postData() || '{}'), who = pg.subOf(r.headers()['authorization']) || UID;
  const reply = (status, b) => r.respond({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) });
  const v = validateRequest(body);
  if (!v.ok) return reply(v.status, { ok: false, error: v.error, message: v.message });
  if (v.action === 'config') return reply(200, { ok: true, available: payable, provider: payable ? 'razorpay' : null, autopay: payable });
  try {
    if (v.action === 'checkout') {
      if (!payable) {   // as index.ts: the price first; with something to pay and no provider, nothing is created
        const q = (await pg.as(`SELECT public.hangtag_subscription_quote($1, $2) AS q`, [v.plan, v.promo], who)).rows[0].q;
        if (+q.amount > 0) return reply(503, { ok: false, error: 'not_configured', message: "Online payment isn't set up yet. Contact Hangtag support to renew." });
      }
      const c =(await pg.as(`SELECT public.hangtag_subscription_checkout($1, $2, 'razorpay') AS c`, [v.plan, v.promo], who)).rows[0].c;
      if (+c.amount === 0) { const a = (await sql(`SELECT public.hangtag_subscription_activate($1, $2, 0) AS a`, [c.payment_id, 'free:' + c.payment_id]))[0].a; if (a && a.ok === false) return reply(409, { ok: false, error: 'promo', reason: a.reason, message: a.message }); return reply(200, { ok: true, free: true, status: 'paid', payment_id: c.payment_id, period_end: a.period_end }); }
      await sql(`SELECT public.hangtag_subscription_attach($1, 'razorpay', $2)`, [c.payment_id, 'plink_' + c.payment_id.replace(/-/g, '').slice(0, 14)]);
      return reply(200, { ok: true, payment_id: c.payment_id, amount: +c.amount, pay_url: 'https://pay.example.test/' + c.payment_id, provider: 'razorpay' });
    }
    // AutoPay, as index.ts: the consent AS the owner, the mandate stored by the trusted server; only the provider turns it on
    if (v.action === 'autopay_start') {
      const t = (await pg.as(`SELECT public.hangtag_autopay_begin(true, $1) AS t`, [v.consentVersion], who)).rows[0].t, subId = 'sub_' + Date.now().toString(36);
      await sql(`SELECT public.hangtag_autopay_attach($1, 'razorpay', $2, NULL)`, [who, subId]);
      return reply(200, { ok: true, auth_url: 'https://pay.example.test/autopay/' + subId, first_charge_at: t.first_charge_at, today: +t.today, price: +t.price, currency: t.currency });
    }
    if (v.action === 'autopay_verify') {
      await pg.as(`SELECT public.hangtag_autopay_quote()`, [], who);   // the owner only
      const s = (await sql(`SELECT autopay_subscription_id FROM public.hangtag_subscriptions WHERE owner_id = $1`, [who]))[0];
      if (s && s.autopay_subscription_id && apApproved) await sql(`SELECT public.hangtag_autopay_event('razorpay', $1, 'authenticated')`, [s.autopay_subscription_id]);
      return reply(200, { ok: true, status: (await sql(`SELECT autopay_status FROM public.hangtag_subscriptions WHERE owner_id = $1`, [who]))[0].autopay_status });
    }
    if (v.action === 'autopay_cancel') {
      const c = (await pg.as(`SELECT public.hangtag_autopay_cancel_request() AS c`, [], who)).rows[0].c;
      if (c.subscription_id) await sql(`SELECT public.hangtag_autopay_event($1, $2, 'cancelled')`, [c.provider, c.subscription_id]);
      return reply(200, { ok: true, status: 'cancelled' });
    }
    const row = (await pg.as(`SELECT id, owner_id, amount, status, period_end FROM public.hangtag_subscription_payments WHERE id = $1`, [v.paymentId], who)).rows[0];
    if (!row) return reply(404, { ok: false, error: 'not_found', message: 'Unknown payment.' });
    const view = providerPaid.has(row.id) ? { state: 'paid', paid: Math.round(+row.amount * 100), paymentId: 'pay_' + row.id.slice(0, 8) } : { state: 'pending', paid: 0 };
    const d = verifyDecision(row, view);
    if (d.action === 'activate') { const a = (await sql(`SELECT public.hangtag_subscription_activate($1, $2, $3) AS a`, [row.id, d.ref, d.amount]))[0].a; return reply(200, { ok: true, status: 'paid', state: a.state, plan_code: a.plan_code, period_end: a.period_end }); }
    return reply(200, { ok: true, status: d.status === 'paid' ? 'paid' : d.status, period_end: row.period_end });
  } catch (e) { return reply(400, { ok: false, error: 'refused', message: String(e.message).slice(0, 160) }); }
};
const FUNCTIONS = { '/functions/v1/subscription': stub };

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function openDevice({ clockShift = 0, width = 1280 } = {}) {
  const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
  await page.setViewport({ width, height: 900 });
  page.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
  page.on('dialog', (d) => d.accept());
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    const u = r.url();
    if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
    if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, FUNCTIONS))) r.abort(); return; }
    if (u.startsWith('https://pay.example.test/')) return r.respond({ status: 200, contentType: 'text/html', body: '<title>Pay</title>The payment page' });
    r.continue();
  });
  await page.evaluateOnNewDocument((s, shift) => {
    if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s);
    if (shift) { const real = Date.now.bind(Date); Date.now = () => real() + shift; }
    // the payment page: a new tab is recorded (a real popup from a headless page is not needed to test the app)
    window.__opened = [];
    window.open = () => { const w = { closed: false, opener: {}, location: { href: '' }, close() { this.closed = true; } }; window.__opened.push(w); return w; };
  }, JSON.stringify(pg.session()), clockShift);
  await page.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
  return { ctx, page };
}
let { ctx: ctxA, page: A } = await openDevice();
const run = (b, P = A) => P.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000, P = A) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')', P).catch(() => false)) return true; await sleep(120); } return false; }
const text = (sel, P = A) => P.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const vis = (sel, P = A) => P.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
const locked = (P = A) => run('return !!document.getElementById("lockScreen")&&document.documentElement.dataset.locked==="1"', P);
const overflow = (P = A) => P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

check('signed in and connected', await until('sbStatus==="connected"'));
check('the plan was asked from the server: a running free trial', await until('subscriptionStatus()&&subscriptionStatus().state==="trial_active"'), await run('return subscriptionStatus()'));

console.log('--- a new shop: the trial ---');
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";editor.cost="600";edCombos()[0].cell.stock="40";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:""});closeModal();await flushSbQueue()`);
await run('setTab("home");renderAll()'); await sleep(300);
check('Home: "Free trial · 30 days left · ends <date>" with "Choose a plan"', /Free trial · 30 days left · ends /.test(await text('#homeBody .subban') || '') && await vis('#homeBody .subban [data-setgo="plans"]'), await text('#homeBody .subban'));
await A.click('#homeBody .subban [data-setgo="plans"]');
await until('!!document.querySelector("#plansBlk .subplan")');
const page1 = await text('#plansBlk');
check('Plans & Billing: "30 days remaining" and "Trial ends on <date>", the status chip', /30 days remaining/.test(page1 || '') && /Trial ends on \d{1,2} \w{3} \d{4}/.test(page1 || '') && /Free trial/.test(page1 || ''), page1);
const cards = await A.$$eval('#plansBlk .subplan', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
check('four plans with the database\'s prices (Monthly ₹599 after the change in the database), the launch offer on 3 Months', cards.length === 4 && /Monthly ₹599/.test(cards[0])
  && /3 Months ₹2,499 ₹999 Launch offer · 100 left/.test(cards[1]) && /6 Months ₹4,499/.test(cards[2]) && /12 Months ₹7,999/.test(cards[3]), cards);
check('the 3-month plan is chosen first; the launch offer applies by itself — the summary is the server\'s', /Plan price ₹2,499 Promo discount −₹1,500 Final amount ₹999/.test(await text('#plansBlk .subsum') || '')
  && /Launch offer applied\. 100 left\./.test(await text('#plansBlk .subck') || ''), await text('#plansBlk .subck'));
check('Pay Now shows the amount', /Pay ₹999/.test(await text('#plansBlk [data-sub-act="pay"]') || ''));

console.log('--- promo codes (checked by the database) ---');
const promo = async (code) => { await A.$eval('#subPromo-set', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, code); await A.click('#plansBlk [data-sub-act="apply"]'); await sleep(150); await until('!document.querySelector("#plansBlk [data-sub-act=apply]").disabled'); await sleep(150); };
await promo('launch20');
check('LAUNCH20 (20%) typed instead of the offer: applied, discount ₹499.80, final ₹1,999.20', /Promo code applied/.test(await text('#plansBlk .subpromo-msg') || '') && /Promo discount −₹499\.80 Final amount ₹1,999\.20/.test(await text('#plansBlk .subsum') || ''), [await text('#plansBlk .subpromo-msg'), await text('#plansBlk .subsum')]);
await promo('FLAT300');
check('FLAT300 (fixed): final ₹2,199', /Final amount ₹2,199/.test(await text('#plansBlk .subsum') || ''), await text('#plansBlk .subsum'));
await promo('NOSUCH');
check('an unknown code: "This promo code isn\'t valid." and no discount', /isn't valid/.test(await text('#plansBlk .subpromo-msg') || '') && /Promo discount ₹0 Final amount ₹2,499/.test(await text('#plansBlk .subsum') || ''), await text('#plansBlk .subpromo-msg'));
await promo('OLD');
check('an ended code: "This promo code has expired."', /has expired/.test(await text('#plansBlk .subpromo-msg') || ''));
await promo('SIXONLY');
check('a code for another plan: "isn\'t for the 3 Months plan."', /isn't for the 3 Months plan/.test(await text('#plansBlk .subpromo-msg') || ''));
await A.click('#plansBlk input[name="subPlan"][value="m6"]'); await sleep(200); await until('!document.querySelector("#plansBlk .subsum")||!/Working/.test(document.querySelector("#plansBlk .subck").innerText)');
await sleep(300);
check('…choosing the 6-month plan, the same code applies: 50% → ₹2,249.50', /Final amount ₹2,249\.50/.test(await text('#plansBlk .subsum') || ''), await text('#plansBlk .subsum'));

console.log('--- the browser cannot set the price ---');
const tampered = await run(`try{ const r = await use("cloud").subscriptionCall({action:"checkout", plan:"m1", promo:"", amount:1, discount:598, price:1}); return r; }catch(e){ return {err:e.message}; }`);
const trow = (await sql(`SELECT price, discount, amount, status FROM public.hangtag_subscription_payments WHERE id = $1`, [tampered && tampered.payment_id]))[0];
check('a checkout sent with amount 1 and a discount: the payment is the database\'s ₹599 (nothing taken from the browser)', trow && +trow.price === 599 && +trow.discount === 0 && +trow.amount === 599 && trow.status === 'created', { tampered, trow });
const direct = await run(`const { error } = await sbClient.from("hangtag_subscription_payments").update({ status: "paid" }).eq("id", ${JSON.stringify(tampered && tampered.payment_id)}); return error && (error.code || error.message);`);
const ext = await run(`const { error } = await sbClient.from("hangtag_subscriptions").update({ period_end: "2099-01-01T00:00:00Z" }).eq("owner_id", ${JSON.stringify(UID)}); return error && (error.code || error.message);`);
check('marking a payment paid or extending the plan straight through the API is refused', !!direct && !!ext && (await sql(`SELECT status FROM public.hangtag_subscription_payments WHERE id = $1`, [tampered.payment_id]))[0].status === 'created', { direct, ext });

console.log('--- Pay Now during the trial ---');
await promo('LAUNCH20');
await A.click('#plansBlk [data-sub-act="pay"]');
check('Pay Now: the payment page opens in a new tab and the app waits for the payment', await until('!!document.querySelector("#plansBlk .subwait")') && /Waiting for the payment/.test(await text('#plansBlk .subwait') || ''), await text('#plansBlk'));
await sleep(500);
const opened = await A.evaluate(() => window.__opened.map((w) => ({ href: w.location.href, closed: w.closed, opener: w.opener })));
check('…the provider\'s page was opened in a new tab (with no way back into the app)', opened.length === 1 && /^https:\/\/pay\.example\.test\//.test(opened[0].href) && !opened[0].closed && opened[0].opener === null, opened);
const pend = await run('return storage.get("hangtag_sub_pending", null)');
const prow = (await sql(`SELECT * FROM public.hangtag_subscription_payments WHERE id = $1`, [pend && pend.paymentId]))[0];
check('the payment waiting: 6 Months with LAUNCH20, amount computed by the database (₹3,599.20)', prow && prow.plan_code === 'm6' && prow.promo_code === 'LAUNCH20' && +prow.amount === 3599.2, prow);
await A.click('#plansBlk [data-sub-act="check"]'); await sleep(400);
check('"I\'ve paid" before the provider confirms: not confirmed yet, still waiting', /isn't confirmed yet/.test(await text('#plansBlk .subpromo-msg') || '') && await vis('#plansBlk .subwait'));
const trialEnd = await run('return subscriptionStatus().trial_ends_at');
providerPaid.add(prow.id);
check('the provider confirms → "Payment received", the plan runs until its end, without a reload', await until('!!document.querySelector("#plansBlk .subdone")', 15000) && /Payment received/.test(await text('#plansBlk') || ''), await text('#plansBlk'));
const st1 = await run('return subscriptionStatus()');
check('…paid_active; the 6 months start when the trial ends (no trial day lost)', st1.state === 'paid_active' && st1.plan_code === 'm6' && Date.parse(st1.period_start) === Date.parse(trialEnd), st1);
check('…and the payment history shows it as Paid', /6 Months/.test(await text('#plansBlk .subhist') || '') && /Paid/.test(await text('#plansBlk .subhist') || ''), await text('#plansBlk .subhist'));
check('the promo use was recorded against the payment', (await sql(`SELECT count(*)::int n FROM public.hangtag_promo_redemptions WHERE payment_id = $1 AND code = 'LAUNCH20'`, [prow.id]))[0].n === 1);

console.log('--- the plan ends: the app locks ---');
const before = (await sql(`SELECT (SELECT count(*) FROM public.hangtag_products WHERE owner_id = $1)::int p, (SELECT count(*) FROM public.hangtag_customers WHERE owner_id = $1)::int c`, [UID]))[0];
await sql(`UPDATE public.hangtag_subscriptions SET trial_ends_at = trial_started_at, period_start = now() - interval '6 months', period_end = now() - interval '1 minute' WHERE owner_id = $1`, [UID]);
await run('window.dispatchEvent(new Event("online"))');
check('the server says the plan ended → the lock screen replaces the app', await until('!!document.getElementById("lockScreen")'));
const lock = await text('#lockScreen');
check('"Your plan has ended", "Plan expired", the end date, the plans with the database\'s prices, promo, summary, Pay, history, sign out', /Your plan has ended/.test(lock || '') && /Plan expired/.test(lock || '')
  && /Ended on \d{1,2} \w{3} \d{4}/.test(lock || '') && /Monthly ₹599/.test(lock || '') && /Promo code/.test(lock || '') && /Final amount/.test(lock || '') && /Payment history/.test(lock || '') && /Sign out/.test(lock || ''), lock);
check('nothing of the app is shown: no navigation, no Agent, no page', !(await vis('.nav')) && !(await vis('#v-home')) && !(await vis('#globalActions')) && await A.$eval('.nav', (e) => getComputedStyle(e).display === 'none').catch(() => true));
await run('setTab("sell")'); await sleep(200);
const afterTab = await run('return {page: document.documentElement.dataset.page, sell: !!document.querySelector("#v-sell")&&getComputedStyle(document.querySelector("#v-sell")).display!=="none"&&document.querySelector("#v-sell").getClientRects().length>0}');
check('setTab("sell") does not open the till', await locked() && !afterTab.sell, afterTab);
await run('openDestination("stock:purchases")'); await sleep(200);
check('a direct route (Stock → Purchases) does not open either', await locked() && !(await vis('#v-stock')));
await A.keyboard.press('F2'); await A.keyboard.down('Control'); await A.keyboard.press('k'); await A.keyboard.up('Control'); await sleep(200);
check('keyboard shortcuts (F2, Ctrl+K) open nothing behind the lock', await locked() && !(await vis('#modalHost .sheet')) && !(await vis('#sheetHost .sheet')));
const after = (await sql(`SELECT (SELECT count(*) FROM public.hangtag_products WHERE owner_id = $1)::int p, (SELECT count(*) FROM public.hangtag_customers WHERE owner_id = $1)::int c`, [UID]))[0];
check('every row of the shop is still in the database (nothing deleted)', JSON.stringify(before) === JSON.stringify(after) && after.p >= 1 && after.c >= 1, { before, after });
const rest = await run(`const { error } = await sbClient.from("hangtag_customers").insert({ id: "c-direct", name: "Direct" }); return error && error.code;`);
check('a write straight through the API is refused by the server (HT402)', rest === 'HT402', rest);
check('the Home banner is gone while locked', !(await vis('#homeBody .subban')));

console.log('--- tampering does not unlock ---');
await run(`const r = storage.get("hangtag_subscription", null); r.status = Object.assign({}, r.status, { state: "paid_active", access_until: "2099-01-01T00:00:00Z", period_end: "2099-01-01T00:00:00Z" }); storage.set("hangtag_subscription", r);`);
await A.reload({ waitUntil: 'networkidle0' });
check('a saved status edited to "active until 2099" + reload: locked again as soon as the server answers', await until('!!document.getElementById("lockScreen")', 15000), await run('return subscriptionStatus()'));
await ctxA.close();
({ ctx: ctxA, page: A } = await openDevice({ clockShift: -400 * 86400000 }));
check('the device clock set back 400 days: still locked', await until('!!document.getElementById("lockScreen")', 15000));
await ctxA.close();
({ ctx: ctxA, page: A } = await openDevice());
check('back to normal: locked', await until('!!document.getElementById("lockScreen")', 15000));
await run(`saveCustomer({name:"Meena",phone:"98765 11111",email:""}); await flushSbQueue();`);
const q1 = await run('return { queued: sbOfflineQueue.length, review: (syncReview||[]).length }');
check('a change made while locked stays queued (never the review list, never lost)', q1.queued >= 1 && q1.review === 0, q1);

console.log('--- the screens fit ---');
for (const w of [320, 375, 768, 1280]) {
  await A.setViewport({ width: w, height: 800 }); await sleep(200);
  check(`the lock screen at ${w}px: no horizontal overflow, Pay reachable`, !(await overflow()) && await vis('#lockScreen [data-sub-act="pay"]'));
}
await A.setViewport({ width: 1280, height: 900 });

console.log('--- renewing opens everything at once ---');
await A.click('#lockScreen input[name="subPlan"][value="m1"]'); await sleep(300);
await until('!!document.querySelector("#lockScreen [data-sub-act=pay]")&&!document.querySelector("#lockScreen [data-sub-act=pay]").disabled');
await A.click('#lockScreen [data-sub-act="pay"]');
check('Pay on the lock screen → waiting for the payment', await until('!!document.querySelector("#lockScreen .subwait")'));
const pend2 = await run('return storage.get("hangtag_sub_pending", null)');
providerPaid.add(pend2.paymentId);
check('confirmed → the lock screen disappears and the app is back without a reload', await until('!document.getElementById("lockScreen")', 20000) && await vis('.nav'));
const st2 = await run('return subscriptionStatus()');
check('…a new month from now', st2.state === 'paid_active' && st2.plan_code === 'm1' && Math.abs(Date.parse(st2.period_start) - Date.now()) < 5 * 60e3, st2);
check('the change kept while locked goes up now', await until('sbOfflineQueue.length===0', 15000) && (await sql(`SELECT count(*)::int n FROM public.hangtag_customers WHERE owner_id = $1 AND name = 'Meena'`, [UID]))[0].n === 1);
await run('setTab("sell")'); await sleep(200);
check('the till opens again', await run('return document.documentElement.dataset.page') === 'sell');

console.log('--- another device of the shop ---');
const { ctx: ctxB, page: Bp } = await openDevice();
check('another device signed in to the same shop sees the same plan', await until('subscriptionStatus()&&subscriptionStatus().state==="paid_active"&&subscriptionStatus().plan_code==="m1"', 15000, Bp));
await sql(`UPDATE public.hangtag_subscriptions SET period_start = now() - interval '2 months', period_end = now() - interval '1 minute' WHERE owner_id = $1`, [UID]);
await run('window.dispatchEvent(new Event("online"))', Bp);
check('…and locks when the plan ends', await until('!!document.getElementById("lockScreen")', 15000, Bp));
// a team member's view of the same lock (its own role on this device)
await run('access = { role: "cashier", perms: ["create_sale"], shopName: "Aura Threads" }; const r = storage.get("hangtag_subscription"); r.status.is_owner = false; subscription = r; renderAll();', Bp);
await sleep(300);
const mem = await text('#lockScreen', Bp);
check('a team member sees "Ask the owner to renew" — no plans, no Pay', /Ask the owner to renew/.test(mem || '') && !(await vis('#lockScreen [data-sub-act="pay"]', Bp)) && /Sign out/.test(mem || ''), mem);
await ctxB.close();

console.log('--- Plans & Billing fits ---');
await sql(`UPDATE public.hangtag_subscriptions SET period_end = now() + interval '20 days' WHERE owner_id = $1`, [UID]);
await run('await refreshSubscription({force:true}); renderAll(); openSettings("plans")');
await until('!!document.querySelector("#plansBlk .subplan")');
for (const w of [320, 375, 768, 1280]) {
  await A.setViewport({ width: w, height: 800 }); await sleep(250);
  check(`Plans & Billing at ${w}px: no horizontal overflow`, !(await overflow()) && await vis('#plansBlk .subplans'));
}

console.log('--- online payment not set up: said plainly, nothing faked ---');
payable = false;
await A.setViewport({ width: 1280, height: 900 });
const nPay = async () => (await sql(`SELECT count(*)::int AS n FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [UID]))[0].n;
const n0 = await nPay(), end0 = (await sql(`SELECT period_end FROM public.hangtag_subscriptions WHERE owner_id = $1`, [UID]))[0].period_end;
await run('openSettings("plans")'); await until('!!document.getElementById("subPlan-set-m1")');
await A.click('#subPlan-set-m3'); await sleep(600);   // choosing another plan clears the earlier "Payment received"
await run('const b=document.querySelector("#plansBlk [data-sub-act=pay]"); if(b && !b.disabled) b.click();');
const said = await until('/Online payment isn.t set up yet/.test((document.querySelector("#plansBlk")||{}).innerText||"")');
const end1 = (await sql(`SELECT period_end FROM public.hangtag_subscriptions WHERE owner_id = $1`, [UID]))[0].period_end;
check('Pay with no payment provider set up: "Online payment isn\'t set up yet" (Pay goes away), no payment made, the plan unchanged — never a fake success',
  said && !(await A.$('#plansBlk [data-sub-act="pay"]')) && await nPay() === n0 && String(end1) === String(end0), { n0, end0, end1, t: (await text('#plansBlk') || '').slice(0, 300) });
const notSet = await run('try{ await use("subscriptionService").checkout("m1", ""); return "accepted"; }catch(e){ return e.code; }');
check('…and a checkout asked for directly is refused as not set up (no payment created)', notSet === 'NOT_CONFIGURED' && await nPay() === n0, notSet);
payable = true;

console.log('--- AutoPay: a new trial needs it — nothing to pay today, the plan after the trial ---');
await sql(`UPDATE public.hangtag_platform_config SET autopay_enabled = TRUE`);
const capturedBefore = (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE owner_id = $1 AND captured_at IS NOT NULL`, [UID]))[0].n;
await sql(`UPDATE public.hangtag_subscriptions SET plan_code = NULL, period_start = NULL, period_end = NULL, trial_started_at = now(), trial_ends_at = now() + interval '30 days',
  autopay_required = TRUE, autopay_status = 'none', autopay_subscription_id = NULL, autopay_provider = NULL, autopay_authorized_at = NULL WHERE owner_id = $1`, [UID]);
await run('await refreshSubscription({force:true}); renderAll()');
check('the trial waits for AutoPay: the lock screen says "Start your 30-day free trial"', await until('!!document.getElementById("lockScreen")', 15000) && /Start your 30-day free trial/.test(await text('#lockScreen') || ''), await text('#lockScreen'));
await until('!!document.querySelector("#lockScreen [data-apcard]")', 15000);
const apText = await text('#lockScreen [data-apcard]');
check('AutoPay\'s terms: ₹0 today, ₹599 / month after the trial (the AutoPay plan\'s price from the database), the first charge, "Required for the free trial"',
  /Today ₹0/.test(apText || '') && /After your trial ₹599 \/ month/.test(apText || '') && /First charge \d{1,2} \w{3} \d{4}/.test(apText || '') && /Required for the free trial/.test(apText || ''), apText);
check('…the consent says how much, how often, from when, until cancelled; Set up stays off until it is ticked', /charges ₹599 every month from .+ until I cancel/.test(apText || '')
  && await A.$eval('#lockScreen [data-sub-act="ap-start"]', (b) => b.disabled));
check('…a prepaid plan is offered instead ("Or pay for a plan now")', /Or pay for a plan now/.test(await text('#lockScreen') || '') && await vis('#lockScreen [data-sub-act="pay"]'));
await A.click('#apConsent'); await sleep(200);
check('ticked: Set up AutoPay is on', await A.$eval('#lockScreen [data-sub-act="ap-start"]', (b) => !b.disabled));
await A.click('#lockScreen [data-sub-act="ap-start"]');
check('Set up → the bank\'s approval page opens; AutoPay waits for it', await until('!!document.querySelector("#lockScreen .apcard.on")', 15000) && /Waiting for approval/.test(await text('#lockScreen .apcard') || ''), await text('#lockScreen'));
const apRow = (await sql(`SELECT autopay_status, autopay_consent_at, autopay_consent_version, autopay_subscription_id FROM public.hangtag_subscriptions WHERE owner_id = $1`, [UID]))[0];
check('…the consent is in the database with its version; the mandate is the provider\'s', apRow.autopay_status === 'pending' && !!apRow.autopay_consent_at && apRow.autopay_consent_version === 'autopay-2026-10'
  && /^sub_/.test(apRow.autopay_subscription_id || ''), apRow);
const apOpened = await A.evaluate(() => window.__opened.map((w) => w.location.href));
check('…the approval page opened in a new tab; still locked (the browser can\'t turn AutoPay on)', apOpened.some((h) => /^https:\/\/pay\.example\.test\/autopay\//.test(h)) && await locked(), apOpened);
apApproved = true;
check('the provider confirms the mandate → the trial opens without a reload', await until('!document.getElementById("lockScreen")', 20000) && await vis('.nav'));
const st3 = await run('return subscriptionStatus()');
check('…the trial runs, AutoPay on, the next charge at the trial\'s end', st3.state === 'trial_active' && st3.autopay.status === 'active' && Date.parse(st3.autopay.next_charge_at) === Date.parse(st3.trial_ends_at), st3);
check('no money counted for the trial or the AutoPay set-up', (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE owner_id = $1 AND captured_at IS NOT NULL`, [UID]))[0].n === capturedBefore);
await run('openSettings("plans")'); await until('!!document.querySelector("#plansBlk [data-apcard]")');
const onTxt = await text('#plansBlk [data-apcard]');
check('Plans & Billing: AutoPay On · ₹599 · Monthly · next charge on <date>; another plan waits until AutoPay is off', /₹599 · Monthly · next charge on \d{1,2} \w{3} \d{4}/.test(onTxt || '')
  && /turn AutoPay off first/.test(await text('#plansBlk') || '') && !(await A.$('#plansBlk [data-sub-act="pay"]')), onTxt);
await A.click('#plansBlk [data-sub-act="ap-cancel"]'); await sleep(200);
check('Turn off AutoPay asks first, saying until when Hangtag stays open', /Turn off AutoPay\?/.test(await text('#plansBlk [data-apcard]') || '') && /You keep using Hangtag until/.test(await text('#plansBlk [data-apcard]') || ''));
await A.click('#plansBlk [data-sub-act="ap-cancel-yes"]');
check('turned off (cancel any time before it renews): the trial keeps running, AutoPay off, a plan can be bought again',
  await until('subscriptionStatus().autopay.status==="cancelled"', 15000) && !(await locked()) && (await run('return subscriptionStatus().lifecycle')) === 'cancelled'
  && await until('!!document.querySelector("#plansBlk [data-sub-act=pay]")', 10000), await run('return subscriptionStatus()'));
for (const w of [320, 768]) {
  await A.setViewport({ width: w, height: 800 }); await sleep(250);
  check(`AutoPay in Plans & Billing at ${w}px: no horizontal overflow`, !(await overflow()) && await vis('#plansBlk [data-apcard]'));
}

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
