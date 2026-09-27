// ArchiveProduct / RemoveProduct: take a product off sale, bring it back, or delete one that was never sold.
import { variantsOf } from '../../../domain/catalog/variants.js';
import { hasHistory } from '../../inventory/services/ledger.js';
import { productRepository } from '../repositories/product-repository.js';

/* Returns the product, or null if there is none with that id */
export const archiveProduct=(pid,on)=>productRepository().setArchived(pid,on);
/* A product with sales or returns can only be archived, never deleted */
export function productHasSales(pid){ const p=productRepository().get(pid); return !!p&&variantsOf(p,true).some(v=>hasHistory(v.id)); }
/* Deletes a product that was never sold, with its stock records and photo. Returns the product, or null. */
export function removeProduct(pid){ return productHasSales(pid)?null:productRepository().remove(pid); }
