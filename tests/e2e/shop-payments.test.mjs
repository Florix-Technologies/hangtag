// Shop payments end to end in Chrome: the app → the REAL payment-gateway function logic (supabase/functions/payment-gateway/
// handler.js) → PGlite running schema.sql with the shop payments migration (row security on) and a scripted Razorpay
// (tests/helpers/razorpay-fake.mjs — MOCKED: Razorpay's own sandbox is a separate, manual step).
// - Settings → Payments & Banks: a gateway is "Not connected"; the shop connects ITS OWN Razorpay test keys in a form of
//   their own (keys Razorpay refuses are refused, nothing kept); connected, it shows test mode, the key masked and the
//   webhook address — and the key secret is nowhere in the app or the shop's settings;
// - a UPI QR on the shop's own account: pending until Razorpay has the money, then the bill completes by itself, verified;
// - UPI checked by hand: Unverified until the owner marks it Received in Reports → Reconciliation (confirmed, by whom);
// - a card on the shop's own machine says "Payment recorded", never "successful";
// - disconnecting: Not connected again; the payment screen offers UPI by hand only.
// Run: node tests/e2e/shop-payments.test.mjs
import fs from 'node:fs';
import { createReport } from '../helpers/report.mjs';
import { sleep, startShop } from '../helpers/app.mjs';
import { CORS, serviceToken } from '../helpers/pg-rest.mjs';
import { pgClient } from '../helpers/pg-client.mjs';
import { razorpayFake } from '../helpers/razorpay-fake.mjs';
import { handlePayment } from '../../supabase/functions/payment-gateway/handler.js';

const R = createReport();
const MIG = fs.readFileSync(new URL('../../supabase/migrations/20261023120000_hangtag_shop_payments.sql', import.meta.url), 'utf8');
const UID = 'aaaaaaaa-0000-0000-0000-0000000000e7', EMAIL = 'shoppay@example.com';
const KEY = { id: 'rzp_test_FreshMart0001', secret: 'FMsecretFMsecretFMsecret' };
const rz = razorpayFake();
rz.keys.set(KEY.id, KEY.secret);
const ENV = { SUPABASE_URL: 'https://project.supabase.co', PAYMENT_ACCOUNTS_KEY: Buffer.alloc(32, 5).toString('base64'), PAYMENT_ALLOWED_USERS: EMAIL };
const quiet = { error: () => {}, warn: () => {}, log: () => {} };
let S = null;
/* the payment-gateway function, as Supabase would run it, against this shop's database */
async function gateway(r) {
  const h = r.headers(), out = await handlePayment({ method: r.method(), auth: h.authorization || null, device: h['x-hangtag-device'] || null,
    json: async () => JSON.parse(r.postData() || 'null') }, {
    env: ENV, fetch: rz.fetch, log: quiet,
    userDb: (auth, dev) => pgClient(S.pg, { token: auth.replace(/^Bearer\s+/i, ''), headers: dev ? { 'x-hangtag-device': dev } : {} }),
    admin: () => pgClient(S.pg, { token: serviceToken() }),
  });
  r.respond({ status: out.status, contentType: 'application/json', headers: CORS, body: JSON.stringify(out.body) });
}
const notSetUp = (r) => r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: false, error: 'not_configured', message: 'Not set up.' }) });
S = await startShop({ report: R, uid: UID, email: EMAIL, shop: { shop_name: 'Fresh Mart' }, after: [MIG],
  functions: { '/functions/v1/payment-gateway': gateway, '/functions/v1/send-receipt': notSetUp } });
const A = await S.openDevice();
const gw = () => A.text('#paySetup [data-payprovider]');

