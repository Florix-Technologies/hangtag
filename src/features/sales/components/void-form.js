// Cancelling a completed bill (spec 006): a reason is required; the bill keeps its number and is marked cancelled, its
// stock goes back and its payments leave the books. A bill in a month already exported for GST can still be cancelled,
// with a warning that the export must be done again.
import { VOID_REASONS, voidSale } from '../use-cases/checkout.js';
import { D } from '../../inventory/services/ledger.js';
import { store } from '../../../shared/state/store.js';
import { closeModal } from '../../../shared/components/modal.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dtLong } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';
import { canAny, notAllowedText } from '../../shop/services/access.js';
import { CANCEL_BILL } from '../../../domain/shop/permissions.js';
import { toast } from '../../../shared/components/toast.js';

export function openVoidForm(sid){
  if(!canAny(CANCEL_BILL)){ toast(notAllowedText("cancel bills")); return; }
  if(!D().saleById[sid]) return;
  store.voidForm={sid,reason:VOID_REASONS[0],note:"",err:""};
  renderVoidForm();
}
function renderVoidForm(){
  const F=store.voidForm; if(!F) return;
  const s=D().saleById[F.sid], month=dayKey(s.t).slice(0,7), exported=(store.settings.gstExports||[]).some(x=>x.period===month);
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-labelledby="voidT">
    <div class="sh-head"><div class="sh-t"><h3 id="voidT">Cancel bill ${esc(s.no)}</h3><p>${esc(dtLong(s.t))} · ${inrx(s.total)}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <form id="voidForm" class="authform" novalidate>
      <p class="note">The bill keeps its number and shows as cancelled. Its pieces go back into stock and its payments leave the cash and bank books — hand back any money taken.</p>
      ${exported?`<p class="note warnline">${ICON.warn} ${esc(month)} has been exported for GST. Export it again after cancelling, and correct what was filed.</p>`:""}
      <label class="f"><span class="lab">Why is it cancelled?</span><select name="reason">${VOID_REASONS.map(r=>`<option${r===F.reason?" selected":""}>${esc(r)}</option>`).join("")}</select></label>
      <label class="f"><span class="lab">Details ${F.reason==="Other"?"":"<small>(optional)</small>"}</span><input name="note" maxlength="160" value="${esc(F.note)}"></label>
      <p id="voidErr" class="autherr" role="alert"${F.err?"":" hidden"}>${esc(F.err)}</p>
      <div class="setactions"><button class="btn sm danger" type="submit">Cancel the bill</button><button class="btn sm" type="button" data-modal-close>Keep the bill</button></div>
    </form></div></div>`;
}
export function voidFormChange(form){ const F=store.voidForm; if(!F) return; const d=new FormData(form); F.reason=d.get("reason"); F.note=d.get("note")||""; renderVoidForm(); }
export async function submitVoidForm(form){
  const F=store.voidForm; if(!F) return;
  const d=new FormData(form); F.reason=d.get("reason"); F.note=String(d.get("note")||"").trim();
  const why=F.reason==="Other"?F.note:F.reason+(F.note?" — "+F.note:"");
  const r=await voidSale(F.sid,why);
  if(r&&r.error){ F.err=F.reason==="Other"&&!F.note?"Write why the bill is cancelled.":r.error; renderVoidForm(); return; }
  store.voidForm=null; closeModal();
}
