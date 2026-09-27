// Bill view dialog.
import { lineLabel } from '../../../domain/catalog/options.js';
import { PAY_LABELS } from '../../../domain/sales/payments.js';
import { billMoney } from '../../finance/services/books-data.js';
import { D } from '../../inventory/services/ledger.js';
import { receiptHTML } from './receipt-view.js';
import { saleReturns } from '../services/receipt-model.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

/* ================= bill view (from Reports, the last bill, customers) ================= */

export function openBillView(sid){
  const s=D().saleById[sid]; if(!s) return;
  const M=billMoney(s);
  const money=`<div class="setsec"><h4>Payments</h4>${M.txns.length?M.txns.map(x=>`<div class="retline" data-txn="${esc(x.id)}"><b>${esc(PAY_LABELS[x.method]||x.method)}</b> · ${x.kind==="refund"?"refund −":""}${inrx(x.amount)}${x.ref?" · ref "+esc(x.ref):""}${x.change?` · received ${inrx(x.received)}, change ${inrx(x.change)}`:""}${x.status==="cancelled"?" · cancelled":""}</div>`).join(""):`<p class="note">Nothing was collected on this bill.</p>`}<p class="note">${M.ok?(s.void?"Cancelled — its payments are out of the cash and bank books.":`Payments match the amount due (${inrx(M.due)}).`):`Payments (${inrx(M.received)}) don't match the amount due (${inrx(M.due)}).`}</p></div>`;
  const rets=saleReturns(sid), canReturn=!s.void&&s.items.some((i,k)=>i.q-(D().retLine[s.id+"|"+(i.ln!=null?i.ln:k)]||0)>0);
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet billview" role="dialog" aria-modal="true" aria-label="Bill ${esc(s.no)}">
    <div class="sh-head"><div class="sh-t"><h3>Bill ${esc(s.no)}</h3><p>${esc(dtLong(s.t))}${s.void?" · cancelled":""}${s.kind==="exchange"?" · exchange":""}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="rcpt-prev">${receiptHTML(s,"80mm")}</div>
    ${money}
    ${rets.length?`<div class="setsec"><h4>Returns and exchanges</h4>${rets.map(r=>`<div class="retline"><b>${r.kind==="exchange"?"Exchange":"Return"}</b> · ${esc(dtLong(r.t))}<br>${r.items.map(i=>esc(i.n+(lineLabel(i)?" "+lineLabel(i):""))+" × "+i.q).join(", ")} · ${inr(r.value)}${r.refund?" · refunded "+inr(r.refund)+" ("+(PAY_LABELS[r.pay]||r.pay)+")":""}</div>`).join("")}</div>`:""}
    <div class="setactions"><button class="btn sm" data-print="${esc(s.id)}">Print</button><button class="btn sm" data-share="${esc(s.id)}">${navigator.share?"Share":"Download"}</button><button class="btn sm" data-wa="${esc(s.id)}">WhatsApp</button>
    ${canReturn?`<button class="btn sm" data-return="${esc(s.id)}">Return / exchange</button>`:""}
    ${s.void?`<button class="btn sm" data-unvoid="${esc(s.id)}">Restore bill</button>`:rets.length?"":`<button class="btn sm danger" data-void="${esc(s.id)}">Cancel bill</button>`}</div>
  </div></div>`;
}
