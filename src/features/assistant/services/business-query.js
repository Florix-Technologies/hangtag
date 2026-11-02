// The read-only business query surface shared by Ask Hangtag and future intelligence views.
// It deliberately exposes queries only: no repository, save, delete, checkout or stock mutation is reachable here.
import { paymentSummary, profitSummary } from '../../../domain/reports/sales-report.js';
import { roundQty } from '../../../domain/catalog/units.js';
import { store } from '../../../shared/state/store.js';
import { addDays, dayKey } from '../../../shared/formatting/dates.js';
import { D } from '../../inventory/services/ledger.js';
import { periodData, netLines, kstats } from '../../reports/services/report-data.js';
import { outstandingAll } from '../../customers/services/customer-account.js';
import { suppliersList, supplierAccountOf } from '../../inventory/services/purchase-state.js';
import { liveProducts } from '../../products/services/catalog.js';
import { variantsOf, vCost, vPrice } from '../../../domain/catalog/variants.js';
import { stockOf } from '../../inventory/services/stock.js';
import { levelOf } from '../../inventory/services/stock-levels.js';
import { cashBookFor } from '../../finance/services/books-data.js';
import { accountBalances } from '../../finance/use-cases/bank-accounts.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';

const frozen = value => Object.freeze(value);

export function periodRangeFor(period, now = Date.now()){
  const today = dayKey(now);
  if(period === 'yesterday'){
    const day = addDays(today, -1);
    return frozen({ from: day, to: day, label: 'yesterday' });
  }
  if(period === 'month') return frozen({ from: today.slice(0, 8) + '01', to: today, label: 'this month' });
  if(period === '30d') return frozen({ from: addDays(today, -29), to: today, label: 'the last 30 days' });
  if(period === '7d') return frozen({ from: addDays(today, -6), to: today, label: 'the last 7 days' });
  if(period === 'lastmonth'){ const first = today.slice(0, 8) + '01', end = addDays(first, -1); return frozen({ from: end.slice(0, 8) + '01', to: end, label: 'last month' }); }
  return frozen({ from: today, to: today, label: 'today' });
}

function productRows(lines, metric){
  const rows = new Map();
  lines.forEach(line => {
    const id = line.pid || line.vid || line.name;
    const row = rows.get(id) || { id, name: line.name || 'Product', quantity: 0, sales: 0, coveredSales: 0, cost: 0, profit: 0, complete: true };
    row.quantity = roundQty(row.quantity + (+line.q || 0));
    row.sales = Math.round((row.sales + (+line.amt || 0)) * 100) / 100;
    if(line.cost == null) row.complete = false;
    else{
      row.coveredSales = Math.round((row.coveredSales + (+line.rev || 0)) * 100) / 100;
      row.cost = Math.round((row.cost + (+line.cost || 0)) * 100) / 100;
      row.profit = Math.round((row.coveredSales - row.cost) * 100) / 100;
    }
    rows.set(id, row);
  });
  const key = metric === 'profit' ? 'profit' : metric === 'sales' ? 'sales' : 'quantity';
  return [...rows.values()].filter(r => r.quantity > 0).sort((a, b) => b[key] - a[key] || b.quantity - a.quantity || a.name.localeCompare(b.name));
}

