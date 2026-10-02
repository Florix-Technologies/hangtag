// A restaurant on this device (read model): its tables, the sessions going on at them, their orders (orders of kind
// "table") and what the shop uses (capabilities: tables, table QR, guests ordering from their phone, servers ordering on
// theirs, the kitchen screen). Capability = what is shown; permissions (services/access.js) = who may do it.
import { store } from '../../../shared/state/store.js';
import { liveSessionsOf, tableOrder, tableState } from '../../../domain/restaurant/tables.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { can, canAny } from '../../shop/services/access.js';
import { tableRepository } from '../repositories/table-repository.js';
import { orderRepository } from '../../orders/repositories/order-repository.js';

/* ---------- what the shop uses, and who may do what ---------- */
export const tablesOn = () => hasCap("uses_tables");
export const tableQrOn = () => hasCap("uses_table_qr");
export const guestOrderingOn = () => hasCap("uses_customer_ordering");
export const serverOrderingOn = () => hasCap("uses_server_ordering");
export const kitchenOn = () => hasCap("uses_kitchen");
/* May this person work the tables? The till (it sells, or runs the shop's settings); a server (takes orders) only while the
   shop has servers ordering on their phones */
export const mayWorkTables = () => tablesOn() && (can("create_sale") || can("manage_settings") || (serverOrderingOn() && canAny(["create_order", "manage_tables"])));
/* May this person take an order for a table? */
export const mayTakeTableOrder = () => tablesOn() && can("create_order") && (can("create_sale") || serverOrderingOn());
export const maySetUpTables = () => tablesOn() && can("manage_settings");
export const mayUseKitchen = () => kitchenOn() && canAny(["manage_kitchen"]);

/* ---------- tables, sessions, orders ---------- */
export const tablesList = all => tableRepository().tables().filter(t => t && (all || t.active !== false)).sort(tableOrder);
export const tableById = id => tableRepository().table(id);
export const sessionById = id => tableRepository().session(id);
/* The sessions going on at a table (oldest first) */
export const liveSessions = tableId => liveSessionsOf(tableRepository().sessions(), tableId);
/* The orders of sessions (table orders), oldest first */
export function ordersOfSessions(ids){
  const set = new Set(ids);
  return orderRepository().list().filter(o => o && o.kind === "table" && set.has(o.sessionId)).sort((a, b) => (a.t || 0) - (b.t || 0));
}
/* The orders of a table's live sessions */
export const tableOrders = tableId => ordersOfSessions(liveSessions(tableId).map(s => s.id));
/* available | occupied | preparing | ready | billing */
export const tableStateOf = tableId => tableState(liveSessions(tableId), tableOrders(tableId), kitchenOn());
/* Every table order the kitchen still has (not served, not cancelled) */
export const kitchenOrders = () => orderRepository().list().filter(o => o && o.kind === "table" && !["served", "cancelled"].includes(o.status));
export const tableName = id => { const t = id && tableById(id); return t ? t.name : ""; };
/* The bill being rung up comes from these table sessions: { table, name, sessions: [ids] } | null */
export const cartTable = () => store.cartTable || null;
