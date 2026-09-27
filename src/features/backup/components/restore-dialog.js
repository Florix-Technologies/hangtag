// Restore preview dialog.
import { store } from '../../../shared/state/store.js';
import { inspectBackup } from '../services/backup-file.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { logger } from '../../../shared/logging/logger.js';

export async function restoreBackup(file){
  let data=null;try{data=JSON.parse(await file.text())}catch(e){logger.warn("Backup parse failed:",e)}
  const r=inspectBackup(data);
  if(!r.ok){toast(r.errs[0]||"That file isn't a Hangtag backup.");return}
  store.restoreCheck=r;const S=r.summary;
  const li=(a,b)=>`<div class="row"><span>${a}</span><span class="tnum">${b}</span></div>`;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="Restore backup">
    <div class="sh-head"><div class="sh-t"><h3>Restore this backup?</h3><p>${S.exportedAt?"Made "+esc(dtLong(Date.parse(S.exportedAt)||Date.now()))+". ":""}Nothing on this device is deleted. Only things that aren't here yet are added.</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="rt-sum">${li("Products",`${S.products} · ${S.newProducts} new`)}${li("Variants",S.variants)}${li("Bills",`${S.bills} · ${S.newBills} new`)}${li("Stock records",`${S.moves} · ${S.newMoves} new`)}${li("Returns",`${S.returns} · ${S.newReturns} new`)}${li("Customers",`${S.customers} · ${S.newCustomers} new`)}</div>
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="rsReplace"> Also replace products that are on both, with the backup's version</label>
    <div class="setactions"><button class="btn sm primary" data-act="restorego">Restore</button><button class="btn sm" data-modal-close>Cancel</button></div>
  </div></div>`;
}
