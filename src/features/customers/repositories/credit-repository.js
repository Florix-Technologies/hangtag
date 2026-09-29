// Accessor for the "creditRepository" port (implementation: infrastructure/repositories/local-first-credit-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const creditRepository = () => use("creditRepository");
