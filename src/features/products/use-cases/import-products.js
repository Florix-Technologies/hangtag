// ImportProducts (Products → Import): a sheet of products (CSV or Excel) is checked row by row against the catalog; only a
// file whose every row is right is imported — never part of one. Products and their variants are saved through the product
// repository, opening stock as OPENING stock records. A team member needs manage_products (and a stock permission for
// opening stock), refused before anything changes.
import { store } from '../../../shared/state/store.js';
import { importPlan, validateImport } from '../../../domain/catalog/product-import.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { UPLOAD_PERMISSIONS } from '../../../domain/sync/queue-rules.js';
import { productRepository } from '../repositories/product-repository.js';
import { COLORS } from '../../../shared/utils/colors.js';
import { uid } from '../../../shared/utils/ids.js';
import { canAny, denied } from '../../shop/services/access.js';

/* rows: [[cell text…]…] as in the sheet → the check (domain/catalog/product-import.js validateImport). skipExisting: rows of
   products the shop already has are left out instead of refused (the merchant chose so in the preview). */
export const checkImportRows = (rows, { skipExisting = false } = {}) => validateImport(rows, { products: productRepository().list(), variantsOf, stockAllowed: canAny(UPLOAD_PERMISSIONS.move), skipExisting });
/* rows: as checked (the file's rows) → { error, check? } or { products, variants, pieces } */
export function importProducts(rows, { skipExisting = false } = {}){
  const no=denied("manage_products","import products"); if(no) return no;
  // checked again against the catalog as it is now (it may have changed since the preview)
  const v=checkImportRows(rows, { skipExisting });
  if(v.error) return {error:v.error};
  if(v.errorCount) return {error:`${v.errorCount} row${v.errorCount===1?" needs":"s need"} fixing first: nothing is imported until every row is right.`,check:v};
  if(!v.ok) return {error:"There is nothing to import: every row is an example from the template or a product your shop already has.",check:v};
  const plan=importPlan(v,{ids:{product:()=>"p"+uid(),variant:()=>"v"+uid()},colors:COLORS,now:Date.now(),dev:store.dev});
  if(plan.error) return {error:plan.error};
  productRepository().addMany({products:plan.products,moves:plan.moves});
  return {products:plan.products.length,variants:plan.products.reduce((a,p)=>a+p.variants.length,0),pieces:v.summary.pieces};
}
