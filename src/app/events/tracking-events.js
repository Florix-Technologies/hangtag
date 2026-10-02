// Delegated events of serial numbers, batches and expiry: the serial picker at the till, a bill line's serials and batch,
// an exchange's serial-tracked items, and the serials coming back on a return (the parts on the stock pages route their own
// through features/inventory/components/inventory-views.js). Each handler answers whether it took the event.
import { store } from '../../shared/state/store.js';
import { serialPickChange, serialPickClick, serialPickInput, serialPickSubmit } from '../../features/sales/components/serial-picker.js';
import { pickSerials, removeSerial } from '../../features/sales/services/cart.js';
import { isSerialV } from '../../features/inventory/services/tracking.js';
import { renderReturnSheet, setReturnSerial } from '../../features/returns/components/return-sheet.js';
import { saveCart } from '../../shared/state/persistence.js';
import { renderAll } from '../../shared/ui/render.js';
import { renderBillSheet } from '../../features/sales/components/bill-panel.js';
import { openStockOp } from '../../features/inventory/components/stock-operation.js';
import { expirySubmit } from '../../features/inventory/components/expiry-settings.js';

export function trackingClick(t){
  if(serialPickClick(t)) return true;
  // adjust a tracked product's stock (by serial or batch) from the stock page
  const adj=t.closest("[data-stockadjp]"); if(adj){ openStockOp("adjust",adj.dataset.stockadjp); return true; }
  // an exchange's new items tracked by serial number: + chooses another piece, − takes the last one off
  const R=store.retState;
  const exp=R&&t.closest("[data-exp]"); if(exp){ const c=R.newItems[+exp.dataset.exp]; if(c&&isSerialV(c.v)){ pickSerials(c.p,c.v,"exchange"); return true; } }
  const exm=R&&t.closest("[data-exm]"); if(exm){ const i=+exm.dataset.exm, c=R.newItems[i]; if(c&&isSerialV(c.v)){ if(Array.isArray(c.sn)&&c.sn.length) removeSerial(R.newItems,i,c.sn[c.sn.length-1]); else R.newItems.splice(i,1); renderReturnSheet(); return true; } }
  return false;
}
export const trackingInput=t=>serialPickInput(t);
export function trackingChange(t){
  if(serialPickChange(t)) return true;
  // the batch a bill line comes from ("": first to expire)
  if(t.matches("[data-linebatch]")){ const c=store.cart[+t.dataset.linebatch]; if(c){ if(t.value) c.bp=t.value; else delete c.bp; saveCart(); } renderAll(); if(store.billOpen) renderBillSheet(); return true; }
  // a serial coming back on a return
  if(t.matches("[data-rtsn]")&&store.retState){ const k=t.dataset.rtsn.indexOf("|"); setReturnSerial(+t.dataset.rtsn.slice(0,k),t.dataset.rtsn.slice(k+1),t.checked); return true; }
  return false;
}
export const trackingSubmit=e=>serialPickSubmit(e)||expirySubmit(e);
