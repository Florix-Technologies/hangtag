// The responsive workflow matrix: the shop's everyday screens and sheets (Home, a sale with its bill, Bills and a bill,
// Customers and a profile, Stock, Reports, Orders, Settings → Automation and Diagnostics, the Agent, Search, New, a return,
// an expense) on a phone (360 px), a large phone (414), a tablet (768) and a desktop (1280), each checked by
// tests/helpers/responsive.mjs: never scrolls sideways, no control off the screen, sheets fit or scroll inside, touch
// targets of at least 24 px on touch screens — and the navigation each size should have (the phone's tab bar, the
// desktop's workspace bar). The boutique (tests/helpers/shop-fixtures.mjs) gives every screen something to show.
import { createReport } from '../helpers/report.mjs';
import { VIEWPORTS, sleep, startShop } from '../helpers/app.mjs';
import { BOUTIQUE, seedShop } from '../helpers/shop-fixtures.mjs';
import { layoutIssues } from '../helpers/responsive.mjs';

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
    const issues = await layoutIssues(D.page, { touch, scope: sc.scope });
    const layout = issues.filter((x) => x.kind !== 'small-target' && x.kind !== 'unnamed'), small = issues.filter((x) => x.kind === 'small-target');
    const unnamed = issues.filter((x) => x.kind === 'unnamed');
    R.check(`[${size}] ${sc.name}: fits the screen`, layout.length === 0, layout.slice(0, 6));
    R.check(`[${size}] ${sc.name}: every control has a name a screen reader can say`, unnamed.length === 0, unnamed.slice(0, 8));
    if(touch) R.check(`[${size}] ${sc.name}: touch targets of 24 px or more`, small.length === 0, small.slice(0, 8));
  }
  await D.run('closeModal();closeSheets()').catch(() => {});
}
await R.done(() => S.close());
