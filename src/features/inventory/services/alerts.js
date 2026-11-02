// What needs restocking and what is expiring, worked out once for every place that shows it: the stock page, Home →
// Needs attention, the Hangtag Agent and Automation's watchers (features/automation/services/watchers.js).
import { liveProducts } from '../../products/services/catalog.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { stockOf } from './stock.js';
import { levelOf } from './stock-levels.js';
import { vRec } from './ledger.js';
import { allBatches, expiryOf } from './tracking.js';

/* Variants running low or sold out: [{ p, v, n, level: "low" | "out" }], fewest first */
export function stockAlerts(){
  const out = [];
  liveProducts().forEach(p => variantsOf(p).forEach(v => { const n = stockOf(v.id), lv = levelOf(n, p); if(lv !== "ok") out.push({ p, v, n, level: lv }); }));
  return out.sort((a, b) => a.n - b.n);
}
/* Batches that have expired or expire soon, with stock (the shop's warning period: settings.expiryDays) */
export function expiryAlerts(){
  return allBatches().filter(b => b.qty > 0 && b.exp && vRec(b.vid)).map(b => ({ b, x: expiryOf(b.exp), r: vRec(b.vid) })).filter(a => a.x === "expired" || a.x === "soon")
    .sort((a, b) => a.b.exp.localeCompare(b.b.exp));
}
