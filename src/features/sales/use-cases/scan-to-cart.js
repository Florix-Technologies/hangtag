// ScanToCart: a scanned code → the exact variant it belongs to → one more on the bill, within the stock.
import { store } from '../../../shared/state/store.js';
import { vLabel } from '../../../domain/catalog/variants.js';
import { scanCodeError } from '../../../domain/sales/scan-rules.js';
import { findByCode } from '../services/search.js';
import { addSerials, addToLines, availOf, cartQtyV, serialsOnLines } from '../services/cart.js';
import { isSerialV, serialForSale } from '../../inventory/services/tracking.js';
import { prod } from '../../products/services/catalog.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { isWeighed } from '../../../domain/catalog/units.js';

/* A serial number scanned at the till (camera, scanner, search box): that very piece goes on the bill →
   { status: "added" | "limit", message, variantId } or null when the code isn't a serial ready to sell */
export function scanSerialToCart(raw){
  const s = serialForSale(String(raw || "").trim()); if(!s) return null;
  if(serialsOnLines(store.cart).has(s.sn)) return { status: "limit", message: `Serial ${s.sn} is already on the bill.`, variantId: s.vid };
  addSerials(store.cart, s.vid, [s.sn]); store.justAdded = s.pid; saveCart();
  const p = prod(s.pid);
  return { status: "added", message: `Added ${p ? p.name : "item"} · serial ${s.sn}`, label: p ? p.name : "", q: 1, variantId: s.vid };
}
/* → { status: "added" | "weigh" | "serial" | "not-found" | "sold-out" | "limit" | "invalid", message, label?, q?, variantId? }
   "weigh": it is sold by weight or volume, so nothing is added yet: the weight dialog asks for its weight.
   "serial": it is tracked by serial number: the serial picker asks which pieces (a serial number scanned is added at once).
   Only this shop's catalog is searched (exact barcode or QR text first, then SKU); nothing is ever created. */
export function scanToCart(raw){
  const bad = scanCodeError(raw);
  if(bad) return { status: "invalid", message: bad };
  const code = String(raw).trim(), hit = findByCode(code);
  if(!hit){ const sr = scanSerialToCart(code); if(sr) return sr; }
  if(!hit) return { status: "not-found", message: `Product not found (${code.length > 24 ? code.slice(0, 23) + "…" : code}).` };
  const label = [hit.p.name, vLabel(hit.v)].filter(Boolean).join(" · ");
  if(availOf(hit.v.id) <= 0){
    const onBill = cartQtyV(hit.v.id);
    return onBill ? { status: "limit", message: `All ${onBill} in stock are already on the bill (${label}).`, label, variantId: hit.v.id }
      : { status: "sold-out", message: `${label} is sold out.`, label, variantId: hit.v.id };
  }
  if(isWeighed(hit.p.unit)) return { status: "weigh", message: `Weigh ${label}`, label, variantId: hit.v.id };
  if(isSerialV(hit.v.id)) return { status: "serial", message: `Choose the serial number of ${label}`, label, variantId: hit.v.id, productId: hit.p.id };
  addToLines(store.cart, hit.v.id, 1); store.justAdded = hit.p.id; saveCart();
  const q = cartQtyV(hit.v.id);
  return { status: "added", message: `Added ${label}${q > 1 ? ` · ${q} on the bill` : ""}`, label, q, variantId: hit.v.id };
}
