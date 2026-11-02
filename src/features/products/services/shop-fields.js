// The shop's own product fields and units on this device: records of kinds "at" and "un" (synced like price lists, schema.sql
// section 3z), read here and changed through use-cases/shop-fields.js. The units registry (domain/catalog/units.js) is told
// whenever they load or change, so every quantity rule knows the shop's units.
import { store } from '../../../shared/state/store.js';
import { normalizeAttr } from '../../../domain/catalog/attributes.js';
import { setShopUnits } from '../../../domain/catalog/units.js';

const records = kind => Object.values(((store.biz || {})[kind]) || {});
const byOrder = (a, b) => a.sort - b.sort || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
/* Every field (archived ones too: products keep their values) */
export const shopAttrs = () => records("at").map(normalizeAttr).filter(a => a.id).sort(byOrder);
export const activeAttrs = () => shopAttrs().filter(a => !a.archived);
export const attrById = id => shopAttrs().find(a => a.id === id) || null;
/* Every unit of the shop's own, as kept (archived ones too) */
export const shopUnitList = () => records("un");
export const refreshShopUnits = () => setShopUnits(records("un"));
