// Products are read and written through the "productRepository" port (contract: shared/di/ports.js,
// implementation: infrastructure/repositories/local-first-product-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const productRepository = () => use("productRepository");
