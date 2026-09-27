// A customer's completed bills (cancelled bills are left out), newest first, from the bills already on this device.
import { D } from '../../inventory/services/ledger.js';
import { lineLabel } from '../../../domain/catalog/variants.js';
import { payLabel } from '../../../domain/sales/payments.js';

/* → { bills: [{ id, no, t, kind, items: [{ name, label, q, price }], pieces, total, pay, returned }], count, spent, last } */
export function purchaseHistory(cid){
  const d = D(), refunds = {};
  d.rets.forEach(r => { refunds[r.sale] = (refunds[r.sale] || 0) + (r.refund || 0); });
  const bills = d.sales.filter(s => !s.void && s.cust && s.cust.id === cid).sort((a, b) => b.t - a.t).map(s => ({
    id: s.id, no: s.no || "", t: s.t, kind: s.kind || "sale",
    items: s.items.map(i => ({ name: i.n, label: lineLabel(i), q: i.q, price: i.price })),
    pieces: s.items.reduce((a, i) => a + i.q, 0), total: s.total - (s.credit || 0),
    pay: payLabel(s), returned: refunds[s.id] || 0,
  }));
  return { bills, count: bills.length, spent: bills.reduce((a, b) => a + b.total - b.returned, 0), last: bills.length ? bills[0].t : 0 };
}
