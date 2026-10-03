// ConfirmStockCount: the counts typed on Inventory → Stock count become ADJUST stock records (note "Stock count: <reason>"),
// one per variant whose count differs from the records, through the stock repository; the database logs each in the audit
// log. Nothing is saved when a counted variant's records changed after the review. A team member needs manage_inventory.
import { store } from '../../../shared/state/store.js';
import { countDiffs, countMoves } from '../../../domain/inventory/stock-count.js';
import { stockOf } from '../services/stock.js';
import { batchQty } from '../services/tracking.js';
import { stockRepository } from '../repositories/stock-repository.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied } from '../../shop/services/access.js';

/* rows: [{ vid, pid, system (as reviewed), dec?, key?, b? (a batch: its own row) }] · typed: { key or vid: counted } · reason, note
   → { error, vid?, moved? } or { moves, counted, changed } */
export function confirmStockCount({ rows, typed, reason, note }){
  const no=denied("manage_inventory","count stock"); if(no) return no;
  const d=countDiffs(rows,typed); if(d.error) return d;
  if(!d.counted) return {error:"Type the counted quantity of at least one item."};
  const m=countMoves(d.changed,{reason,note,now:Date.now(),dev:store.dev,newId:()=>"m"+uid(),currentStock:(vid,b)=>b?batchQty(vid,b):stockOf(vid)});
  if(m.error) return m;
  stockRepository().record({moves:m.moves});
  return {moves:m.moves,counted:d.counted,changed:m.moves.length};
}
