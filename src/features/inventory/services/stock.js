// Stock on hand per variant and product.
import { variantsOf } from '../../../domain/catalog/variants.js';
import { D } from './ledger.js';
import { roundQty, sumQty } from '../../../domain/catalog/units.js';

export const stockOf=vid=>{const d=D();return roundQty((d.moved[vid]||0)-(d.sold[vid]||0)+(d.returned[vid]||0))};
export const productLeft=p=>sumQty(variantsOf(p).map(v=>Math.max(0,stockOf(v.id))));
