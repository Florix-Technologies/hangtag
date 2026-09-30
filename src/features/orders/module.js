// The Orders area as a module for the navigation registry (batch F2): one tab, three parts. Held bills are for every shop;
// quotations and sales orders only where the shop uses them (capabilities uses_quotations / uses_sales_orders); table
// orders arrive with the restaurant batch. Capability = "does this shop use it" (UX only); the permissions decide who may
// open each part (the database enforces them).
import { canAny } from '../shop/services/access.js';
import { hasCap } from '../shop/services/shop-caps.js';

export const ORDERS_MODULE = {
  id: "orders", tab: "orders", label: "Orders", permissions: ["create_sale", "create_order"], capability: null,
  submodules: [
    { id: "held", label: "Held bills", permissions: ["create_sale"], capability: null },
    { id: "quote", label: "Quotations", permissions: ["create_order"], capability: "uses_quotations" },
    { id: "sales", label: "Sales orders", permissions: ["create_order"], capability: "uses_sales_orders" },
  ],
};
/* Is a capability on for this shop? (F2's capability engine: the business type's defaults and the shop's own choices) */
export const orderCapOn = cap => !cap || hasCap(cap);
/* The parts of Orders this person sees here */
export const orderViews = (capOn = orderCapOn) => ORDERS_MODULE.submodules.filter(m => capOn(m.capability) && canAny(m.permissions));
