// Stock levels with this shop's low-stock setting.
import { store } from '../../../shared/state/store.js';
import { lowStockThreshold, stockLevel } from '../../../domain/inventory/stock-levels.js';

export const lowAt=()=>lowStockThreshold(store.settings);
export const levelOf=n=>stockLevel(n,lowAt());
