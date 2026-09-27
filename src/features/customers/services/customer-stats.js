// Customer purchase totals.
import { D } from '../../inventory/services/ledger.js';

/* ================= customers (optional, never slows a sale down) ================= */

export function custStats(){
  const m={}; D().sales.forEach(s=>{ if(s.void||!s.cust||!s.cust.id) return; const o=m[s.cust.id]||(m[s.cust.id]={bills:0,total:0,last:0}); o.bills++; o.total+=s.total-(s.credit||0); o.last=Math.max(o.last,s.t); });
  D().rets.forEach(r=>{ const s=D().saleById[r.sale]; if(s&&s.cust&&s.cust.id&&m[s.cust.id]) m[s.cust.id].total-=r.refund||0; });
  return m;
}
