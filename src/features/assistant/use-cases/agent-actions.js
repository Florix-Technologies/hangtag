// What the Hangtag Agent may save, and only when the person confirms it on the screen: a draft tool's proposal. The Agent
// (and any AI provider behind it) never calls this; the page does, from the person's tap. Today: a draft purchase order
// from Smart reorder's suggestion — saved as a draft (never sent), with the same checks as making one by hand
// (create_purchase, purchase orders switched on, the supplier, the lines).
import { poFromReorder } from '../../inventory/use-cases/purchase-orders.js';

const MAX_LINES = 200;
/* → { po } or { error } */
export function confirmAgentProposal(proposal){
  if(!proposal || proposal.requiresConfirmation !== true) return { error: "There is nothing to confirm." };
  if(proposal.kind === "purchase_order"){
    const items = Array.isArray(proposal.items) ? proposal.items.filter(l => l && l.v && +l.q > 0).slice(0, MAX_LINES) : [];
    if(!items.length) return { error: "This draft has no lines." };
    return poFromReorder(proposal.supplierId, items.map(l => ({ p: l.p, v: l.v, name: l.name, vl: l.vl || "", ...(l.u ? { u: l.u } : {}), q: +l.q, price: l.price == null ? null : +l.price, ...(l.gst != null ? { gst: l.gst } : {}) })));
  }
  return { error: "The Agent can't save that." };
}
