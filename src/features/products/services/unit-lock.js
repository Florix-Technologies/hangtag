// A product's unit is pinned once it has history. Its stock records, bills and returns, and the open orders and purchase
// orders naming it, were counted in that unit, and no quantity is ever re-read in another: 12.5 kg doesn't become 13
// pieces. To sell it in another unit, the shop adds a new product and moves the stock across with Repack.
import { store } from '../../../shared/state/store.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { isFinal } from '../../../domain/orders/orders.js';
import { hasHistory, hasMoves } from '../../inventory/services/ledger.js';

const OPEN_PO = ["draft", "sent"];

/* Why the saved product's unit can't change now (a phrase that follows "it": "has stock records"), or "" when it can */
export function unitLock(p){
  if(!p) return "";
  const ids = variantsOf(p, true).map(v => v.id), mine = new Set(ids);
  if(ids.some(hasMoves)) return "has stock records";
  if(ids.some(hasHistory)) return "is on bills";
  const names = l => !!l && (l.p === p.id || mine.has(l.v));
  if(Object.values(store.orders || {}).some(o => o && !isFinal(o) && (o.items || []).some(names))) return "is on an open order";
  if(Object.values(((store.biz || {}).po) || {}).some(po => po && OPEN_PO.includes(po.status) && (po.items || []).some(names))) return "is on an open purchase order";
  return "";
}
