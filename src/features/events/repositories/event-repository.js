// Events are read and written through the "eventRepository" port (contract: shared/di/ports.js,
// implementation: infrastructure/repositories/local-first-event-repository.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const eventRepository = () => use("eventRepository");