try {
  R.section('Connecting the shop\'s own Razorpay account');
  await A.run('openSettings("payments")'); await sleep(300);
  await A.until('payConfig&&payConfig.gateway&&payConfig.gateway.available', 15000);
  await A.run('refreshPaymentsForm&&refreshPaymentsForm()'); await sleep(250);
  R.check('a payment gateway: "Not connected", switched on for this shop, connecting its own account offered (Razorpay pays the money into the shop\'s bank)',
    /^A payment gateway Not connected/.test(await gw() || '') && /Razorpay pays the money into your bank/.test(await gw() || '') && !!(await A.page.$('#paySetup [data-gwconnect]')), await gw());
  await A.click('#paySetup [data-gwconnect]', 250);
  const hook = await A.page.$eval('#gwConnectForm [name="gwWebhookSecret"]', (e) => e.value).catch(() => '');
  R.check('its own form (not the shop\'s settings): Key Id, Key Secret (hidden as typed), a webhook secret made here to copy into Razorpay',
    !!(await A.page.$('#gwConnectForm')) && !(await A.page.$('#paymentsForm [name="gwKeySecret"]')) && (await A.page.$eval('#gwConnectForm [name="gwKeySecret"]', (e) => e.type)) === 'password' && /^hgw_[0-9a-f]{36}$/.test(hook), hook);
  await A.type('#gwConnectForm [name="gwKeyId"]', 'rzp_test_SomeoneElse01'); await A.type('#gwConnectForm [name="gwKeySecret"]', 'NotTheRightSecret0000');
  await A.click('#gwConnectForm [data-gwsubmit]', 600);
  await A.until('!document.querySelector("#gwErr")||!document.querySelector("#gwErr").hidden', 8000);
  R.check('keys Razorpay refuses: said plainly, nothing connected or kept', /Razorpay didn't accept these keys/.test(await A.text('#gwErr') || '')
    && (await S.sql(`SELECT count(*)::int n FROM public.hangtag_payment_accounts`))[0].n === 0, await A.text('#gwErr'));
  R.check('…and the Key Secret box is emptied', (await A.page.$eval('#gwConnectForm [name="gwKeySecret"]', (e) => e.value)) === '');
  await A.type('#gwConnectForm [name="gwKeyId"]', KEY.id); await A.type('#gwConnectForm [name="gwKeySecret"]', KEY.secret);
  await A.click('#gwConnectForm [data-gwsubmit]', 300);
  R.check('the shop\'s own test keys: connected — "On · Test mode", the key masked, the webhook address and events to add in Razorpay',
    await A.until('payConfig&&payConfig.gateway&&payConfig.gateway.connected', 10000) && /On · Test mode/.test(await gw() || '') && /rzp_test_…0001/.test(await gw() || '')
    && /\/functions\/v1\/payment-webhook\?a=/.test(await A.page.$eval('[data-gwurl]', (e) => e.value).catch(() => '')) && /qr_code\.credited/.test(await gw() || '') && !(await A.page.$('#gwConnectForm')), await gw());
  const row = (await S.sql(`SELECT row_to_json(a)::text AS j FROM public.hangtag_payment_accounts a WHERE owner_id = $1 AND status = 'connected'`, [UID]))[0];
  R.check('the database keeps the keys sealed (neither secret readable in the row)', !!row && !row.j.includes(KEY.secret) && !row.j.includes(hook), row);
  const leaked = await A.run(`const all=JSON.stringify(localStorage)+JSON.stringify(settings)+document.body.innerHTML;return [${JSON.stringify(KEY.secret)},${JSON.stringify(hook)}].filter(x=>all.includes(x))`);
  R.check('neither secret is anywhere in the app — this device\'s storage, the shop\'s settings, the page', Array.isArray(leaked) && leaked.length === 0, leaked);
  await A.page.$eval('#paySetup', (e) => e.scrollIntoView({ block: 'start' })); await A.page.screenshot({ path: (await import('../helpers/env.mjs')).default.ARTIFACTS + '/shop_payments_connected.png' });

  R.section('A UPI QR on the shop\'s own account');
  await A.run('loadExamples();settings.upiId="freshmart@okaxis";saveSettings();await flushSbQueue();setTab("sell");renderAll()'); await sleep(300);
  await A.run('const p=products()[0];addToLines(cart,p.variants[0].id,1);saveCart();renderAll();openPayment("upi")');
  R.check('the payment screen shows Razorpay\'s QR for the exact amount: Payment pending', await A.until('payState&&payState.pi&&payState.pi.upi&&payState.pi.upi.status==="pending"', 10000)
    && !!(await A.page.$('#paySheet [data-pistate="pending"] img')), await A.run('return payState&&payState.pi'));
  const intent = (await S.sql(`SELECT i.id::text, i.provider_intent_id, a.key_id FROM public.hangtag_payment_intents i JOIN public.hangtag_payment_accounts a ON a.id = i.account_id WHERE i.owner_id = $1 ORDER BY i.created_at DESC LIMIT 1`, [UID]))[0];
  R.check('…made on the shop\'s own account (the intent names it)', !!intent && intent.key_id === KEY.id && rz.qrs.get(intent.provider_intent_id).kid === KEY.id, intent);
  await sleep(3500);
  R.check('a few seconds on, nothing paid: still pending (showing the QR is never a payment)', await A.run('return payState&&payState.pi.upi&&payState.pi.upi.status') === 'pending');
  rz.payQr(intent.provider_intent_id);
  R.check('the customer pays: Razorpay has the money → the bill completes by itself, verified, "Payment successful"',
    await A.until('lastSale&&lastSale.payments&&lastSale.payments[0]&&lastSale.payments[0].verification==="verified"', 20000) && /Payment successful/.test(await A.text('#sheetHost .paid') || ''), await A.run('return lastSale&&lastSale.payments'));
  await A.run('closeSheets();await flushSbQueue()');
  const sale1 = await A.run('return lastSale.id');
  await A.until('true');
  const p1 = (await S.sql(`SELECT verification, via, intent_id::text FROM public.hangtag_payments WHERE owner_id = $1 AND sale_id = $2`, [UID, sale1]))[0];
  R.check('…and in the cloud: verified, by that intent (the database checked it)', p1 && p1.verification === 'verified' && p1.via === 'qr' && p1.intent_id === intent.id, p1);

  R.section('UPI checked by hand: Unverified until the shop confirms it');
  await A.run('setTab("sell");const p=products()[0];addToLines(cart,p.variants[0].id,1);saveCart();renderAll();openPayment("upi")');
  await A.until('payState&&payState.pi&&payState.pi.upi&&payState.pi.upi.status==="pending"', 10000);
  await A.click('[data-payvia="upi:manual"]', 400);
  await A.type('#paySheet [data-payf="ref:upi"]', '412345678901');
  await A.click('[data-upireceived]', 200); await A.click('#payDone', 500);
  R.check('saved Unverified: "Sale completed", and the screen says it waits for the shop to confirm it (Reports → Reconciliation)',
    /Sale completed/.test(await A.text('#sheetHost .paid') || '') && /Unverified until you confirm it reached your account/.test(await A.text('#sheetHost [data-unverified]') || ''), await A.text('#sheetHost .paid'));
  const sale2 = await A.run('return lastSale.id');
  await A.run('closeSheets();await flushSbQueue();setTab("report");renderAll()'); await sleep(400);
  R.check('Reports → Reconciliation: 1 UPI payment not verified, with "Received" to confirm it', /UPI not verified 1/.test(await A.text('#reconcileCard') || '') && !!(await A.page.$(`#reconcileCard [data-upiconfirm="${sale2}"]`)), await A.text('#reconcileCard'));
  await A.click(`#reconcileCard [data-upiconfirm="${sale2}"]`, 300);   // the "did it reach your bank?" question is answered yes
  R.check('"Received": confirmed on this device …', await A.until(`D().saleById[${JSON.stringify(sale2)}].payments[0].verification==="confirmed"`, 10000));
  const p2 = (await S.sql(`SELECT verification, confirmed_by::text FROM public.hangtag_payments WHERE owner_id = $1 AND sale_id = $2`, [UID, sale2]))[0];
  R.check('… and in the cloud, by the owner', p2 && p2.verification === 'confirmed' && p2.confirmed_by === UID, p2);
  await A.run('renderAll()'); await sleep(200);
  R.check('Reconciliation: nothing left to confirm', /Every UPI payment in this period is verified or confirmed/.test(await A.text('#reconcileCard') || ''), await A.text('#reconcileCard'));

  R.section('A card on the shop\'s own machine');
  await A.run('setTab("sell");const p=products()[0];addToLines(cart,p.variants[0].id,1);saveCart();renderAll();openPayment("card")'); await sleep(400);
  await A.type('#paySheet [data-payf="ref:card"]', 'APPR77'); await A.click('#payDone', 500);
  R.check('"Payment recorded", never "successful": the cashier marked the machine\'s approval', /Payment recorded/.test(await A.text('#sheetHost .paid') || '') && !/Payment successful/.test(await A.text('#sheetHost .paid') || '')
    && /recorded as approved by the cashier/.test(await A.text('#sheetHost [data-cardmachine]') || ''), await A.text('#sheetHost .paid'));
  await A.run('closeSheets()');

  R.section('Disconnecting');
  await A.run('openSettings("payments")'); await sleep(300);
  await A.click('#paySetup [data-gwdisconnect]', 200);
  R.check('"Disconnect" asks first, saying what happens (open QRs closed, keys forgotten, payments taken stay)', /Open|still open are closed/.test(await A.text('#paySetup .pg-confirm') || '') && /forgets the keys/.test(await A.text('#paySetup .pg-confirm') || ''), await A.text('#paySetup .pg-confirm'));
  await A.click('#paySetup [data-gwdisconnectyes]', 300);
  R.check('disconnected: "Not connected" again; the keys dropped in the database', await A.until('payConfig&&payConfig.gateway&&!payConfig.gateway.connected', 10000) && /Not connected/.test(await gw() || '')
    && (await S.sql(`SELECT count(*)::int n FROM public.hangtag_payment_accounts WHERE owner_id = $1 AND (status = 'connected' OR secret_box IS NOT NULL)`, [UID]))[0].n === 0, await gw());
  await A.run('setTab("sell");const p=products()[0];addToLines(cart,p.variants[0].id,1);saveCart();renderAll();openPayment("upi")'); await sleep(600);
  R.check('…the payment screen offers UPI by the shop\'s own QR, checked by hand (no gateway QR)', !(await A.run('return !!(payState&&payState.pi&&payState.pi.upi)')) && /Mark UPI payment received/.test(await A.text('#paySheet') || ''), await A.text('#paySheet'));
  await A.run('closeModal()');
} finally {
  await R.done(() => S.close());
}
