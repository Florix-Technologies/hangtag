// Stock levels with this shop's low-stock setting (and a product's own level, when it has one).
import { store } from '../../../shared/state/store.js';
import { lowStockThreshold, stockLevel } from '../../../domain/inventory/stock-levels.js';

export const lowAt=p=>lowStockThreshold(store.settings,p);
export const levelOf=(n,p)=>stockLevel(n,lowAt(p));
