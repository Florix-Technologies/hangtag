// Clicks, typing and forms of the commerce batch's sheets (price lists, purchase orders and receiving, kits, gift
// vouchers, GST documents, repack, webhooks). app/events/dom-events.js hands each event here first; a handler returns true
// when it dealt with the event.
import { store } from '../../shared/state/store.js';
import { closeBiz } from '../../features/commerce/components/biz-sheet.js';
import { priceListsChange, priceListsClick, priceListsInput, priceListsSubmit } from '../../features/commerce/components/price-lists.js';
import { purchaseOrdersChange, purchaseOrdersClick, purchaseOrdersInput, purchaseOrdersSubmit } from '../../features/inventory/components/purchase-orders.js';
import { kitClick, kitInput } from '../../features/products/components/kit-editor.js';
import { gstChange, gstClick, gstInput, gstSubmit } from '../../features/commerce/components/gst-documents.js';
import { vouchersClick, vouchersInput } from '../../features/commerce/components/vouchers.js';
import { repackChange, repackClick, repackInput } from '../../features/inventory/components/repack-sheet.js';
import { webhooksClick, webhooksInput } from '../../features/commerce/components/webhooks.js';

const CLICKS = [priceListsClick, purchaseOrdersClick, kitClick, gstClick, vouchersClick, repackClick, webhooksClick];
const INPUTS = [priceListsInput, purchaseOrdersInput, kitInput, gstInput, vouchersInput, repackInput, webhooksInput];
const CHANGES = [priceListsChange, purchaseOrdersChange, gstChange, repackChange];
const SUBMITS = [priceListsSubmit, gstSubmit, purchaseOrdersSubmit];
/* Later parts of the batch add their handlers here (each returns true when it dealt with the event) */
export function addCommerceHandlers({ click, input, change, submit } = {}){
  if(click) CLICKS.push(click); if(input) INPUTS.push(input); if(change) CHANGES.push(change); if(submit) SUBMITS.push(submit);
}
export function commerceClick(t){
  // the sheet's own close button, or a tap beside it while one of these sheets is open
  if(t.closest("[data-biz='close']") || (store.bizView && t.matches("[data-bizscrim]"))){ closeBiz(); return true; }
  return CLICKS.some(h => h(t));
}
export const commerceInput = t => INPUTS.some(h => h(t));
export const commerceChange = t => CHANGES.some(h => h(t));
export const commerceSubmit = e => SUBMITS.some(h => h(e));
