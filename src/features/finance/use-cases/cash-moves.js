// Cash without a bill and closing the day (spec 007): record an opening float, cash in, cash out or an expense; reverse
// one with a reason; work out the cash the drawer should hold (for the shop, or for one device); close the day with the
// counted cash. Entries go through the "cashRepository" port (this device first, then uploaded).
import { cashBook, financialTransactions } from '../../../domain/finance/books.js';
import { DEFAULT_EXPENSE_CATS, changedAfterClose, checkCashMove, checkExpenseCats, dayClose } from '../../../domain/finance/cash-moves.js';
import { D } from '../../inventory/services/ledger.js';
import { dayBounds } from '../services/books-data.js';
import { sellingEventId } from '../../events/services/selling-context.js';
import { cashRepository } from '../repositories/cash-repository.js';
import { store } from '../../../shared/state/store.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied, userId } from '../../shop/services/access.js';

export const expenseCats=()=>Array.isArray(store.settings.expenseCats)&&store.settings.expenseCats.length?store.settings.expenseCats:DEFAULT_EXPENSE_CATS;
const byId=()=>Object.fromEntries(cashRepository().moves().map(m=>[m.id,m]));
const upload=()=>{ renderSync(); flushSbQueue(); };

/* input: { type, amount, reason, category?, reverses? } → { move } or { error, field } */
export function recordCashMove(input){
  const no=denied("create_sale","record cash"); if(no) return no;
  const r=checkCashMove(input,{byId:byId(),cats:expenseCats()});
  if(r.error) return r;
  const ev=sellingEventId();
  const move={id:"cm"+uid(),...r.move,t:Date.now(),dev:store.dev,...(userId()?{user:userId()}:{}),...(ev?{event:ev}:{})};
  cashRepository().record(move); upload();
  return {move};
}
/* The shop's expense categories, edited: list of names → { ok } or { error } */
export function saveExpenseCats(list){
  const no=denied("manage_settings","change the shop's settings"); if(no) return no;
  const r=checkExpenseCats(list); if(r.error) return r;
  store.settings=Object.assign({},store.settings,{expenseCats:r.cats}); saveSettings(); enqueue({type:"settings"}); upload();
  return {ok:true};
}
/* The cash book of one day, for the shop ("shop") or one device (its id) */
export function dayCash(day,scope="shop"){
  const d=D(), mine=x=>scope==="shop"||(x&&x.dev===scope);
  const tx=financialTransactions(d.sales.filter(mine),d.rets.filter(mine),cashRepository().moves().filter(mine));
  return cashBook(tx,dayBounds(day,day));
}
export const closeId=(day,scope)=>`dc:${day}:${scope||"shop"}`;
export const closeOf=(day,scope)=>(store.dayCloses||{})[closeId(day,scope)]||null;
/* The close of a day as it stands: { close, expectedNow, changed } (changed: entries arrived after the day was closed) */
export function closeState(day,scope="shop"){
  const close=closeOf(day,scope), expectedNow=dayCash(day,scope).closing;
  return {close,expectedNow,changed:changedAfterClose(close,expectedNow)};
}
/* { day (default today), scope, counted, note } → { close } or { error } */
export function closeDay({day,scope,counted,note}){
  const no=denied("create_sale","close the day"); if(no) return no;
  const dk=day||dayKey(Date.now()), sc=scope||"shop";
  const r=dayClose({day:dk,scope:sc,expected:dayCash(dk,sc).closing,counted,note});
  if(r.error) return r;
  const close={id:closeId(dk,sc),...r.close,t:Date.now(),dev:store.dev};
  cashRepository().close(close); upload();
  return {close};
}
