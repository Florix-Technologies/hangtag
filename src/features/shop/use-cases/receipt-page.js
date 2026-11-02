// The page a bill's secure invoice link opens. The server's RECEIPT_URL wins when it is set; otherwise the send-receipt
// function uses the shop's own settings.receiptUrl — the receipt page of the app the shop's owner uses (this app's
// receipt.html), so invoice links work without a server secret. Only the owner's app writes it (a team member's phone
// never does), only an https …/receipt.html address counts (domain/shop/settings-validation.js receiptPageUrl; the
// function checks it again), and it is written after the shop's settings came down from the cloud (onConnected).
import { store } from '../../../shared/state/store.js';
import { receiptPageUrl } from '../../../domain/shop/settings-validation.js';
import { can, isMember } from '../services/access.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { saveSettings } from '../../../shared/state/persistence.js';

/* This app's own receipt page, or "" (opened from a file, or plain http on another computer) */
export const appReceiptPage = () => receiptPageUrl(typeof location !== "undefined" ? location.href : "");
/* The page the shop's invoice links open now ("" when the server's RECEIPT_URL decides or nothing is set) */
export const shopReceiptPage = () => (store.settings && store.settings.receiptUrl) || "";
/* The owner's app keeps the shop's receipt page: set once, or set to this app again (force, from Settings). → true when
   it changed (and the shop's settings are uploaded) */
export function rememberReceiptPage(force){
  if(isMember() || !can("manage_settings")) return false;
  const url = appReceiptPage(); if(!url) return false;
  const cur = shopReceiptPage();
  if(cur === url || (cur && !force)) return false;
  store.settings = { ...store.settings, receiptUrl: url }; saveSettings(); enqueue({ type: "settings" }); flushSbQueue();
  return true;
}
