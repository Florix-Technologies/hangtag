// What an edit changed on a product: its own fields, and the variants added or changed. Only those are uploaded, so an
// edit made on another till to other fields of the same product isn't overwritten when this one reaches the cloud (spec
// Phase 21: queued changes → server → conflicts resolved → device updated). A field is the product record's own name for
// it (the cloud gateway maps each to its column). Pure.
import { variantsOf } from './variants.js';

export const PRODUCT_FIELDS = Object.freeze(["name", "price", "color", "cat", "brand", "desc", "cost", "archived", "hsn", "gst", "code", "opts", "tracking", "unit", "low", "expiry", "bundle", "repack"]);
/* Nothing set: no value, an empty text, off, an empty list (as the cloud keeps them: one and the same) */
const blank = v => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && !v.length);
const same = (a, b) => (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);
/* A variant as it is uploaded: its option values, codes, prices, on sale or not, and its place in the list */
const variantShape = (v, k) => JSON.stringify([k, Array.isArray(v.o) ? v.o : [], v.sku || "", v.bc || "", v.price == null || v.price === "" ? null : +v.price,
  v.cost == null || v.cost === "" ? null : +v.cost, v.active !== false]);

/* before, after: the product as saved before the edit and after it → { fields: [...], variants: [ids added or changed] }.
   Changed options (renamed, values added or reordered) change every variant's labels: all of them go up. */
export function productChanges(before, after){
  const b = before || {}, a = after || {};
  const fields = PRODUCT_FIELDS.filter(f => !same(b[f], a[f]));
  const now = variantsOf(a, true);
  if(fields.includes("opts")) return { fields, variants: now.map(v => v.id) };
  const was = new Map(variantsOf(b, true).map((v, k) => [v.id, variantShape(v, k)]));
  return { fields, variants: now.filter((v, k) => was.get(v.id) !== variantShape(v, k)).map(v => v.id) };
}
