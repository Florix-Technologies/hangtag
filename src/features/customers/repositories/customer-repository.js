// Customers are read and written through the "customerRepository" port (contract: shared/di/ports.js,
// implementation: infrastructure/repositories/local-first-customer-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const customerRepository = () => use("customerRepository");
