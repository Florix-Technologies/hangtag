// Inventory's parts next to the stock levels — Purchases, Suppliers, Stock count — and Products → Import, as descriptors a
// module registry can take as they are ({ parent, id, label, perms (any one), render(host) } / open()), plus a small bar
// that switches between them until then (store.invSub), and the one place the app's DOM events reach them.
import { store } from '../../../shared/state/store.js';
import { renderPurchasesView, renderSuppliersView, supplierClick, supplierSubmit } from './suppliers-view.js';
import { purchaseChange, purchaseClick, purchaseInput, purchaseSubmit } from './purchase-entry.js';
import { countChange, countClick, countInput, renderStockCountView } from './stock-count.js';
import { intakeClick, intakeInput, intakeSubmit } from './code-intake.js';
import { importChange, importClick, openProductImport } from '../../products/components/product-import.js';
import { canAny } from '../../shop/services/access.js';
import { $, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';

/* Who may see purchases and suppliers (the database's read rule: section 5 of schema.sql) */
export const PURCHASE_READ=["create_purchase","manage_inventory","view_reports"];
export const INVENTORY_SUBVIEWS=[
  {parent:"stock",id:"purchases",label:"Purchases",perms:PURCHASE_READ,render:renderPurchasesView},
  {parent:"stock",id:"suppliers",label:"Suppliers",perms:PURCHASE_READ,render:renderSuppliersView},
  {parent:"stock",id:"count",label:"Stock count",perms:["manage_inventory"],render:renderStockCountView},
];
export const PRODUCT_ACTIONS=[{parent:"products",id:"import",label:"Import",perms:["manage_products"],open:openProductImport}];
const shownSubs=()=>INVENTORY_SUBVIEWS.filter(d=>canAny(d.perms));
/* The bar over the stock levels and its parts (empty for someone who can see none of the parts) */
export function inventorySubnavHTML(){
  const subs=shownSubs(); if(!subs.length) return "";
  const cur=store.invSub||"levels";
  return `<div class="seg invsub" role="group" aria-label="Inventory">${[{id:"levels",label:"Stock levels"},...subs].map(d=>`<button data-invsub="${esc(d.id)}" aria-pressed="${cur===d.id}">${esc(d.label)}</button>`).join("")}</div>`;
}
/* Draws the open part into host → true, or false for the stock levels (the caller draws them). Someone typing in a part
   isn't interrupted by a live update (force: redraw anyway). */
export function renderInventorySub(host,force){
  const d=shownSubs().find(x=>x.id===store.invSub);
  if(!d){ store.invSub="levels"; return false; }
  const a=document.activeElement, body=$("#invSubBody");
  if(!force&&body&&host.contains(body)&&a&&a.matches&&a.matches("#invSubBody input, #invSubBody select, #invSubBody textarea")) return true;
  host.innerHTML=inventorySubnavHTML()+`<div id="invSubBody"></div>`;
  d.render($("#invSubBody"));
  return true;
}
export function openInventorySub(id){ store.invSub=id; if(store.supplierView) store.supplierView.id=null; renderAll(); window.scrollTo(0,0); }

/* ---------- DOM events (app/events/dom-events.js) ---------- */
export function inventoryClick(t){
  const sub=t.closest("[data-invsub]"); if(sub){ openInventorySub(sub.dataset.invsub); return true; }
  if(t.closest("[data-act=prodimport]")){ openProductImport(); return true; }
  return purchaseClick(t)||supplierClick(t)||countClick(t)||intakeClick(t)||importClick(t);
}
export const inventoryInput=t=>purchaseInput(t)||countInput(t)||intakeInput(t);
export async function inventoryChange(t){ return purchaseChange(t)||countChange(t)||await importChange(t); }
export const inventorySubmit=e=>purchaseSubmit(e)||supplierSubmit(e)||intakeSubmit(e);
/* A sheet of these parts is being closed (× / Cancel / a click beside it) → true when it must stay open: a click beside
   a sheet with work in it never closes it */
export function inventoryModalClose(t){
  if(t.matches("[data-keep]")) return true;
  store.purchaseForm=null; store.prodImport=null; store.quickProduct=null; if(store.supplierView) store.supplierView.form=null;
  return false;
}
