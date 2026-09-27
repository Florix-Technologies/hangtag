// Stock moves are recorded through the "stockRepository" port (contract: shared/di/ports.js,
// implementation: infrastructure/repositories/local-first-stock-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const stockRepository = () => use("stockRepository");
