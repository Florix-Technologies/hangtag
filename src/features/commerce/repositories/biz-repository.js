// The commerce batch's records (price lists, purchase orders, GST readiness, repacks, vouchers): the "bizRepository" port
// (shared/di/ports.js), provided by app/container.js.
import { use } from '../../../shared/di/services.js';

export const bizRepository = () => use("bizRepository");
