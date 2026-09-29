// SaveBillingSettings: check and store the billing and stock settings (this device first, then uploaded).
import { store } from '../../../shared/state/store.js';
import { checkBillingSettings, checkGstSettings, checkPaymentSettings } from '../../../domain/shop/settings-validation.js';
import { enqueue } from '../../sync/services/outbox.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { can, notAllowedText } from '../services/access.js';

/* input: { lowStock, taxOn, taxRate, taxIncl, prefix, paper, footer } as typed. Returns { error } or { ok:true }. */
export function saveBillingSettings(input){
  if(!can("manage_settings"))return {error:notAllowedText("change the shop's settings")};
  const r=checkBillingSettings(input);
  if(r.error)return {error:r.error};
  store.settings=Object.assign({},store.settings,r.patch);
  saveSettings();enqueue({type:"settings"});
  return {ok:true};
}
/* Payments and receipts: { upiId, payExpiry, whatsapp, sms, email } as typed. Returns { error } or { ok:true }. */
export function savePaymentSettings(input){
  if(!can("manage_settings"))return {error:notAllowedText("change the shop's settings")};
  const r=checkPaymentSettings(input,store.channels);
  if(r.error)return {error:r.error};
  store.settings=Object.assign({},store.settings,r.patch);
  saveSettings();enqueue({type:"settings"});
  return {ok:true};
}
/* GST filing preparation: { b2clLimit } */
export function saveGstSettings(input){
  if(!can("manage_settings"))return {error:notAllowedText("change the shop's settings")};
  const r=checkGstSettings(input);
  if(r.error)return {error:r.error};
  store.settings=Object.assign({},store.settings,r.patch);
  saveSettings();enqueue({type:"settings"});
  return {ok:true};
}
