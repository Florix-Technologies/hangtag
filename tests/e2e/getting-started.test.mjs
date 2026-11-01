// A new shop's first steps, end to end in Chrome against PGlite running the real schema.sql: the sign-up screen says the
// free trial starts once the shop is set up; Home shows "Getting started" to whoever manages the shop's settings (never to
// a cashier) — add products, make the first bill, choose how payments are taken, set up the receipt — each with where to
// do it; each is ticked by itself from the shop's own records (or once its settings were looked at); the card goes when
// all four are done, or when hidden, and stays hidden on that device.
// Run: node tests/e2e/getting-started.test.mjs
import { createReport } from '../helpers/report.mjs';
import { sleep, startShop } from '../helpers/app.mjs';
import { sellBill } from '../helpers/shop-fixtures.mjs';
import { CORS } from '../helpers/pg-rest.mjs';

const R = createReport();
const notSetUp = (r) => r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: false, error: 'not_configured', message: 'Not set up.' }) });
const S = await startShop({ report: R, uid: 'aaaaaaaa-0000-0000-0000-0000000000e4', email: 'newshop@example.com', shop: { shop_name: 'Lotus Footwear' },
  functions: { '/functions/v1/payment-gateway': notSetUp, '/functions/v1/send-receipt': notSetUp } });
const A = await S.openDevice();
const card = () => A.page.$eval('#homeBody .hstart', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const done = () => A.page.$$eval('#homeBody .hstart-i.done', (l) => l.map((e) => e.dataset.start)).catch(() => []);
const home = async () => { await A.run('closeModal();closeSheets();setTab("home");renderAll()'); await sleep(250); };

try {
  R.section('Signing up');
  const up = await A.run('setEmailMode("signup");const t=document.getElementById("authMsg").textContent;setEmailMode("signin");return t');
  R.check('the sign-up screen says the free trial starts once the shop is set up', /Create your Hangtag account/.test(up) && /free trial starts when you finish setting the shop up/.test(up), up);

  R.section('Getting started');
  await home();
  const c0 = await card();
  R.check('a new shop\'s Home: "Getting started 0 of 4" — products, the first bill, payments, the receipt', /^Getting started 0 of 4/.test(c0 || '') && /Add your products/.test(c0) && /Make your first bill/.test(c0)
    && /Choose how you take payments/.test(c0) && /Set up your receipt/.test(c0), c0);
  R.check('…each step with where to do it', !!(await A.page.$('#homeBody .hstart [data-act="prodimport"]')) && !!(await A.page.$('#homeBody .hstart [data-tab="sell"]'))
    && !!(await A.page.$('#homeBody .hstart [data-setgo="payments"]')) && !!(await A.page.$('#homeBody .hstart [data-setgo="billing"]')));
  await A.click('#homeBody .hstart [data-act="prodimport"]', 300);
  R.check('"Import a spreadsheet" opens the product import from Home', await A.until('prodImport') && !!(await A.page.$('#modalHost .im-steps')));
  await A.run('prodImport=null;closeModal()');
  // a cashier never sees it (the steps are the owner's or a manager's)
  const cashier = await A.run('const keep=access;access={role:"cashier",perms:["create_sale"],shopName:"Lotus Footwear"};renderHome();const has=!!document.querySelector("#homeBody .hstart");access=keep;renderHome();return has');
  R.check('…a cashier\'s Home has no "Getting started"', cashier === false);
  // the steps tick themselves
  const ids = await A.run('loadExamples();await flushSbQueue();const p=products()[0];return {products:{tee:{variant:p.variants[0].id}}}');
  await home();
  R.check('products added: 1 of 4, "Add your products" done', /^Getting started 1 of 4/.test(await card() || '') && JSON.stringify(await done()) === '["products"]', await done());
  await sellBill(A, ids, { lines: [['tee', 1]], pay: 'cash' });
  await home();
  R.check('the first bill made: 2 of 4', /^Getting started 2 of 4/.test(await card() || '') && JSON.stringify(await done()) === '["products","bill"]', await done());
  await A.click('#homeBody .hstart [data-setgo="payments"]', 400);
  R.check('"Payment settings" opens Payments & Banks → Connect a payment gateway', /Connect a payment gateway/.test(await A.text('#paySetup h5') || ''));
  await home();
  R.check('…looked at: 3 of 4', /^Getting started 3 of 4/.test(await card() || ''), await card());
  await A.click('#homeBody .hstart [data-setgo="billing"]', 400);
  await home();
  R.check('the receipt settings looked at: all four done, the card goes', (await card()) === null);
  // hidden on a fresh start (another day, another shop on this device)
  await A.run('prefs.paySeen=false;prefs.receiptSeen=false;savePrefs();renderHome()'); await sleep(150);
  R.check('(two steps open again for the next check)', /^Getting started 2 of 4/.test(await card() || ''), await card());
  await A.click('#homeBody .hstart [data-starthide]', 200);
  await home();
  R.check('"Hide": the card goes, and stays gone on this device', (await card()) === null && (await A.run('return prefs.startHidden')) === true);
} finally {
  await R.done(() => S.close());
}
