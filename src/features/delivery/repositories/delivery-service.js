// Accessor for the "messageDelivery" port (implementation: infrastructure/messaging/delivery-client.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const messageDelivery = () => use("messageDelivery");
