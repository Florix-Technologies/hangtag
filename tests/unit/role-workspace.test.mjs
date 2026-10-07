// Role intelligence (src/domain/shop/role-workspace.js): what each role's day is about — the owner's sales, profit, GST,
// cash, bank, inventory, Agent and team; a manager's sales, stock, customers, orders, purchases and Agent; a cashier's
// selling, bills, customers and held bills; a server's tables, orders and kitchen — and so its bar (desktop and phone),
// its Home sections and what Business today shows it. A member the owner gave more than its role's defaults also gets
// what those permissions open. The phone bar (mobile-workflow.js) follows the same bar. Run: npm run test:unit
import { HOME_SECTIONS, ROLE_BAR, ROLE_FOCUS, businessScope, homeSections, roleBar } from '../../src/domain/shop/role-workspace.js';
import { phoneBarFor } from '../../src/domain/shop/mobile-workflow.js';
import { ROLE_DEFAULTS } from '../../src/domain/shop/permissions.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); } };
const J = (x) => JSON.stringify(x);

check('what each role\'s day is about, as the plan says', J(ROLE_FOCUS.owner) === J(['sales', 'profit', 'gst', 'cash', 'bank', 'inventory', 'agent', 'team'])
  && J(ROLE_FOCUS.manager) === J(['sales', 'stock', 'customers', 'orders', 'purchases', 'agent']) && J(ROLE_FOCUS.cashier) === J(['sell', 'bills', 'customers', 'held'])
  && J(ROLE_FOCUS.server) === J(['tables', 'orders', 'kitchen']), ROLE_FOCUS);

console.log('--- the bar ---');
check('the owner and a manager: the shop\'s usual bar (Home · Sell · Bills · Stock · Customers · Reports)', J(roleBar('owner')) === J(['home', 'sell', 'bills', 'stock', 'customers', 'report'])
  && J(roleBar('manager', ROLE_DEFAULTS.manager)) === J(roleBar('owner')));
check('a cashier: Home · Sell · Bills · Customers (stock is looked up from Sell, or More)', J(roleBar('cashier', ROLE_DEFAULTS.cashier)) === J(['home', 'sell', 'bills', 'customers']), roleBar('cashier', ROLE_DEFAULTS.cashier));
check('a server: Home · Tables · Orders · Kitchen — not Stock or Customers', J(roleBar('server', ROLE_DEFAULTS.server)) === J(['home', 'tables', 'orders', 'kitchen']), roleBar('server', ROLE_DEFAULTS.server));
check('the kitchen: its screen first', roleBar('kitchen', ROLE_DEFAULTS.kitchen)[0] === 'kitchen');
check('a cashier the owner let see reports: Reports joins the bar after its own', J(roleBar('cashier', [...ROLE_DEFAULTS.cashier, 'view_reports'])) === J(['home', 'sell', 'bills', 'customers', 'report']));
check('an unknown role is treated as the owner\'s bar (presentation only; permissions still decide)', J(roleBar('auditor')) === J(roleBar('owner')));

console.log('--- the phone bar ---');
check('owner: Home · Sell · Bills · Stock (four fit), More has the rest', J(phoneBarFor('owner', ['home', 'sell', 'bills', 'stock', 'customers', 'report', 'settings'])) === J(['home', 'sell', 'bills', 'stock']));
check('cashier: Home · Sell · Bills · Customers', J(phoneBarFor('cashier', ['home', 'sell', 'bills', 'customers', 'orders', 'stock', 'settings'])) === J(['home', 'sell', 'bills', 'customers']));
check('server: Home · Tables · Orders (no kitchen screen for its role) — the next module fills a place it lacks', J(phoneBarFor('server', ['tables', 'orders', 'home', 'settings'])) === J(['home', 'tables', 'orders']));
check('...never Settings as a tab', !phoneBarFor('kitchen', ['kitchen', 'settings']).includes('settings'));

console.log('--- Home ---');
check('owner: the morning briefing, Business today, then GST, bank and cash, the team; then what needs attention, the Agent, bills, the 7 days', J(homeSections('owner')) === J(['briefing', 'business', 'owner', 'attention', 'agent', 'bills', 'trend']));
check('manager: Business today, then orders, purchases and stock to act on', J(homeSections('manager', ROLE_DEFAULTS.manager)) === J(['business', 'ops', 'attention', 'agent', 'bills', 'trend']));
check('cashier: my shift, held bills, what needs me, bills, customers — no business figures', J(homeSections('cashier', ROLE_DEFAULTS.cashier)) === J(['shift', 'held', 'attention', 'bills', 'customers']));
check('server: the tables now and what needs them', J(homeSections('server', ROLE_DEFAULTS.server)) === J(['tables', 'attention']));
check('a cashier the owner let see reports also gets Business today, the Agent and the 7 days (after its own)', J(homeSections('cashier', [...ROLE_DEFAULTS.cashier, 'view_reports'])) === J(['shift', 'held', 'attention', 'bills', 'customers', 'business', 'agent', 'trend']));
check('a server allowed to sell gets the shift, held bills and bills', J(homeSections('server', [...ROLE_DEFAULTS.server, 'create_sale'])) === J(['tables', 'attention', 'shift', 'held', 'bills']));
check('every role has its sections', Object.keys(ROLE_BAR).every((r) => Array.isArray(HOME_SECTIONS[r]) && HOME_SECTIONS[r].length));

console.log('--- Business today ---');
check('the owner: everything (profit, the money split and reconciliation)', J(businessScope('owner')) === J({ profit: true, money: true, position: true }));
check('a manager: sales, what customers owe and the stock — profit and money stay in Reports', J(businessScope('manager', ROLE_DEFAULTS.manager)) === J({ profit: false, money: false, position: true }));
check('a cashier: plain sales figures only', J(businessScope('cashier', ROLE_DEFAULTS.cashier)) === J({}));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
