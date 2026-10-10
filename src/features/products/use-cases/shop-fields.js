// The shop's own product fields and units (domain/catalog/attributes.js and units.js, schema.sql section 3z): made,
// changed, archived and removed by someone who may manage products (the database checks it too). A choice renamed is
// renamed on every product using it, its variants included; a field or unit products use is archived, never removed,
// and keeps its kind or decimals.
import { attrUsage, checkAttrDef, renameAttrValues } from '../../../domain/catalog/attributes.js';
import { checkShopUnit } from '../../../domain/catalog/units.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied } from '../../shop/services/access.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { products } from '../services/catalog.js';
import { productRepository } from '../repositories/product-repository.js';
import { attrById, refreshShopUnits, shopAttrs, shopUnitList } from '../services/shop-fields.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';

const upload = () => { renderSync(); flushSbQueue(); };
const keepChoices = a => (a.options || []).map(o => ({ was: o, now: o }));

/* A field made (no id) or changed. input: as checkAttrDef takes it; choices of a saved field as [{ was, now }].
   → { attr, renamed: products changed by a renamed choice } or { error } (nothing saved) */
export function saveAttr(input){
  const no = denied("manage_products", "change product fields"); if(no) return no;
  const before = input && input.id ? attrById(input.id) : null;
  if(input && input.id && !before) return { error: "That field isn't on this device any more." };
  const all = products();
  // a new field goes last (the shop's order: the editor, the template and the export follow it)
  const sort = input && input.sort != null ? input.sort : before ? before.sort : shopAttrs().reduce((m, a) => Math.max(m, a.sort + 1), 0);
  const r = checkAttrDef({ ...input, sort, id: before ? before.id : "at" + uid() }, { attrs: shopAttrs(), before, usage: attrUsage(all, before) });
  if(r.error) return r;
  // the products using a renamed choice change with it (each goes up as an edit of its own)
  const changed = renameAttrValues(all, r.attr, r.renames);
  changed.forEach(p => productRepository().save({ product: p, isNew: false, renamed: false, newMoves: [], deletedVariantIds: [] }));
  const attr = bizRepository().save("at", { ...r.attr, t: before && before.t || Date.now() });
  upload();
  return { attr, renamed: changed.length };
}
/* Archived: hidden from products that don't use it, its values kept; restored: in use again */
export function setAttrArchived(id, on){
  const a = attrById(id); if(!a) return { error: "That field isn't on this device any more." };
  return saveAttr({ ...a, options: keepChoices(a), archived: !!on });
}
/* Removed: only a field no product uses (otherwise archive it) */
export function removeAttr(id){
  const no = denied("manage_products", "change product fields"); if(no) return no;
  const a = attrById(id); if(!a) return { error: "That field isn't on this device any more." };
  const used = attrUsage(products(), a).products;
  if(used) return { error: `${a.name} is used by ${used} product${used === 1 ? "" : "s"}: archive it instead, so their values are kept.` };
  bizRepository().remove("at", id); upload();
  return { ok: true };
}
/* Fields in a new order: ids as shown, first to last */
export function orderAttrs(ids){
  const no = denied("manage_products", "change product fields"); if(no) return no;
  (ids || []).forEach((id, k) => { const a = attrById(id); if(a && a.sort !== k) bizRepository().save("at", { ...a, sort: k, t: a.t || Date.now() }); });
  upload();
  return { ok: true };
}

const unitUsers = id => products().filter(p => p.unit === id).length;
/* A unit of the shop's own, made (no id) or changed → { unit } or { error } */
export function saveUnit(input){
  const no = denied("manage_products", "change units"); if(no) return no;
  const before = input && input.id ? shopUnitList().find(u => u.id === input.id) || null : null;
  if(input && input.id && !before) return { error: "That unit isn't on this device any more." };
  const r = checkShopUnit(input, { units: shopUnitList(), before, used: before ? unitUsers(before.id) : 0 });
  if(r.error) return r;
  const unit = bizRepository().save("un", { ...r.unit, t: before && before.t || Date.now() });
  refreshShopUnits(); upload();
  return { unit };
}
export function setUnitArchived(id, on){
  const u = shopUnitList().find(x => x.id === id); if(!u) return { error: "That unit isn't on this device any more." };
  return saveUnit({ ...u, archived: !!on });
}
/* Removed: only a unit no product is sold in (otherwise archive it) */
export function removeUnit(id){
  const no = denied("manage_products", "change units"); if(no) return no;
  const u = shopUnitList().find(x => x.id === id); if(!u) return { error: "That unit isn't on this device any more." };
  const used = unitUsers(id);
  if(used) return { error: `${u.label} is used by ${used} product${used === 1 ? "" : "s"}: archive it instead.` };
  bizRepository().remove("un", id); refreshShopUnits(); upload();
  return { ok: true };
}
