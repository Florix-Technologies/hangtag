// The sheet for cash without a bill: opening float, cash in, cash out, expense (with a category), reversing an entry,
// and closing the day with the counted cash (for the shop or this device).
import { CASH_MOVE_LABELS } from '../../../domain/finance/cash-moves.js';
import { closeDay, closeState, dayCash, expenseCats, recordCashMove } from '../use-cases/cash-moves.js';
import { store } from '../../../shared/state/store.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { inrx, moneyLabel } from '../../../shared/formatting/money.js';
import { renderAll } from '../../../shared/ui/render.js';
import { refuse } from '../../shop/services/access.js';

const HINT={opening:"Cash put in the drawer at the start of the day.",in:"Cash added to the drawer, e.g. change brought from the bank.",
  out:"Cash taken out, e.g. banked or handed to the owner.",expense:"Cash spent on the shop."};
/* kind: "opening" | "in" | "out" | "expense" | "close" | "reverse:<entry id>" */
export function openCashForm(kind){
  if(refuse("create_sale","record cash"))return;
  if(kind==="close") store.cashForm={kind:"close",day:dayKey(Date.now()),scope:"shop",counted:"",note:"",err:""};
  else if(kind.startsWith("reverse:")) store.cashForm={kind:"reverse",id:kind.slice(8),reason:"",err:""};
  else store.cashForm={kind:"move",type:kind,amount:"",reason:"",category:"",err:""};
  renderCashForm(true);
}
const f=(label,input)=>`<label class="f"><span class="lab">${label}</span>${input}</label>`;
export function renderCashForm(focus){
  const F=store.cashForm; if(!F) return;
  let title, body, go;
  if(F.kind==="close"){
    const B=dayCash(F.day,F.scope), S=closeState(F.day,F.scope);
    title="Close the day";
    body=`<div class="pgrid">${f("Day",`<input type="date" name="day" value="${esc(F.day)}" max="${esc(dayKey(Date.now()))}">`)}
      ${f("For",`<select name="scope"><option value="shop"${F.scope==="shop"?" selected":""}>The whole shop</option><option value="${esc(store.dev)}"${F.scope===store.dev?" selected":""}>This device only</option></select>`)}</div>
      <div class="bookkpis"><div><span>Opening</span><b>${inrx(B.opening)}</b></div><div><span>Cash sales</span><b>${inrx(B.cashSales)}</b></div><div><span>In / float</span><b>${inrx(B.cashIn+B.openingFloat)}</b></div>
        <div><span>Out + expenses + refunds</span><b>−${inrx(B.cashOut+B.expenses+B.refunds)}</b></div><div class="hl"><span>Expected in the drawer</span><b data-expected>${inrx(B.closing)}</b></div></div>
      ${S.close?`<p class="note">Closed before at ${esc(hhmm(S.close.t))}: counted ${inrx(S.close.counted)}, difference ${inrx(S.close.diff)}${S.changed?` · <b>changed after close</b> (expected then ${inrx(S.close.expected)})`:""}. Closing again replaces it.</p>`:""}
      <div class="pgrid">${f("Cash counted",`<input name="counted" type="number" inputmode="decimal" min="0" step="any" value="${esc(F.counted)}" required>`)}${f("Note <small>(optional)</small>",`<input name="note" maxlength="200" value="${esc(F.note)}">`)}</div>`;
    go="Close the day";
  }else if(F.kind==="reverse"){
    const m=(store.cashMoves||{})[F.id];
    title="Reverse an entry";
    body=m?`<p class="note">${esc(CASH_MOVE_LABELS[m.type])} · ${inrx(m.amount)} · ${esc(m.reason)} · ${esc(dayLab(dayKey(m.t)))} ${esc(hhmm(m.t))}</p><p class="note">The entry stays in the book; a reversal for the same amount is added next to it.</p>
      ${f("Why is it being reversed?",`<input name="reason" maxlength="200" value="${esc(F.reason)}" required>`)}`:`<p class="note">That entry wasn't found.</p>`;
    go="Reverse it";
  }else{
    title=CASH_MOVE_LABELS[F.type];
    body=`<p class="note">${esc(HINT[F.type]||"")}</p><div class="pgrid">${f(moneyLabel("Amount"),`<input name="amount" type="number" inputmode="decimal" min="0" step="any" value="${esc(F.amount)}" required>`)}
      ${F.type==="expense"?f("Category",`<select name="category"><option value="">Choose…</option>${expenseCats().map(c=>`<option${c===F.category?" selected":""}>${esc(c)}</option>`).join("")}</select>`):""}
      ${f(F.type==="opening"?"Note <small>(optional)</small>":"Reason",`<input name="reason" maxlength="200" value="${esc(F.reason)}"${F.type==="opening"?"":" required"}>`)}</div>`;
    go="Save";
  }
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-labelledby="cashT">
    <div class="sh-head"><div class="sh-t"><h3 id="cashT">${esc(title)}</h3><p>Cash book</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <form id="cashForm" class="authform" novalidate>${body}<p id="cashErr" class="autherr" role="alert"${F.err?"":" hidden"}>${esc(F.err)}</p>
    <div class="setactions"><button class="btn sm primary" type="submit">${esc(go)}</button><button class="btn sm" type="button" data-modal-close>Cancel</button></div></form></div></div>`;
  if(focus){ const i=$("#cashForm input:not([type=date]),#cashForm select"); if(i) i.focus({preventScroll:true}); }
}
/* A field changed that changes the figures (the day or who it's for) */
export function cashFormChange(form){
  const F=store.cashForm; if(!F||F.kind!=="close") return;
  const d=new FormData(form); F.day=d.get("day")||F.day; F.scope=d.get("scope")||"shop"; F.counted=d.get("counted")||""; F.note=d.get("note")||"";
  renderCashForm(false);
}
export function submitCashForm(form){
  const F=store.cashForm; if(!F) return;
  const d=new FormData(form);
  let r;
  if(F.kind==="close"){ Object.assign(F,{day:d.get("day")||F.day,scope:d.get("scope")||"shop",counted:d.get("counted"),note:d.get("note")}); r=closeDay(F); }
  else if(F.kind==="reverse"){ F.reason=d.get("reason"); r=recordCashMove({type:"reversal",reverses:F.id,reason:F.reason}); }
  else { Object.assign(F,{amount:d.get("amount"),reason:d.get("reason")||"",category:d.get("category")||""}); r=recordCashMove(F); }
  if(r.error){ F.err=r.error; renderCashForm(false); return; }
  store.cashForm=null; closeModal(); renderAll();
  toast(F.kind==="close"?`Day closed · counted ${inrx(r.close.counted)} · difference ${inrx(r.close.diff)}.`:F.kind==="reverse"?"Entry reversed.":`${CASH_MOVE_LABELS[r.move.type]} of ${inrx(r.move.amount)} saved.`);
}
