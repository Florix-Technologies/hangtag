// RecordStockOperation: stock in (pieces received, optional cost) or stock adjustment (counted number, with a reason).
import { store } from '../../../shared/state/store.js';
import { buildStockMoves, buildTrackedMoves, stockInNote } from '../../../domain/inventory/stock-operation.js';
import { batchOf, expiryKept, serialState, today, trackingOfP } from '../services/tracking.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { vCost } from '../../../domain/catalog/variants.js';
import { vRec } from '../services/ledger.js';
import { stockOf } from '../services/stock.js';
import { stockRepository } from '../repositories/stock-repository.js';
import { uid } from '../../../shared/utils/ids.js';
import { sumQty } from '../../../domain/catalog/units.js';
import { prod } from '../../products/services/catalog.js';
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
  const built=buildStockMoves({kind:op.kind,productId:op.productId,values:op.values,costRaw:op.costRaw,reason:op.reason,note,now:Date.now(),deviceId:store.dev,unit:(prod(op.productId)||{}).unit},stockOf,()=>"m"+uid());
  if(built.error)return {error:built.error};
  const costChanged=[];   // the variants whose cost price this stock-in changed (uploaded as just those)
  if(!adj&&built.cost!=null&&op.setCost&&!can("manage_products")) return {error:notAllowedText("change cost prices")+" Untick the cost price box."};
  if(!adj&&built.cost!=null&&op.setCost){ built.moves.forEach(m=>{const r=vRec(m.v);if(r&&vCost(r.p,r.v)!==built.cost){r.v.cost=built.cost;costChanged.push(r.v.id)}}); }
  stockRepository().record({moves:built.moves,changedProductId:costChanged.length?op.productId:null,changedVariantIds:costChanged});
  return {moves:built.moves,pieces:sumQty(built.moves.map(m=>m.q))};
}

/* Stock in / adjustment of a product tracked by serial number or batch (domain buildTrackedMoves): op as above, with rows
   instead of values (serials typed, serials written off, batch number / expiry / quantity, or counted per batch).
   → { error } or { moves, pieces } */
export function recordTrackedStockOperation(op){
  const no=denied("manage_inventory","add or adjust stock"); if(no) return no;
  const p=prod(op.productId); if(!p) return {error:"That product isn't in the catalog any more."};
  const adj=op.kind==="adjust";
  if(!adj&&op.received&&op.received>dayKey(Date.now())) return {error:"The date received can't be in the future."};
  const costRaw=adj?"":String(op.costRaw||"").trim(), cost=costRaw===""?null:Math.round(+costRaw);
  if(cost!=null&&(isNaN(cost)||cost<0)) return {error:"Enter a valid cost per piece, or leave it empty."};
  if(!adj&&cost!=null&&op.setCost&&!can("manage_products")) return {error:notAllowedText("change cost prices")+" Untick the cost price box."};
  const note=adj?op.note:stockInNote({supplier:op.supplier,ref:op.ref,received:op.received,note:op.note,today:dayKey(Date.now())});
  const b=buildTrackedMoves({kind:op.kind,productId:p.id,tracking:trackingOfP(p),expiry:expiryKept(p),unit:p.unit,cost,reason:op.reason,note,now:Date.now(),deviceId:store.dev,today:today()},
    op.rows,{serialState,batchOf},()=>"m"+uid());
  if(b.error) return b;
  const costChanged=[];
  if(!adj&&cost!=null&&op.setCost) b.moves.forEach(m=>{const r=vRec(m.v);if(r&&vCost(r.p,r.v)!==cost){r.v.cost=cost;if(!costChanged.includes(r.v.id))costChanged.push(r.v.id)}});
  stockRepository().record({moves:b.moves,changedProductId:costChanged.length?p.id:null,changedVariantIds:costChanged});
  return {moves:b.moves,pieces:sumQty(b.moves.map(m=>m.q))};
}
