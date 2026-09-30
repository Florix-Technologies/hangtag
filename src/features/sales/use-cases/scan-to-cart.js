// ScanToCart: a scanned code → the exact variant it belongs to → one more on the bill, within the stock.
import { store } from '../../../shared/state/store.js';
import { vLabel } from '../../../domain/catalog/variants.js';
import { scanCodeError } from '../../../domain/sales/scan-rules.js';
import { findByCode } from '../services/search.js';
import { addToLines, availOf, cartQtyV } from '../services/cart.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { isWeighed } from '../../../domain/catalog/units.js';

/* → { status: "added" | "weigh" | "not-found" | "sold-out" | "limit" | "invalid", message, label?, q?, variantId? }
   "weigh": it is sold by weight or volume, so nothing is added yet: the weight dialog asks for its weight.
   Only this shop's catalog is searched (exact barcode or QR text first, then SKU); nothing is ever created. */
export function scanToCart(raw){
  const bad = scanCodeError(raw);
  if(bad) return { status: "invalid", message: bad };
  const code = String(raw).trim(), hit = findByCode(code);
  if(!hit) return { status: "not-found", message: `Product not found (${code.length > 24 ? code.slice(0, 23) + "…" : code}).` };
  const label = [hit.p.name, vLabel(hit.v)].filter(Boolean).join(" · ");
  if(availOf(hit.v.id) <= 0){
    const onBill = cartQtyV(hit.v.id);
    return onBill ? { status: "limit", message: `All ${onBill} in stock are already on the bill (${label}).`, label, variantId: hit.v.id }
      : { status: "sold-out", message: `${label} is sold out.`, label, variantId: hit.v.id };
  }
  if(isWeighed(hit.p.unit)) return { status: "weigh", message: `Weigh ${label}`, label, variantId: hit.v.id };
  addToLines(store.cart, hit.v.id, 1); store.justAdded = hit.p.id; saveCart();
  const q = cartQtyV(hit.v.id);
  return { status: "added", message: `Added ${label}${q > 1 ? ` · ${q} on the bill` : ""}`, label, q, variantId: hit.v.id };
}
