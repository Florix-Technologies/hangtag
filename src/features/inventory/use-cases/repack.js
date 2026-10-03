// Repack (domain/inventory/repack.js): open a sack or carton into loose units. One conversion = two stock records (the
// source out, the target in at the source's cost spread over the new units), saved here at once and uploaded together
// (RPC hangtag_save_repack, which checks the stock again). The conversion is remembered on the source product so next
// time only the quantity is asked. A team member needs manage_inventory (remembering it: manage_products).
import { cleanRepacks, repackPlan, repackRecord } from '../../../domain/inventory/repack.js';
import { vCost, vLabel } from '../../../domain/catalog/variants.js';
import { store } from '../../../shared/state/store.js';
import { uid } from '../../../shared/utils/ids.js';
import { can, denied } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { productRepository } from '../../products/repositories/product-repository.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { vRec } from '../services/ledger.js';
import { stockOf } from '../services/stock.js';
import { batchesOf, trackingOfP } from '../services/tracking.js';

export const usesRepack = () => hasCap("uses_repack");
/* The conversions saved on a product's variants: [{ f, t, per, to: { p, v } }] */
export function repacksOf(p){
  return cleanRepacks(p && p.repack).map(r => ({ ...r, to: vRec(r.t) })).filter(r => r.to);
}
const side = r => ({ p: r.p.id, v: r.v.id, unit: r.p.unit, name: r.p.name + (vLabel(r.v) ? " " + vLabel(r.v) : ""), tracking: trackingOfP(r.p), cost: vCost(r.p, r.v) });
/* What a conversion would do (nothing saved) → { plan } or { error } */
export function previewRepack({ fromV, toV, q, per }){
  const f = vRec(fromV), t = vRec(toV);
  if(!f || !t) return { error: "Choose what is opened and what it becomes." };
  const from = side(f), batch = from.tracking === "batch" ? batchesOf(fromV).find(b => b.qty >= +q) || null : null;
  const plan = repackPlan({ id: "preview", from, to: side(t), q, per, available: stockOf(fromV), batch: batch ? { b: batch.b, exp: batch.exp } : null, t: Date.now(), dev: store.dev });
  return plan.error ? plan : { plan, from, to: side(t) };
}
/* x: { fromV, toV, q, per, remember } → { record } or { error } */
export function repackStock(x){
  const no = denied("manage_inventory", "repack stock"); if(no) return no;
  if(!usesRepack()) return { error: "Repack is switched off for this shop. Switch it on in Settings → Capabilities." };
  const f = vRec(x.fromV), t = vRec(x.toV); if(!f || !t) return { error: "Choose what is opened and what it becomes." };
  const from = side(f), to = side(t), tt = Date.now(), id = "rp" + uid();
  const batch = from.tracking === "batch" ? batchesOf(x.fromV).find(b => b.qty >= +x.q) : null;
  if(from.tracking === "batch" && !batch) return { error: `No single batch of ${from.name} has ${x.q} in stock. Open a smaller amount.` };
  const input = { id, from, to, q: x.q, per: x.per, available: stockOf(x.fromV), batch: batch ? { b: batch.b, exp: batch.exp } : null, t: tt, dev: store.dev };
  const plan = repackPlan(input); if(plan.error) return plan;
  const record = { ...repackRecord(input, plan), moves: plan.moves };
  bizRepository().repack(record);
  // remembered on the source product for next time (only someone who may edit products changes the product)
  if(x.remember !== false && can("manage_products")){
    const list = cleanRepacks(f.p.repack), at = list.findIndex(r => r.f === x.fromV && r.t === x.toV);
    if(at < 0 || list[at].per !== +x.per){
      const next = at < 0 ? [...list, { f: x.fromV, t: x.toV, per: +x.per }] : list.map((r, i) => i === at ? { ...r, per: +x.per } : r);
      productRepository().save({ product: { ...f.p, repack: next }, isNew: false, renamed: false, newMoves: [], deletedVariantIds: [], image: undefined });
    }
  }
  renderSync(); flushSbQueue();
  return { record, plan };
}
