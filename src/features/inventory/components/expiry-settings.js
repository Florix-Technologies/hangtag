// Settings → Capabilities → Expiry: how many days before a batch expires it shows as "expiring soon", and whether expired
// stock may still be sold (by default it can't: a bill takes only batches that haven't expired). Part of the shop's synced
// settings (settings.expiryDays, settings.sellExpired); shown to a shop that keeps expiry dates or batches.
import { store } from '../../../shared/state/store.js';
import { checkExpirySettings } from '../../../domain/shop/settings-validation.js';
import { blockExpired, expiryDays } from '../services/tracking.js';
import { denied } from '../../shop/services/access.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { toast } from '../../../shared/components/toast.js';
import { $ } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';

export function expirySettingsHTML(){
  return `<div class="setsec" id="expirySetup"><h4>Expiry</h4>
    <form id="expiryForm" class="authform" novalidate><div class="pgrid">
      <label class="f"><span class="lab">Warn before expiry (days)</span><input name="expiryDays" type="number" inputmode="numeric" min="0" max="365" value="${expiryDays()}"><span class="fhint">Batches expiring within this many days show as “expiring soon”.</span></label>
      <label class="chk full"><input type="checkbox" name="sellExpired"${blockExpired()?"":" checked"}> Expired stock may still be sold</label>
    </div>
    <p id="expiryErr" class="autherr" role="alert" hidden></p>
    <div class="setactions"><button class="btn sm primary" type="submit">Save expiry settings</button></div></form></div>`;
}
/* SaveExpirySettings (needs manage_settings; saved on this device, then uploaded with the shop's settings) → { error } | { ok } */
export function saveExpirySettings(input){
  const no=denied("manage_settings","change the expiry settings"); if(no) return no;
  const r=checkExpirySettings(input); if(r.error) return r;
  store.settings=Object.assign({},store.settings,r.patch); saveSettings(); enqueue({type:"settings"});
  return {ok:true};
}
export function expirySubmit(e){
  if(e.target.id!=="expiryForm") return false;
  e.preventDefault();
  const f=new FormData(e.target), r=saveExpirySettings({expiryDays:f.get("expiryDays"),sellExpired:!!f.get("sellExpired")}), err=$("#expiryErr");
  if(r.error){ if(err){ err.textContent=r.error; err.hidden=false; } return true; }
  if(err) err.hidden=true;
  renderSync(); flushSbQueue(); renderAll(); toast("Expiry settings saved.");
  return true;
}
