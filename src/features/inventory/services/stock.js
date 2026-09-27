// Stock on hand per variant and product.
import { variantsOf } from '../../../domain/catalog/variants.js';
import { D } from './ledger.js';

export const stockOf=vid=>{const d=D();return (d.moved[vid]||0)-(d.sold[vid]||0)+(d.returned[vid]||0)};
export const productLeft=p=>variantsOf(p).reduce((a,v)=>a+Math.max(0,stockOf(v.id)),0);
