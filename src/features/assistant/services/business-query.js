// The read-only business query surface shared by Ask Hangtag and future intelligence views.
// It deliberately exposes queries only: no repository, save, delete, checkout or stock mutation is reachable here.
import { paymentSummary, profitSummary } from '../../../domain/reports/sales-report.js';
import { roundQty } from '../../../domain/catalog/units.js';
import { store } from '../../../shared/state/store.js';
import { addDays, dayKey } from '../../../shared/formatting/dates.js';
import { D } from '../../inventory/services/ledger.js';
import { periodData, netLines, kstats } from '../../reports/services/report-data.js';
import { outstandingAll } from '../../customers/services/customer-account.js';

const frozen = value => Object.freeze(value);

export function periodRangeFor(period, now = Date.now()){
  const today = dayKey(now);
  if(period === 'yesterday'){
    const day = addDays(today, -1);
    return frozen({ from: day, to: day, label: 'yesterday' });
  }
  if(period === 'month') return frozen({ from: today.slice(0, 8) + '01', to: today, label: 'this month' });
  if(period === '30d') return frozen({ from: addDays(today, -29), to: today, label: 'the last 30 days' });
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
    describe(){
      return frozen(['sales', 'profit', 'payments', 'products', 'dues', 'inventory']);
    },
  };
  return frozen(api);
}

export const businessDataVersion = () => {
  const d = D();
  return `${d.sales.length}:${d.rets.length}:${Object.keys(store.moves || {}).length}:${Object.keys(store.collections || {}).length}`;
};
