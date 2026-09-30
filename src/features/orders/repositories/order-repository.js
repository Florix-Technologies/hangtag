// Accessor for the "orderRepository" port (implementation: infrastructure/repositories/local-first-order-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const orderRepository = () => use("orderRepository");
