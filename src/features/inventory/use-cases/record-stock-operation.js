// RecordStockOperation: stock in (pieces received, optional cost) or stock adjustment (counted number, with a reason).
import { store } from '../../../shared/state/store.js';
import { buildStockMoves } from '../../../domain/inventory/stock-operation.js';
import { vCost } from '../../../domain/catalog/variants.js';
import { vRec } from '../services/ledger.js';
import { stockOf } from '../services/stock.js';
import { stockRepository } from '../repositories/stock-repository.js';
import { uid } from '../../../shared/utils/ids.js';

/* op: { kind:"in"|"adjust", productId, values:{ variantId: typed quantity }, costRaw, setCost, reason, note }
   setCost: for stock in with a cost, also make it the variants' cost price. Returns { error } or { moves, pieces }. */
export function recordStockOperation(op){
  const adj=op.kind==="adjust";
  const built=buildStockMoves({kind:op.kind,productId:op.productId,values:op.values,costRaw:op.costRaw,reason:op.reason,note:op.note,now:Date.now(),deviceId:store.dev},stockOf,()=>"m"+uid());
  if(built.error)return {error:built.error};
  let costChanged=false;
  if(!adj&&built.cost!=null&&op.setCost){ built.moves.forEach(m=>{const r=vRec(m.v);if(r&&vCost(r.p,r.v)!==built.cost){r.v.cost=built.cost;costChanged=true}}); }
  stockRepository().record({moves:built.moves,changedProductId:costChanged?op.productId:null});
  return {moves:built.moves,pieces:built.moves.reduce((a,m)=>a+m.q,0)};
}
