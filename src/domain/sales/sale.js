// Sale rules: pieces. (Document numbers: domain/documents/numbering.js. Payment methods and their names:
// domain/sales/payments.js.)
import { isMeasured, sumQty } from '../catalog/units.js';

/* Items on a bill: pieces for counted units; a measured line (2.5 kg, 1.2 m) counts as one item */
export const pcsOf=s=>sumQty(s.items.map(i=>isMeasured(i.u)?1:i.q));
