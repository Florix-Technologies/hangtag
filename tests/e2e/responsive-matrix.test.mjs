// The responsive workflow matrix: the shop's everyday screens, sheets and forms (Home, a sale with its bill, Bills and a
// bill, Customers and a profile, Stock, Products, Reports, Orders, Settings, the Agent, Search, New, a return, an expense,
// the product editor, checkout and a split payment, stock in and adjust, a supplier bill, product import, a new customer,
// purchases, a quotation, Plans & Billing, closing the day — 33 in all) on a phone (360 px), a large phone (414), a tablet
// (768) and a desktop (1280), each checked by tests/helpers/responsive.mjs: never scrolls sideways, no control off the
// screen, sheets fit or scroll inside, touch targets of at least 24 px on touch screens, every control named, nothing drawn
// over anything else or cut off, no squeezed field, nothing left under the phone's tab bar — and the navigation each size
// should have (the phone's tab bar, the desktop's workspace bar). The boutique (tests/helpers/shop-fixtures.mjs) gives
// every screen something to show. SHOTS=1 saves a screenshot of each.
import { createReport } from '../helpers/report.mjs';
import { VIEWPORTS, sleep, startShop } from '../helpers/app.mjs';
import { BOUTIQUE, seedShop } from '../helpers/shop-fixtures.mjs';
import { coveredAtEnd, layoutIssues } from '../helpers/responsive.mjs';

const R = createReport();
const UID = 'aaaaaaaa-0000-0000-0000-0000000000c4';
const S = await startShop({ report: R, uid: UID, email: 'responsive@example.com', shop: { shop_name: 'Aura Threads', gstin: '' } });
const first = await S.openDevice({ label: 'seed' });
const ids = await seedShop(first, BOUTIQUE);
const js = (v) => JSON.stringify(v), bill = ids.bills[2].id, riya = ids.customers.Riya, kurta = ids.products.Kurta.variant;

/* each screen: how to open it, and where its controls are (a page, or the sheet on top) */
const PAGE = 'body', SHEETS = '#modalHost, #sheetHost';
const SCREENS = [
  { name: 'Home', open: (D) => D.go('home'), scope: PAGE },
  { name: 'Sell with a bill', open: async (D) => { await D.go('sell'); await D.run(`addOne(${js(kurta)});renderAll()`); }, scope: PAGE },
  { name: 'Bills', open: (D) => D.go('bills'), scope: PAGE },
  { name: 'A bill', open: (D) => D.run(`closeSheets();openBillView(${js(bill)})`), scope: SHEETS },
  { name: 'Customers', open: (D) => D.go('customers'), scope: PAGE },
  { name: 'A customer\'s profile', open: (D) => D.run(`openCustHistory(${js(riya)})`), scope: SHEETS },
  { name: 'Stock', open: (D) => D.go('stock'), scope: PAGE },
  { name: 'Products', open: (D) => D.go('products'), scope: PAGE },
  { name: 'Reports', open: (D) => D.go('report'), scope: PAGE },
  { name: 'Orders', open: (D) => D.go('orders'), scope: PAGE },
  { name: 'Settings → Automation', open: (D) => D.run('closeModal();openSettings("automation")'), scope: PAGE },
  { name: 'Settings → Diagnostics', open: (D) => D.run('closeModal();openSettings("advanced")'), scope: PAGE },
  { name: 'The Agent', open: (D) => D.go('assistant'), scope: PAGE },
  { name: 'Search', open: (D) => D.run('closeModal();openAnything("riya")'), scope: SHEETS },
  { name: 'New', open: (D) => D.run('closeModal();openQuickActions()'), scope: SHEETS },
  { name: 'A return', open: (D) => D.run(`closeModal();openReturn(${js(bill)})`), scope: SHEETS },
  { name: 'An expense', open: (D) => D.run('closeModal();closeSheets();openCashForm("expense")'), scope: SHEETS },
  // the forms and sheets of the everyday work
  { name: 'A new product', open: (D) => D.run('closeModal();closeSheets();openEditor(null)'), scope: SHEETS },
  { name: 'Editing a product', open: (D) => D.run(`closeModal();closeSheets();openEditor(${js(ids.products.Kurta.id)})`), scope: SHEETS },
  { name: 'Checkout', open: async (D) => { await D.go('sell'); await D.run(`cart=[];addOne(${js(kurta)});addOne(${js(ids.products.Tee.variant)});renderAll();openCheckout("cash")`); }, scope: SHEETS },
  { name: 'A split payment', open: async (D) => { await D.go('sell'); await D.run(`cart=[];addOne(${js(kurta)});renderAll();openPayment("split")`); }, scope: SHEETS },
  { name: 'Stock in', open: (D) => D.run(`closeModal();closeSheets();openStockOp("in",${js(ids.products.Kurta.id)})`), scope: SHEETS },
  { name: 'Adjust stock', open: (D) => D.run(`closeModal();closeSheets();openStockOp("adjust",${js(ids.products.Kurta.id)})`), scope: SHEETS },
  { name: 'Upload a supplier bill', open: (D) => D.run('closeModal();closeSheets();cart=[];openBillImport()'), scope: SHEETS },
  { name: 'Import products', open: (D) => D.run('closeModal();closeSheets();openProductImport()'), scope: SHEETS },
  { name: 'A new customer', open: (D) => D.run('closeModal();closeSheets();newCustomerForm("page")'), scope: SHEETS },
  { name: 'Purchases', open: (D) => D.run('closeModal();closeSheets();openDestination("stock:purchases")'), scope: PAGE },
  { name: 'A purchase', open: (D) => D.run('closeModal();closeSheets();openPurchaseEntry()'), scope: SHEETS },
  { name: 'A quotation', open: (D) => D.run('closeModal();closeSheets();openOrderEditor(null,"quote")'), scope: SHEETS },
  { name: 'Settings → Business', open: (D) => D.run('closeModal();closeSheets();openSettings("business")'), scope: PAGE },
  { name: 'Settings → Payments', open: (D) => D.run('closeModal();closeSheets();openSettings("payments")'), scope: PAGE },
  { name: 'Plans & Billing', open: (D) => D.run('closeModal();closeSheets();openSettings("plans")'), scope: PAGE },
  { name: 'Closing the day', open: (D) => D.run('closeModal();closeSheets();openCashForm("close")'), scope: SHEETS },
];

