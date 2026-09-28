// Restore preview dialog: the backup is read and checked first (Hangtag file, not damaged, not from a newer version, this
// shop's or restoring into an empty shop); nothing changes until Restore is pressed.
import { store } from '../../../shared/state/store.js';
import { inspectBackup, readBackup } from '../services/backup-file.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { logger } from '../../../shared/logging/logger.js';

export async function restoreBackup(file){
  let json=null;try{json=JSON.parse(await file.text())}catch(e){logger.warn("Backup parse failed:",e)}
  const B=await readBackup(json);
  if(B.integrity==="bad"){toast("This backup file is damaged or was changed (its check doesn't match), so it can't be restored.");return}
  const r=inspectBackup(B.data,B.file);
  if(!r.ok){toast(r.errs[0]||"That file isn't a Hangtag backup.");return}
  store.restoreCheck=r;const S=r.summary, hasData=!!(store.catalog&&store.catalog.products&&store.catalog.products.length);
  const li=(a,b)=>`<div class="row"><span>${a}</span><span class="tnum">${b}</span></div>`;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="Restore backup">
    <div class="sh-head"><div class="sh-t"><h3>Restore this backup?</h3><p>${S.exportedAt?"Made "+esc(dtLong(Date.parse(S.exportedAt)||Date.now()))+". ":""}${S.shop?"Shop: "+esc(S.shop)+". ":""}Nothing on this device is deleted. Only things that aren't here yet are added.</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="rt-sum">${li("Products",`${S.products} · ${S.newProducts} new`)}${li("Variants",S.variants)}${li("Bills",`${S.bills} · ${S.newBills} new`)}${li("Stock records",`${S.moves} · ${S.newMoves} new`)}${li("Returns",`${S.returns} · ${S.newReturns} new`)}${li("Customers",`${S.customers} · ${S.newCustomers} new`)}${S.events?li("Events",`${S.events} · ${S.newEvents} new`):""}</div>
    <p class="note">${B.integrity==="ok"?`${ICON.ok} File checked: complete and unchanged.`:"Older backup (made before files carried a check)."}${S.skipped?` ${S.skipped} damaged record${S.skipped===1?"":"s"} will be left out.`:""}${S.fromOtherShop?" From another shop: restoring into this empty shop.":""}</p>
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="rsReplace"> Also replace products that are on both, with the backup's version</label>
    ${hasData?`<label class="chk"><input type="checkbox" id="rsSafety" checked> First download a copy of what's on this device now</label>`:""}
    <div class="setactions"><button class="btn sm primary" data-act="restorego">Restore</button><button class="btn sm" data-modal-close>Cancel</button></div>
  </div></div>`;
}
