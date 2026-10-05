// SaveKit: a kit (domain/catalog/bundles.js) is an ordinary product with one variant (its price, SKU and barcode, so it
// scans and sells like anything else) and its items. It never has stock of its own: how many can be sold comes from the
// items. A team member needs manage_products; the shop needs Kits switched on to make a new one (the database checks both).
import { checkBundle, cleanBundle, isKit } from '../../../domain/catalog/bundles.js';
import { takenCodes } from '../../../domain/catalog/product-validation.js';
import { cleanCode } from '../../../domain/catalog/barcode.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { tooPrecise } from '../../../domain/sales/paise.js';
import { okColor } from '../../../shared/utils/colors.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { vRec } from '../../inventory/services/ledger.js';
import { trackingOfP } from '../../inventory/services/tracking.js';
import { productRepository } from '../repositories/product-repository.js';
import { stripMoney } from '../../../shared/formatting/money.js';

/* input: { id?, name, price, bc?, sku?, cat?, gst?, hsn?, bundle: [{ v, q }] } → { product, created } or { error, field, line? } */
export function saveKit(input){
  const no = denied("manage_products", "make kits"); if(no) return no;
  const repo = productRepository(), old = input && input.id ? repo.get(input.id) : null;
  if(input.id && !old) return { error: "That kit isn't on this device." };
  if(old && !isKit(old)) return { error: "That product isn't a kit." };
  if(!old && !hasCap("uses_bundles")) return { error: "Kits are switched off for this shop. Switch them on in Settings → Business → Features first." };
  const id = old ? old.id : "p" + uid(), bundle = cleanBundle(input.bundle);
  const name = String(input.name || "").trim().replace(/\s+/g, " "), price = +stripMoney(String(input.price == null ? "" : input.price));
  const bad = checkBundle({ id, name, price, bundle }, v => vRec(v), trackingOfP); if(bad) return bad;
  if(name.length > 120) return { error: "Keep the name to 120 characters.", field: "name" };
  if(tooPrecise(price)) return { error: "Use at most 2 decimal places in the price.", field: "price" };
  const bc = cleanCode(input.bc), sku = String(input.sku || "").trim(), taken = takenCodes(repo.list(), id, variantsOf);
  if(bc && taken["b:" + bc]) return { error: `Barcode ${bc} is already on ${taken["b:" + bc]}.`, field: "bc" };
  if(sku && taken["s:" + sku.toLowerCase()]) return { error: `SKU ${sku} is already on ${taken["s:" + sku.toLowerCase()]}.`, field: "sku" };
  const gst = input.gst == null || input.gst === "" ? null : +input.gst;
  if(gst != null && !(gst >= 0 && gst <= 100)) return { error: "GST % should be between 0 and 100.", field: "gst" };
  const v0 = old ? variantsOf(old, true)[0] : null;
  const product = { ...(old || {}), id, name, price: Math.round(price * 100) / 100, cost: null, color: old ? old.color : okColor(""), archived: old ? !!old.archived : false,
    cat: String(input.cat == null ? (old && old.cat) || "" : input.cat).trim(), hsn: String(input.hsn == null ? (old && old.hsn) || "" : input.hsn).trim(), gst,
    opts: [], variants: [{ id: v0 ? v0.id : "v" + uid(), o: [], sku, bc, price: null, cost: null, active: true }], bundle };
  repo.save({ product, isNew: !old, renamed: !!old && old.name !== name, newMoves: [], deletedVariantIds: [], image: undefined });
  return { product, created: !old };
}
