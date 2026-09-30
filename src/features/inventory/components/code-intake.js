// Inventory → Stock in by barcode: scan (camera, or a USB / Bluetooth scanner typing into the box) or type a factory code.
// A code on a variant opens Stock in for its product with one piece of that variant filled in; a new code first makes the
// product (name, unit, price, cost, GST, HSN) with that code as its barcode. store.quickProduct = the new-product sheet.
import { store } from '../../../shared/state/store.js';
import { offSaleText } from '../../../domain/inventory/barcode-intake.js';
import { findCode, intakeUnits, quickCreateProduct } from '../use-cases/intake-code.js';
import { openStockOp, renderStockOp } from './stock-operation.js';
import { closeScanner, openScanner } from '../../sales/components/camera-scan.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { can } from '../../shop/services/access.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';

/* The card on the stock levels view */
export const intakeCardHTML=()=>can("manage_inventory")?`<form id="intakeForm" class="card pu-code intake" autocomplete="off"><b>Stock in by barcode</b><input id="intakeCode" placeholder="Scan or type a barcode or SKU" enterkeyhint="go" aria-label="Barcode or SKU for stock in"><button class="btn sm" type="submit">Find</button><button type="button" class="btn sm" data-intake="scan">Scan</button></form>`:"";
function stockInFor(vid,pid,cost){
  openStockOp("in",pid);
  if(store.stockOp&&store.stockOp.pid===pid){ store.stockOp.val[vid]="1"; if(cost!=null&&cost!=="") store.stockOp.cost=String(cost); renderStockOp(); const c=$("#soCost"); if(c&&cost!=null&&cost!=="") c.value=String(cost); const i=$(`#modalHost [data-sov="${CSS.escape(vid)}"]`); if(i){ i.focus(); i.select(); } }
}
/* → { status, message } (the camera shows the message) */
export function intakeCode(raw){
  const r=findCode(raw);
  if(r.error) return {status:"invalid",message:r.error};
  if(r.off) return {status:"invalid",message:offSaleText(r.off)};
  if(r.unknown){
    if(!can("manage_products")) return {status:"not-found",message:`No product has code ${r.unknown}. Ask someone who can add products to add it first.`};
    store.quickProduct={code:r.unknown,name:"",unit:"pcs",price:"",cost:"",gst:"",hsn:"",err:""};
    return {status:"new",message:`New code ${r.unknown}: add the product.`};
  }
  return {status:"found",hit:r.hit,message:`${r.hit.p.name}`};
}
function afterCode(r){
  if(r.status==="found") stockInFor(r.hit.v.id,r.hit.p.id);
  else if(r.status==="new") renderQuickProduct();
  else toast(r.message);
}
export function renderQuickProduct(){
  const q=store.quickProduct; if(!q){ closeModal(); return; }
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim data-keep><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="New product">
    <div class="sh-head"><div class="sh-t"><h3>New product</h3><p>Nobody in the catalog has code <b>${esc(q.code)}</b>. Add the product with it, then its stock.</p></div><button class="iconbtn" data-qp-act="cancel" aria-label="Close">${ICON.x}</button></div>
    <form id="qpForm" class="pgrid" autocomplete="off"><label class="f full">Name<input id="qpName" data-qp="name" value="${esc(q.name)}" maxlength="80"></label>
    <label class="f">Unit<select data-qp="unit">${intakeUnits().map(([c,l])=>`<option value="${esc(c)}"${c===q.unit?" selected":""}>${esc(l)}</option>`).join("")}</select></label>
    <label class="f">Selling price (₹)<input data-qp="price" inputmode="numeric" value="${esc(q.price)}"></label>
    <label class="f">Cost price (₹)<input data-qp="cost" inputmode="numeric" value="${esc(q.cost)}"></label>
    <label class="f">GST %<input data-qp="gst" inputmode="decimal" value="${esc(q.gst)}"></label>
    <label class="f">HSN<input data-qp="hsn" inputmode="numeric" value="${esc(q.hsn)}" maxlength="8"></label><button type="submit" hidden></button></form>
    <p class="autherr"${q.err?"":" hidden"}>${esc(q.err)}</p>
    <div class="sh-foot"><span></span><div class="sh-acts"><button class="btn sm" data-qp-act="cancel">Cancel</button><button class="btn sm primary" data-qp-act="save">Add product and stock in</button></div></div></div></div>`;
  const n=$("#qpName"); if(n) n.focus();
}
function saveQuick(){
  const q=store.quickProduct; if(!q) return;
  const r=quickCreateProduct(q);
  if(r.error){ q.err=r.error; renderQuickProduct(); return; }
  store.quickProduct=null; closeModal(); renderSync(); flushSbQueue();
  toast(`${r.product.name} added to the catalog.`);
  stockInFor(r.variant.id,r.product.id,q.cost);
}
/* ---------- events (from app/events/dom-events.js through inventory-views.js) ---------- */
export function intakeClick(t){
  const b=t.closest("[data-intake],[data-qp-act]"); if(!b) return false;
  if(b.dataset.intake==="scan"){
    openScanner({title:"Scan for stock in",
      onCode:text=>{const r=intakeCode(text);if(r.status==="found"||r.status==="new"){setTimeout(()=>{closeScanner();afterCode(r)},0);return {status:"added",message:r.message}}return r},
      footer:()=>"Stock in: one code at a time",onType:()=>{const i=$("#intakeCode");if(i)i.focus()}});
    return true;
  }
  const a=b.dataset.qpAct;
  if(a==="save") saveQuick();
  else if(a==="cancel"){ store.quickProduct=null; closeModal(); }
  else return false;
  return true;
}
export function intakeInput(t){
  if(t.dataset.qp&&store.quickProduct&&!store.purchaseForm){ store.quickProduct[t.dataset.qp]=t.value; return true; }
  return false;
}
export function intakeSubmit(e){
  if(e.target.id==="qpForm"&&store.quickProduct){ e.preventDefault(); saveQuick(); return true; }
  if(e.target.id!=="intakeForm") return false;
  e.preventDefault();
  const i=$("#intakeCode"), raw=i?i.value:""; if(i) i.value="";
  afterCode(intakeCode(raw));
  return true;
}
