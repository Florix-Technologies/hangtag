// Suppliers, purchases and payments to suppliers go through the "purchaseRepository" port (contract: shared/di/ports.js,
// implementation: infrastructure/repositories/local-first-purchase-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const purchaseRepository = () => use("purchaseRepository");
