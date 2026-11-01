// Settings → Payments & Banks → "Connect a payment gateway", end to end in Chrome against PGlite running the real schema.sql
// (the payment-gateway function stood in: not set up, as on the live project today). A payment gateway is optional: the
// section offers three ways side by side — cash and the card machine (always on), the shop's own UPI QR (no gateway) and a
// gateway (not connected: connecting a shop's own account isn't available, and the section says so instead of a switch
// that pretends). Settings search finds it. A UPI ID is checked (name@bank), saved and synced; a test QR without an amount
// checks the payee; the payment screen then shows the bill's QR and keeps the payment Unverified; removing the UPI ID asks
// first, then the payment screen goes back to asking for one.
// Run: node tests/e2e/payment-settings.test.mjs
import { createReport } from '../helpers/report.mjs';
import { sleep, startShop } from '../helpers/app.mjs';
import { CORS } from '../helpers/pg-rest.mjs';
import H from '../helpers/env.mjs';

const R = createReport();
const notSetUp = (r) => r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: false, error: 'not_configured', message: 'Not set up.' }) });
const S = await startShop({ report: R, uid: 'aaaaaaaa-0000-0000-0000-0000000000e3', email: 'payset@example.com', shop: { shop_name: 'Fresh Mart' },
  functions: { '/functions/v1/payment-gateway': notSetUp, '/functions/v1/send-receipt': notSetUp } });
const A = await S.openDevice();
const settingsRow = async () => ((await S.sql(`SELECT value FROM public.hangtag_meta WHERE owner_id = $1 AND key = 'settings'`, ['aaaaaaaa-0000-0000-0000-0000000000e3']))[0] || {}).value || null;
const opts = () => A.page.$$eval('#paySetup .pg-opt', (l) => l.map((o) => o.innerText.replace(/\s+/g, ' ').trim()));

