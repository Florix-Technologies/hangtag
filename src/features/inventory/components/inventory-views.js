// Inventory's parts next to the stock levels — Purchases, Suppliers, Stock count — and Products → Import, as descriptors the
// navigation registry takes as they are ({ parent, id, label, perms (any one), render(host) } / open(); app/modules.js
// registers them), and the one place the app's DOM events reach them.
import { store } from '../../../shared/state/store.js';
import { renderPurchasesView, renderSuppliersView, supplierClick, supplierSubmit } from './suppliers-view.js';
import { purchaseChange, purchaseClick, purchaseInput, purchaseSubmit } from './purchase-entry.js';
import { countChange, countClick, countInput, renderStockCountView } from './stock-count.js';
import { intakeClick, intakeInput, intakeSubmit } from './code-intake.js';
import { stockOpChange, stockOpInput } from './stock-operation.js';
import { renderTrackingView, trackViewChange, trackViewClick, trackViewInput, trackViewSubmit } from './tracking-view.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { products } from '../../products/services/catalog.js';
import { trackingOfP } from '../services/tracking.js';
import { importChange, importClick, openProductImport } from '../../products/components/product-import.js';
import { chooseSubview } from '../../shop/services/modules.js';
import { renderAll } from '../../../shared/ui/render.js';
import { renderSmartReorder } from '../pages/smart-reorder-page.js';

/* Who may see purchases and suppliers (the database's read rule: section 5 of schema.sql) */
export const PURCHASE_READ=["create_purchase","manage_inventory","view_reports"];
export const INVENTORY_SUBVIEWS=[
  {parent:"stock",id:"smart",label:"Smart reorder",perms:["manage_inventory","create_purchase","view_reports"],render:renderSmartReorder},
  {parent:"stock",id:"purchases",label:"Purchases",perms:PURCHASE_READ,render:renderPurchasesView},
  {parent:"stock",id:"suppliers",label:"Suppliers",perms:PURCHASE_READ,render:renderSuppliersView},
  {parent:"stock",id:"count",label:"Stock count",perms:["manage_inventory"],render:renderStockCountView},
  // serial numbers and batches: for a shop that tracks them (the capability on, or a product tracked that way)
  {parent:"stock",id:"tracking",label:"Serials & batches",perms:["manage_inventory","create_purchase","view_reports","create_sale","perform_return"],render:renderTrackingView,
    available:()=>hasCap("uses_serials")||hasCap("uses_batches")||hasCap("uses_expiry")||products().some(p=>trackingOfP(p)!=="none")},
];
export const PRODUCT_ACTIONS=[{parent:"products",id:"import",label:"Import",perms:["manage_products"],open:openProductImport}];
/* Draws a part into the page the navigation gives it; someone typing in it isn't interrupted by a live update */
export function renderInventoryPart(d,host){
  const a=document.activeElement;
  if(host.firstChild&&a&&host.contains(a)&&a.matches&&a.matches("input, select, textarea")) return;
  d.render(host);
}
export function openInventorySub(id){ chooseSubview("stock",id); if(store.supplierView) store.supplierView.id=null; renderAll(); window.scrollTo(0,0); }

/* ---------- DOM events (app/events/dom-events.js) ---------- */
export function inventoryClick(t){
  const sub=t.closest("[data-invsub]"); if(sub){ openInventorySub(sub.dataset.invsub); return true; }
  if(t.closest("[data-act=prodimport]")){ openProductImport(); return true; }
  return purchaseClick(t)||supplierClick(t)||countClick(t)||intakeClick(t)||importClick(t)||trackViewClick(t);
}
export const inventoryInput=t=>purchaseInput(t)||countInput(t)||intakeInput(t)||stockOpInput(t)||trackViewInput(t);
export async function inventoryChange(t){ return purchaseChange(t)||countChange(t)||stockOpChange(t)||trackViewChange(t)||await importChange(t); }
export const inventorySubmit=e=>purchaseSubmit(e)||supplierSubmit(e)||intakeSubmit(e)||trackViewSubmit(e);
/* A sheet of these parts is being closed (× / Cancel / a click beside it) → true when it must stay open: a click beside
   a sheet with work in it never closes it */
export function inventoryModalClose(t){
  if(t.matches("[data-keep]")) return true;
  store.purchaseForm=null; store.prodImport=null; store.quickProduct=null; if(store.supplierView) store.supplierView.form=null;
  return false;
}
