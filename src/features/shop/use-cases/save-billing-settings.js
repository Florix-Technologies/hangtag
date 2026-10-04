// SaveBillingSettings: check and store the billing and stock settings (this device first, then uploaded).
import { store } from '../../../shared/state/store.js';
import { checkBillingSettings, checkGstSettings, checkPaymentSettings, checkReorderSettings } from '../../../domain/shop/settings-validation.js';
import { enqueue } from '../../sync/services/outbox.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { can, notAllowedText } from '../services/access.js';
import { checkDocSettings } from '../../../domain/documents/doc-settings.js';
import { deviceTill } from '../../sales/services/doc-numbers.js';

/* input: { lowStock, taxOn, taxRate, taxIncl, paper, footer, and the bill numbering (prefix, invoiceStart, invoicePadding,
   invoiceSuffix) when its form was sent } as typed. Returns { error, field } or { ok:true }. */
export function saveBillingSettings(input){
  if(!can("manage_settings"))return {error:notAllowedText("change the shop's settings")};
  const r=checkBillingSettings(input,{till:deviceTill()});
  if(r.error)return {error:r.error,field:r.field};
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
/* Purchasing → reorder planning: { leadDays, safetyDays, targetCoverDays } (manage_settings or create_purchase) */
export function saveReorderSettings(input){
  if(!can("manage_settings")&&!can("create_purchase"))return {error:notAllowedText("change how Smart reorder plans")};
  const r=checkReorderSettings(input);
  if(r.error)return {error:r.error};
  store.settings=Object.assign({},store.settings,r.patch);
  saveSettings();if(can("manage_settings"))enqueue({type:"settings"});
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
/* Billing & Documents → Templates: { docTpl, docAccent, docGst, docTerms, docSign, docBank } → { ok } or { error, field } */
export function saveDocSettings(input){
  if(!can("manage_settings"))return {error:notAllowedText("change the shop's document templates")};
  const r=checkDocSettings(input);
  if(r.error)return r;
  store.settings=Object.assign({},store.settings,r.patch);
  saveSettings();enqueue({type:"settings"});
  return {ok:true};
}
