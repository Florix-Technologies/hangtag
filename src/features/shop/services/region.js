// The shop's region (shared/formatting/regions.js) from its settings (settings.region; India when not set): money, numbers
// and dates are written its way, and phone numbers dialled with its country code. Applied before each screen is drawn,
// so a change synced from another device shows at once.
import { regionOf } from '../../../shared/formatting/regions.js';
import { configureMoney } from '../../../shared/formatting/money.js';
import { configureDates } from '../../../shared/formatting/dates.js';
import { store } from '../../../shared/state/store.js';

export const shopRegion = () => regionOf(store.settings && store.settings.region);
let applied = "";
export function applyRegion(){
  const r = shopRegion(); if(r.code === applied) return r;
  configureMoney(r); configureDates(r.locale); applied = r.code;
  return r;
}
