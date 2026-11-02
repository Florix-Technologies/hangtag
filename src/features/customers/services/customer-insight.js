// A customer's bills, returns and account, gathered for domain/customers/customer-insight.js (what their bills say about
// them). Read-only, from the records on this device, through the calculations the app already uses: report lines
// (reports/services/report-data.js) for products and sizes, payments as recorded on each bill, the credit account.
import { D } from '../../inventory/services/ledger.js';
import { netLines } from '../../reports/services/report-data.js';
import { customerInsight } from '../../../domain/customers/customer-insight.js';
import { dueAmtOf, paymentsOf } from '../../../domain/sales/payments.js';
import { accountOf } from './customer-account.js';
import { custStats } from './customer-stats.js';

/* → { summary, products, payments, insights } (domain/customers/customer-insight.js) */
export function customerInsightOf(cid, now = Date.now()){
  const d = D(), bills = d.sales.filter(s => !s.void && s.cust && s.cust.id === cid), ids = new Set(bills.map(s => s.id));
  const rets = d.rets.filter(r => ids.has(r.sale));
  const billsIn = bills.map(s => ({ id: s.id, no: s.no || "", t: s.t, total: (+s.total || 0) - (+s.credit || 0),
    lines: netLines([s], []).map(l => ({ pid: l.pid, name: l.name, size: l.s || "", q: l.q, amt: l.amt })),
    payments: paymentsOf(s).map(p => ({ method: p.method, amount: +p.amount || 0 })), due: dueAmtOf(s) }));
  const retsIn = rets.map(r => ({ t: r.t, saleId: r.sale, pieces: (r.items || []).reduce((a, i) => a + (+i.q || 0), 0), value: +r.value || 0,
    lines: netLines([], [r]).map(l => ({ pid: l.pid, name: l.name, q: -l.q, amt: -l.amt })) }));
  const peers = Object.entries(custStats()).filter(([id]) => id !== cid).map(([, o]) => o.total);
  return customerInsight({ bills: billsIn, returns: retsIn, account: accountOf(cid), peers, now });
}