function dueRows(){
  const due = outstandingAll(), customers = store.customers || {};
  return Object.entries(due).filter(([, amount]) => +amount > 0).map(([id, amount]) => ({
    id,
    name: customers[id] && customers[id].name || 'Customer',
    amount: +amount,
  })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

/*
  inventory(): supplied by Smart Inventory at composition time. Keeping it behind this callback means the assistant
  consumes the same recommendation model and never grows a second reorder calculation.
*/
export function createReadOnlyBusinessQuery({ now = () => Date.now(), inventory = () => [] } = {}){
  const records = period => {
    const range = periodRangeFor(period, now());
    const data = periodData(range.from, range.to, '');
    return { range, ...data };
  };
  const api = {
    sales(period = 'today'){
      const x = records(period);
      return frozen({ ...x.range, ...kstats(x.live, x.rets) });
    },
    profit(period = 'today'){
      const x = records(period), result = profitSummary(netLines(x.live, x.rets));
      return frozen({ ...x.range, ...result });
    },
    payments(period = 'today'){
      const x = records(period), result = paymentSummary(x.live, x.rets);
      return frozen({ ...x.range, ...result, methods: frozen(result.methods) });
    },
    products(period = '30d', metric = 'quantity', limit = 5){
      const x = records(period);
      return frozen(productRows(netLines(x.live, x.rets), metric).slice(0, Math.max(1, Math.min(20, +limit || 5))).map(frozen));
    },
    dues(){
      const rows = dueRows(), total = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
      return frozen({ total, customers: rows.length, rows: frozen(rows.map(frozen)) });
    },
    inventory(kind = 'reorder', limit = 8){
      const rows = inventory(kind) || [];
      return frozen(rows.slice(0, Math.max(1, Math.min(30, +limit || 8))).map(row => frozen({ ...row })));
    },
    /* what the shop owes its suppliers (posted purchases not fully paid) */
    supplierDues(){
      const rows = suppliersList(true).map(x => ({ name: x.name || 'Supplier', amount: supplierAccountOf(x.id).outstanding })).filter(r => r.amount > 0.004)
        .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
      return frozen({ total: Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100, suppliers: rows.length, rows: frozen(rows.map(frozen)) });
    },
    /* what is on the shelf: pieces, value at selling price and at cost, variants low and sold out */
    stock(){
      let pieces = 0, value = 0, cost = 0, costKnown = true, low = 0, out = 0;
      const ps = liveProducts();
      ps.forEach(p => variantsOf(p).forEach(v => { const l = stockOf(v.id), n = Math.max(0, l); pieces = roundQty(pieces + n); value += n * vPrice(p, v); const c = vCost(p, v); if(c == null){ if(n) costKnown = false; } else cost += n * c; const lv = levelOf(l, p); if(lv === 'out') out++; else if(lv === 'low') low++; }));
      return frozen({ products: ps.length, pieces, value: Math.round(value * 100) / 100, cost: Math.round(cost * 100) / 100, costKnown, low, out });
    },
    /* purchase orders still to be received */
    purchaseOrders(){
      const open = bizRepository().list('po').filter(o => o && (o.status === 'draft' || o.status === 'sent'));
      const value = open.reduce((a, o) => a + (o.items || []).reduce((b, l) => b + (+l.q || 0) * (+l.price || 0), 0), 0);
      return frozen({ open: open.length, sent: open.filter(o => o.status === 'sent').length, drafts: open.filter(o => o.status === 'draft').length, value: Math.round(value * 100) / 100 });
    },
    /* quotations and sales orders still open */
    orders(){
      const all = Object.values(store.orders || {}).filter(Boolean);
      const quotes = all.filter(o => o.kind === 'quote' && ['draft', 'sent'].includes(o.status)), sales = all.filter(o => o.kind === 'sales' && !['completed', 'cancelled'].includes(o.status));
      const value = list => Math.round(list.reduce((a, o) => a + (+o.total || 0), 0) * 100) / 100;
      return frozen({ quotes: quotes.length, quoteValue: value(quotes), sales: sales.length, salesValue: value(sales), mobile: sales.filter(o => o.source === 'customer').length });
    },
    /* returns in a period: how many and their value */
    returns(period = 'today'){
      const x = records(period), k = kstats(x.live, x.rets);
      return frozen({ ...x.range, count: x.rets.length, value: k.returns || 0 });
    },
    /* cash spent from the drawer in a period, by category */
    expenses(period = 'today'){
      const range = periodRangeFor(period, now()), cats = {};
      const all = Object.values(store.cashMoves || {}), reversed = new Set(all.filter(m => m.type === 'reversal').map(m => m.reverses));
      let total = 0;
      all.forEach(m => { if(m.type !== 'expense' || reversed.has(m.id)) return; const d = dayKey(m.t); if(d < range.from || d > range.to) return; total += +m.amount || 0; cats[m.category || 'Other'] = (cats[m.category || 'Other'] || 0) + (+m.amount || 0); });
      return frozen({ ...range, total: Math.round(total * 100) / 100, rows: frozen(Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([name, amount]) => frozen({ name, amount: Math.round(amount * 100) / 100 }))) });
    },
    /* GST on the bills of a period */
    gst(period = 'month'){
      const x = records(period), k = kstats(x.live, x.rets);
      return frozen({ ...x.range, gst: k.gst || 0, cgst: k.cgst || 0, sgst: k.sgst || 0, igst: k.igst || 0, taxable: k.netSales || 0 });
    },
    /* the shop's bank accounts and their balances */
    banks(){
      const B = accountBalances();
      return frozen({ total: B.total, rows: frozen(B.rows.filter(r => r.account.active !== false).map(r => frozen({ name: r.account.name, amount: r.balance }))) });
    },
    /* cash the drawer should hold today */
    cashInHand(){
      const today = dayKey(now()), B = cashBookFor(today, today);
      return frozen({ closing: B.closing, opening: B.opening, in: (B.cashSales || 0) + (B.cashIn || 0) + (B.openingFloat || 0), out: (B.refunds || 0) + (B.cashOut || 0) + (B.expenses || 0) });
    },
    describe(){
      return frozen(['sales', 'profit', 'payments', 'products', 'dues', 'inventory', 'supplierDues', 'stock', 'purchaseOrders', 'orders', 'returns', 'expenses', 'gst', 'banks', 'cashInHand']);
    },
  };
  return frozen(api);
}

export const businessDataVersion = () => {
  const d = D();
  return `${d.sales.length}:${d.rets.length}:${Object.keys(store.moves || {}).length}:${Object.keys(store.collections || {}).length}`;
};
