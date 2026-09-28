// A customer's completed bills (cancelled bills are left out), newest first, from the bills already on this device.
import { D } from '../../inventory/services/ledger.js';
import { lineLabel } from '../../../domain/catalog/variants.js';
import { payLabel } from '../../../domain/sales/payments.js';

/* → { bills: [{ id, no, t, kind, items: [{ name, label, q, price }], pieces, total, pay, returned (refunded), returnedPieces,
   returnedValue, creditNotes }], count, spent, last }
   spent: what the customer paid, less refunds (an exchange's credit is spent on its new bill, which counts instead) */
export function purchaseHistory(cid){
  const d = D(), refunds = {}, back = {};
  d.rets.forEach(r => { refunds[r.sale] = (refunds[r.sale] || 0) + (r.refund || 0);
    const b = back[r.sale] || (back[r.sale] = { q: 0, v: 0, cn: [] }); b.q += r.items.reduce((a, i) => a + i.q, 0); b.v += r.value || 0; if(r.no) b.cn.push(r.no); });
  const bills = d.sales.filter(s => !s.void && s.cust && s.cust.id === cid).sort((a, b) => b.t - a.t).map(s => ({
    id: s.id, no: s.no || "", t: s.t, kind: s.kind || "sale",
    items: s.items.map(i => ({ name: i.n, label: lineLabel(i), q: i.q, price: i.price })),
    pieces: s.items.reduce((a, i) => a + i.q, 0), total: s.total - (s.credit || 0),
    pay: payLabel(s), returned: refunds[s.id] || 0,
    returnedPieces: (back[s.id] || {}).q || 0, returnedValue: Math.round(((back[s.id] || {}).v || 0) * 100) / 100, creditNotes: (back[s.id] || {}).cn || [],
  }));
  return { bills, count: bills.length, spent: bills.reduce((a, b) => a + b.total - b.returned, 0), last: bills.length ? bills[0].t : 0 };
}
