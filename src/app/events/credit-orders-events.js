// Clicks, typing and forms for customer credit, held bills and orders (section 3m). app/events/dom-events.js hands each
// event here first; a handler returns true when it dealt with the event (then nothing else runs).
import { store } from '../../shared/state/store.js';
import { openCustHistory, openCustPicker } from '../../features/customers/components/customer-picker.js';
import { cancelCollectionAction, collectInput, collectMethod, openCollectForm, submitCollect } from '../../features/customers/components/customer-account.js';
import { detachAction, holdAction, openHeldList } from '../../features/orders/components/bill-extras.js';
import { billAction, convertAction, openOrderEditor, orderFormChange, orderFormClick, orderFormInput } from '../../features/orders/components/order-editor.js';
import { quotationDocumentClick } from '../../features/orders/components/quotation-document.js';
import { renderOrders } from '../../features/orders/pages/orders-page.js';
import { chooseSubview } from '../../features/shop/services/modules.js';
import { discardHeld, recallHeld } from '../../features/orders/use-cases/held-carts.js';
import { payClosed } from '../../features/sales/components/payment-sheet.js';
import { toast } from '../../shared/components/toast.js';
import { renderAll, setTab } from '../../shared/ui/render.js';

export function creditOrdersClick(t){
  if(quotationDocumentClick(t)) return true;
  // closing a sheet or clearing the bill: forget what belonged to it, then let the usual handling run
  if(t.matches("[data-modal-scrim]") || t.closest("[data-modal-close]") || t.closest("[data-custhist]")){ store.orderForm = null; store.collectForm = null; return false; }
  if(t.closest('[data-act="clear"]')){ store.cartOrder = null; return false; }
  if(store.orderForm && orderFormClick(t)) return true;
  if(t.closest("[data-hold]")){ holdAction(); return true; }
  if(t.closest("[data-heldopen]")){ openHeldList(); return true; }
  const hr = t.closest("[data-heldrecall]");
  if(hr){ const r = recallHeld(hr.dataset.heldrecall); if(r.error){ toast(r.error); return true; } setTab("sell"); renderAll(); toast(`“${r.held.name}” is back on the bill.`); return true; }
  const hd = t.closest("[data-helddel]");
  if(hd){ if(!hd.dataset.confirm){ hd.dataset.confirm = "1"; hd.textContent = "Tap again to remove"; return true; }
    const r = discardHeld(hd.dataset.helddel); if(r.error) toast(r.error); renderAll(); return true; }
  const ov = t.closest("[data-ordview]"); if(ov){ chooseSubview("orders", ov.dataset.ordview); renderOrders(); return true; }
  const on = t.closest("[data-ordnew]"); if(on){ openOrderEditor(null, on.dataset.ordnew, false); return true; }
  const oc = t.closest("[data-ordfromcart]"); if(oc){ openOrderEditor(null, oc.dataset.ordfromcart, true); return true; }
  const oo = t.closest("[data-ordopen]"); if(oo){ openOrderEditor(oo.dataset.ordopen); return true; }
  const cv = t.closest("[data-ordconvert]"); if(cv){ convertAction(cv.dataset.ordconvert); return true; }
  const ob = t.closest("[data-ordbill]"); if(ob){ billAction(ob.dataset.ordbill); return true; }
  if(t.closest("[data-orddetach]")){ detachAction(); return true; }
  // payment screen, Credit: the bill needs a saved customer first
  if(t.closest("[data-paycust]")){ if(store.payState) payClosed(); store.payState = null; openCustPicker(); return true; }
  // a customer's account
  const co = t.closest("[data-collect]"); if(co){ openCollectForm(co.dataset.collect); return true; }
  const cm = t.closest("[data-colmethod]"); if(cm && store.collectForm){ collectMethod(cm.dataset.colmethod); return true; }
  const cc = t.closest("[data-colcancel]"); if(cc){ const cid = cancelCollectionAction(cc.dataset.colcancel); if(cid){ renderAll(); openCustHistory(cid); } return true; }
  return false;
}
export function creditOrdersInput(t){
  return !!(store.orderForm && orderFormInput(t)) || !!(store.collectForm && collectInput(t));
}
export function creditOrdersChange(t){
  return !!(store.orderForm && orderFormChange(t));
}
export function creditOrdersSubmit(e){
  if(e.target.id !== "collectForm") return false;
  e.preventDefault();
  const r = submitCollect();
  if(r){ renderAll(); openCustHistory(r.cid); }
  return true;
}
