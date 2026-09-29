// RecordStockOperation: stock in (pieces received, optional cost) or stock adjustment (counted number, with a reason).
import { store } from '../../../shared/state/store.js';
import { buildStockMoves, stockInNote } from '../../../domain/inventory/stock-operation.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { vCost } from '../../../domain/catalog/variants.js';
import { vRec } from '../services/ledger.js';
import { stockOf } from '../services/stock.js';
import { stockRepository } from '../repositories/stock-repository.js';
import { uid } from '../../../shared/utils/ids.js';
import { can, denied, notAllowedText } from '../../shop/services/access.js';

/* op: { kind:"in"|"adjust", productId, values:{ variantId: typed quantity }, costRaw, setCost, reason, note,
   supplier?, ref?, received? ("yyyy-mm-dd": stock in only, kept in the move's note) }
   setCost: for stock in with a cost, also make it the variants' cost price. Returns { error } or { moves, pieces }.
   A team member needs manage_inventory (and manage_products to change cost prices): refused before anything changes. */
export function recordStockOperation(op){
  const no=denied("manage_inventory","add or adjust stock"); if(no) return no;
  const adj=op.kind==="adjust";
  if(!adj&&op.received&&op.received>dayKey(Date.now())) return {error:"The date received can't be in the future."};
  const note=adj?op.note:stockInNote({supplier:op.supplier,ref:op.ref,received:op.received,note:op.note,today:dayKey(Date.now())});
  const built=buildStockMoves({kind:op.kind,productId:op.productId,values:op.values,costRaw:op.costRaw,reason:op.reason,note,now:Date.now(),deviceId:store.dev},stockOf,()=>"m"+uid());
  if(built.error)return {error:built.error};
  let costChanged=false;
  if(!adj&&built.cost!=null&&op.setCost&&!can("manage_products")) return {error:notAllowedText("change cost prices")+" Untick the cost price box."};
  if(!adj&&built.cost!=null&&op.setCost){ built.moves.forEach(m=>{const r=vRec(m.v);if(r&&vCost(r.p,r.v)!==built.cost){r.v.cost=built.cost;costChanged=true}}); }
  stockRepository().record({moves:built.moves,changedProductId:costChanged?op.productId:null});
  return {moves:built.moves,pieces:built.moves.reduce((a,m)=>a+m.q,0)};
}
