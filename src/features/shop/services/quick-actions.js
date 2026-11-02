// Quick actions: the one list of things a person starts from anywhere — the app bar's New sheet (every one this person may
// start, in the smart order of domain/shop/quick-actions.js: this workspace's first, then what they start most on this
// device, then their role's usual order) and Home's few buttons by role. Each opens the flow the app already has (the data
// attribute its handler listens for); what this person may not do, or this shop doesn't use, isn't offered.
import { store } from '../../../shared/state/store.js';
import { savePrefs } from '../../../shared/state/persistence.js';
import { can, canAny, currentRole, userId } from './access.js';
import { moduleShown } from './modules.js';
import { orderMobileActions } from '../../../domain/shop/mobile-workflow.js';
import { noteQuickUse, rankQuickActions } from '../../../domain/shop/quick-actions.js';
import { usesVouchers } from '../../commerce/use-cases/vouchers.js';
import { bankAccounts, mayEditBanks, mayViewBanks } from '../../finance/use-cases/bank-accounts.js';

const stockOn = () => moduleShown("stock"), hasBank = () => mayViewBanks() && (bankAccounts().some(a => a && a.active !== false) || mayEditBanks());
/* { id, label, sub, icon (the New sheet's), nav (Home's icon), attr, area (the workspace it belongs to), ok, sheet, home } */
const ACTIONS = [
  { id: "sale", label: "New sale", sub: "Start billing", icon: "plus", nav: "sell", attr: 'data-tab="sell"', area: "sell", ok: () => moduleShown("sell") && can("create_sale") },
  { id: "scan", label: "Scan to sell", nav: "tracking", attr: 'data-act="scan"', sheet: false, ok: () => moduleShown("sell") && can("create_sale") && !moduleShown("tables") },
  { id: "stock", label: "Receive stock", sub: "Stock that arrived, added to what's on hand", icon: "truck", nav: "purchases", attr: 'data-act="stockin"', area: "stock", ok: () => stockOn() && can("manage_inventory") },
  { id: "purchase", label: "Supplier bill", sub: "A purchase: the stock it brings and what you owe the supplier", icon: "receipt", attr: 'data-pur-open="new"', area: "stock", ok: () => stockOn() && can("create_purchase") },
  { id: "po", label: "Purchase order", sub: "Order stock from a supplier", icon: "doc", attr: "data-ponew", area: "stock", ok: () => stockOn() && can("create_purchase") },
  { id: "reorder", label: "Smart reorder", nav: "smart", attr: 'data-tab="stock" data-subview="stock:smart"', sheet: false, ok: () => stockOn() && canAny(["manage_inventory", "view_reports"]) },
  { id: "product", label: "Add product", sub: "An item for the catalogue", icon: "box", attr: 'data-act="addp"', area: "products", ok: () => can("manage_products") },
  { id: "customer", label: "Add customer", sub: "Contact and GST details", icon: "user", attr: 'data-act="custadd"', area: "customers", ok: () => can("create_sale") },
  { id: "quote", label: "Quotation", sub: "Prices for a customer to accept", icon: "doc", attr: 'data-ordnew="quote"', area: "orders", ok: () => moduleShown("orders") && can("create_order") },
  { id: "order", label: "Sales order", sub: "An order to deliver or bill later", icon: "doc", attr: 'data-ordnew="sales"', area: "orders", ok: () => moduleShown("orders") && can("create_order") },
  { id: "expense", label: "Expense", sub: "Cash spent on the shop, with its category", icon: "moneyOut", attr: 'data-cashform="expense"', area: "report", ok: () => can("create_sale") },
  { id: "cash", label: "Cash in / out", sub: "Money put into or taken out of the drawer", icon: "transfer", attr: 'data-cashform="move"', area: "report", ok: () => can("create_sale") },
  { id: "bank", label: "Bank entry", sub: "Money in or out of a bank account: rent, a deposit, charges", icon: "bank", attr: "data-bankquick", area: "report", ok: hasBank },
  { id: "voucher", label: "Gift voucher", sub: "Sell a voucher the customer pays with later", icon: "tag", attr: "data-gvnew", area: "sell", ok: () => usesVouchers() && can("create_sale") },
  { id: "tables", label: "Tables", nav: "tables", attr: 'data-tab="tables"', sheet: false, ok: () => moduleShown("tables") && canAny(["manage_tables", "create_order"]) },
  { id: "kitchen", label: "Kitchen queue", nav: "kitchen", attr: 'data-tab="kitchen"', sheet: false, ok: () => moduleShown("kitchen") && can("manage_kitchen") },
];
const offered = a => { try{ return !!a.ok(); }catch{ return false; } };
const withUse = a => ({ ...a, attr: `${a.attr} data-quick="${a.id}"` });

/* Home's buttons by role (domain/shop/mobile-workflow.js orders them; a restaurant's tables take the place of scanning) */
const ROLE_HOME = { owner: ["sale", "scan", "stock", "tables"], manager: ["stock", "reorder", "tables"], cashier: ["sale", "scan", "tables"], server: ["tables"], kitchen: ["kitchen"] };
export const homeActions = () => { const role = currentRole(), want = ROLE_HOME[role] || ROLE_HOME.owner;
  return orderMobileActions(role, ACTIONS.filter(a => want.includes(a.id) && offered(a))).map(a => ({ ...withUse(a), icon: a.nav })); };

/* What a person starts is theirs: a shared till keeps each person's (and role's) own record, the 8 most recent people */
const who = () => `${userId() || "local"}:${currentRole()}`;
const usageOf = () => { const U = store.prefs.quickUse; return U && typeof U === "object" && U[who()] || {}; };
/* The New sheet: { suggested: [{ ...action, why }], rest, list } */
export const sheetActions = (now = Date.now()) => {
  const R = rankQuickActions(ACTIONS.filter(a => a.sheet !== false && offered(a)), { role: currentRole(), area: store.prefs.tab || "", usage: usageOf(), now });
  return { suggested: R.suggested.map(withUse), rest: R.rest.map(withUse), list: R.list.map(withUse) };
};
/* Someone started an action: counted on this device for them, for the order next time */
export function noteQuickAction(id, now = Date.now()){
  if(!ACTIONS.some(a => a.id === id)) return;
  const U = { ...(store.prefs.quickUse && typeof store.prefs.quickUse === "object" ? store.prefs.quickUse : {}) }, k = who();
  U[k] = noteQuickUse(U[k], id, now);
  const last = u => Math.max(0, ...Object.values(u || {}).map(x => +x.t || 0));
  Object.keys(U).sort((a, b) => last(U[b]) - last(U[a])).slice(8).forEach(x => { delete U[x]; });
  store.prefs.quickUse = U; savePrefs();
}
