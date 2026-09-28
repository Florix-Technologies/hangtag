// Returns are read and written through the "returnRepository" port (contract: shared/di/ports.js,
// implementation: infrastructure/repositories/local-first-return-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const returnRepository = () => use("returnRepository");
