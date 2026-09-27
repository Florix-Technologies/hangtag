// SaveBillingSettings: check and store the billing and stock settings (this device first, then uploaded).
import { store } from '../../../shared/state/store.js';
import { checkBillingSettings } from '../../../domain/shop/settings-validation.js';
import { enqueue } from '../../sync/services/outbox.js';
import { saveSettings } from '../../../shared/state/persistence.js';

/* input: { lowStock, taxOn, taxRate, taxIncl, prefix, paper, footer } as typed. Returns { error } or { ok:true }. */
export function saveBillingSettings(input){
  const r=checkBillingSettings(input);
  if(r.error)return {error:r.error};
  store.settings=Object.assign({},store.settings,r.patch);
  saveSettings();enqueue({type:"settings"});
  return {ok:true};
}
