// Sell search: product/variant text, code lookup.
import { store } from '../../../shared/state/store.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { liveProducts } from '../../products/services/catalog.js';
import { norm } from '../../../shared/utils/text.js';

export function variantText(p, v){ return norm([...(v.o || []), v.sku, v.bc].join(" ")); }
export function productText(p){ return norm([p.name, p.cat, p.brand].join(" ")); }
/* Products (not archived) matching the search and category */

export function sellProducts(){
  const toks = norm(store.sellQuery).split(/\s+/).filter(Boolean);
  return liveProducts().filter(p => {
    if(store.sellCat && p.cat !== store.sellCat) return false;
    if(!toks.length) return true;
    const pt = productText(p), vs = variantsOf(p).map(v => variantText(p, v));
    return toks.every(t => pt.includes(t) || vs.some(x => x.includes(t)));
  });
}
/* The exact variant for a scanned or typed code: barcode/QR text first (exactly as stored), then SKU (any case) */

export function findByCode(code){
  const raw = String(code == null ? "" : code).trim(); if(!raw) return null;
  const all = liveProducts().flatMap(p => variantsOf(p).map(v => ({ p, v })));
  const lc = raw.toLowerCase();
  return all.find(h => h.v.bc && h.v.bc.trim() === raw) || all.find(h => h.v.bc && h.v.bc.trim().toLowerCase() === lc)
    || all.find(h => h.v.sku && h.v.sku.trim().toLowerCase() === lc) || null;
}
/* Individual variants matching every search word (e.g. "black xl") */

export function variantHits(){
  const toks = norm(store.sellQuery).split(/\s+/).filter(Boolean); if(!toks.length) return [];
  const exact = findByCode(store.sellQuery); if(exact) return [exact];
  const out = [];
  liveProducts().forEach(p => {
    if(store.sellCat && p.cat !== store.sellCat) return;
    const pt = productText(p);
    variantsOf(p).forEach(v => {
      const vt = variantText(p, v);
      // only useful when the search says something about the variant itself
      if(toks.every(t => pt.includes(t) || vt.includes(t)) && toks.some(t => vt.includes(t))) out.push({ p, v });
    });
  });
  return out.slice(0, 8);
}
