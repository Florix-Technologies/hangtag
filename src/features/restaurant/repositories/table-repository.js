// Accessor for the "tableRepository" port (implementation: infrastructure/repositories/local-first-table-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const tableRepository = () => use("tableRepository");