try {
  R.section('The section');
  await A.run('openSettings("payments")'); await sleep(300);
  await A.until('payConfig&&payConfig.upi===false');
  await A.run('refreshPaymentsForm&&refreshPaymentsForm()'); await sleep(200);
  const o = await opts();
  R.check('Payments & Banks opens with "Connect a payment gateway": three ways side by side', (await A.text('#paySetup h5')) === 'Connect a payment gateway' && o.length === 3, o);
  R.check('…cash and the card machine: always on, nothing to set up, never the card number, CVV or PIN', /^Cash and your card machine Always on/.test(o[0]) && /never the card number, CVV or PIN/.test(o[0]), o[0]);
  R.check('…your own UPI QR: off until a UPI ID is given; it says the payment is kept Unverified until the shop confirms it', /^Your own UPI QR Off/.test(o[1]) && /kept as Unverified until you confirm it reached your account/.test(o[1]), o[1]);
  R.check('…a payment gateway: "Not connected", and plainly not switched on yet for the shop\'s own account — no switch that pretends', /^A payment gateway Not connected/.test(o[2]) && /isn't switched on for your shop yet/.test(o[2])
    && !(await A.page.$('#paySetup .pg-opt:nth-child(3) input[type="checkbox"], #paySetup .pg-opt:nth-child(3) button')), o[2]);
  R.check('…no server words for the shop owner (no "secrets", no function names)', !/secret|payment-gateway|function/i.test(o.join(' ')), o.join(' '));
  await A.run('const q=document.getElementById("setQ");if(q){q.value="payment gateway";q.dispatchEvent(new Event("input",{bubbles:true}))}'); await sleep(200);
  R.check('Settings search "payment gateway" finds Payments & Banks', /Payments & Banks/.test(await A.text('#setResults') || ''), await A.text('#setResults'));
  await A.run('const q=document.getElementById("setQ");if(q){q.value="";q.dispatchEvent(new Event("input",{bubbles:true}))};openSettings("payments")'); await sleep(250);

  R.section('Your own UPI QR');
  await A.type('#paymentsForm [name="upiId"]', 'freshmart'); await A.click('#paymentsForm [type="submit"]', 250);
  R.check('a UPI ID that isn\'t name@bank is refused, saying how to write it', /Enter the UPI ID as name@bank/.test(await A.text('#payErr2') || '') && !(await A.run('return settings.upiId')), await A.text('#payErr2'));
  await A.type('#paymentsForm [name="upiId"]', 'freshmart@okaxis'); await A.click('#paymentsForm [type="submit"]', 300);
  await A.run('await flushSbQueue()');
  R.check('saved: the UPI QR is On, and the shop\'s settings in the cloud carry it', (await A.run('return settings.upiId')) === 'freshmart@okaxis' && /^Your own UPI QR On/.test((await opts())[1])
    && await A.until('true') && ((await settingsRow()) || {}).upiId === 'freshmart@okaxis', await settingsRow());
  await A.click('#paySetup [data-paytestqr]', 200);
  const testUri = await A.run('return upiCheckUri({vpa:settings.upiId,name:profile.shop_name})');
  R.check('"Show a test QR": a QR to scan for the payee\'s name — the UPI ID, no amount (it pays nothing)', !!(await A.page.$('#paySetup .pg-test svg')) && /pa=freshmart%40okaxis/.test(testUri) && !/[?&]am=/.test(testUri)
    && /don't pay/.test(await A.text('#paySetup .pg-test') || ''), testUri);
  await A.page.$eval('#paySetup', (e) => e.scrollIntoView({ block: 'start' })); await A.page.screenshot({ path: H.ARTIFACTS + '/payment_settings_desktop.png' });
  await A.click('#paySetup [data-paytestqr]', 200);
  R.check('…and it hides again', !(await A.page.$('#paySetup .pg-test')));

  R.section('The payment screen');
  await A.run('loadExamples();await flushSbQueue();setTab("sell");renderAll()'); await sleep(300);
  await A.run('const p=products()[0];addToLines(cart,p.variants[0].id,1);saveCart();renderAll();openPayment("upi")'); await sleep(400);
  const pay = await A.text('#paySheet');
  R.check('UPI on the payment screen: the shop\'s QR with the bill\'s amount, paid to its UPI ID; the cashier marks it received and it stays Unverified',
    !!(await A.page.$('#paySheet .pi-qr.small svg')) && /Pay to freshmart@okaxis/.test(pay || '') && /Mark UPI payment received/.test(pay || '') && /saved as Unverified/.test(pay || ''), (pay || '').slice(0, 400));
  await A.run('closeModal()'); await sleep(150);

  R.section('Removing it');
  await A.run('openSettings("payments")'); await sleep(250);
  await A.click('#paySetup [data-payremove]', 200);
  R.check('"Remove UPI ID" asks first, saying what changes (no QR; UPI still recorded by hand; nothing sold changes)', /Remove your UPI ID\? The payment screen won't show your QR any more; UPI can still be recorded by hand, and nothing already sold changes/.test(await A.text('#paySetup .pg-confirm') || ''));
  await A.click('#paySetup [data-payremoveno]', 200);
  R.check('…"Keep it": nothing changes', (await A.run('return settings.upiId')) === 'freshmart@okaxis' && !(await A.page.$('#paySetup .pg-confirm')));
  await A.click('#paySetup [data-payremove]', 150); await A.click('#paySetup [data-payremoveyes]', 300);
  await A.run('await flushSbQueue()');
  R.check('…confirmed: the UPI ID is gone (this device and the cloud), the UPI QR Off', (await A.run('return settings.upiId')) === '' && /^Your own UPI QR Off/.test((await opts())[1])
    && await A.until('true') && ((await settingsRow()) || {}).upiId === '', await settingsRow());
  await A.run('setTab("sell");renderAll();openPayment("upi")'); await sleep(400);
  R.check('…and the payment screen asks for a UPI ID again (UPI can still be marked received by hand)', /Add your shop's UPI ID in Settings → Payments & Banks/.test(await A.text('#paySheet') || '') && /Mark UPI payment received/.test(await A.text('#paySheet') || ''));
  await A.run('closeModal()');
  await A.page.setViewport({ width: 375, height: 780, isMobile: true, hasTouch: true }); await sleep(300);
  await A.until('sbStatus==="connected"', 20000);
  await A.run('openSettings("payments")'); await sleep(300);
  R.check('a phone: the three ways one under another, nothing wider than the screen', (await A.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1
    && (await A.page.$$eval('#paySetup .pg-opt', (l) => l.length === 3 && l.every((x, i, a) => i === 0 || x.getBoundingClientRect().top > a[i - 1].getBoundingClientRect().top))));
} finally {
  await R.done(() => S.close());
}
