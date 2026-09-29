// ArchiveProduct / RemoveProduct: take a product off sale, bring it back, or delete one that was never sold.
import { variantsOf } from '../../../domain/catalog/variants.js';
import { hasHistory } from '../../inventory/services/ledger.js';
import { productRepository } from '../repositories/product-repository.js';
import { denied } from '../../shop/services/access.js';

/* Returns the product, null if there is none with that id, or { error } (a team member without manage_products) */
export const archiveProduct=(pid,on)=>denied("manage_products","change products")||productRepository().setArchived(pid,on);
/* A product with sales or returns can only be archived, never deleted */
export function productHasSales(pid){ const p=productRepository().get(pid); return !!p&&variantsOf(p,true).some(v=>hasHistory(v.id)); }
/* Deletes a product that was never sold, with its stock records and photo. Returns the product, null, or { error }. */
export function removeProduct(pid){ return denied("manage_products","delete products")||(productHasSales(pid)?null:productRepository().remove(pid)); }