for(const [size, vp] of Object.entries(VIEWPORTS)){
  R.section(`${size} (${vp.width} × ${vp.height})`);
  const D = await S.openDevice({ viewport: size, label: size });
  await D.run('await pullFromSupabase(false)');
  const touch = !!vp.hasTouch;
  // the navigation this size should have
  await D.go('home');
  const bar = await D.page.$$eval('.nav .navi', (b) => b.filter((x) => x.getClientRects().length).map((x) => ({ tab: x.dataset.tab, phone: x.classList.contains('pb') })));
  R.check(`[${size}] ${vp.width < 700 ? 'the phone\'s tab bar' : 'the workspace bar'}`, vp.width < 700 ? bar.length >= 3 && bar.every((x) => x.phone) : bar.length >= 4 && bar.some((x) => x.tab === 'bills'), bar);
  for(const sc of SCREENS){
    await D.run('closeModal();closeSheets()').catch(() => {});
    await sc.open(D); await sleep(350);
    // SHOTS=1 keeps a picture of every screen at every size (tests/.artifacts/rm-<size>-<screen>.png) to look at by eye
    if(process.env.SHOTS) await D.page.screenshot({ path: `${process.env.SHOTS_DIR || 'tests/.artifacts'}/rm-${size}-${sc.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.png`, fullPage: sc.scope === PAGE }).catch(() => {});
    const issues = await layoutIssues(D.page, { touch, scope: sc.scope });
    const layout = issues.filter((x) => x.kind !== 'small-target' && x.kind !== 'unnamed'), small = issues.filter((x) => x.kind === 'small-target');
    const unnamed = issues.filter((x) => x.kind === 'unnamed');
    R.check(`[${size}] ${sc.name}: fits the screen`, layout.length === 0, layout.slice(0, 6));
    R.check(`[${size}] ${sc.name}: every control has a name a screen reader can say`, unnamed.length === 0, unnamed.slice(0, 8));
    if(touch) R.check(`[${size}] ${sc.name}: touch targets of 24 px or more`, small.length === 0, small.slice(0, 8));
    // a page's last controls can be scrolled out from under the phone's tab bar
    if(sc.scope === PAGE){ const cov = await coveredAtEnd(D.page, { scope: 'main' }); R.check(`[${size}] ${sc.name}: nothing stays under the tab bar`, cov.length === 0, cov.slice(0, 6)); }
  }
  await D.run('closeModal();closeSheets()').catch(() => {});
}
await R.done(() => S.close());
