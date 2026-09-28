// Accessor for the "cashRepository" port (implementation: infrastructure/repositories/local-first-cash-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const cashRepository = () => use("cashRepository");
