// Factory barcode intake (purchase entry, Inventory → Stock in by code): a scanned or typed code → the variant that has it,
// or a new product made on the spot with that code as its barcode (through the product repository, like the product
// editor). A code is never given to a second variant (the catalog check here; the database's unique index behind it).
import { store } from '../../../shared/state/store.js';
import { lookupCode, quickProduct } from '../../../domain/inventory/barcode-intake.js';
import { takenCodes } from '../../../domain/catalog/product-validation.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { IMPORT_UNITS } from '../../../domain/catalog/product-import.js';
import { products } from '../../products/services/catalog.js';
import { productRepository } from '../../products/repositories/product-repository.js';
import { COLORS } from '../../../shared/utils/colors.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied } from '../../shop/services/access.js';

/* → { hit: { p, v } } | { off: { p, v } } | { unknown: code } | { error } */
export const findCode = raw => lookupCode(raw, products(), variantsOf);
/* The units a quick product may have ([code, label, decimals]) */
export const intakeUnits = () => IMPORT_UNITS;
/* input: { code, name, unit, price, cost, gst, hsn } → { error, field } or { product, variant } (saved and queued) */
export function quickCreateProduct(input){
  const no=denied("manage_products","add products"); if(no) return no;
  const all=products();
  const r=quickProduct(input,{taken:takenCodes(all,null,variantsOf),id:"p"+uid(),vid:"v"+uid(),color:COLORS[all.length%COLORS.length],units:intakeUnits()});
  if(r.error) return r;
  if(store.catalog&&store.catalog.example&&!all.length) store.catalog.example=false;
  productRepository().save({product:r.product,isNew:true,renamed:false,newMoves:[],deletedVariantIds:[],image:undefined});
  return {product:r.product,variant:r.product.variants[0]};
}
