// Cash that moves without a bill (spec 007): the day's opening float, cash put in, cash taken out and expenses — each an
// entry that is never edited or deleted; a mistake is put right with a reversal entry that names the entry and why. The
// day close keeps what the drawer should hold, what was counted and the difference. Pure; rupees, added up in paise.
import { toPaise, toRupees, tooPrecise } from '../sales/paise.js';
import { inr } from '../../shared/formatting/money.js';

export const CASH_MOVE_TYPES=["opening","in","out","expense","reversal"];
export const CASH_MOVE_LABELS={opening:"Opening float",in:"Cash in",out:"Cash out",expense:"Expense",reversal:"Reversal"};
export const DEFAULT_EXPENSE_CATS=["Transport","Food","Rent","Salary","Supplies","Event fees","Other"];
export const MAX_CASH_MOVE=1000000;

/* Which way the money goes: into the drawer ("in") or out of it ("out"). A reversal goes the other way to its entry. */
export function moveDirection(m,byId){
  if(m.type==="reversal"){ const o=byId&&byId[m.reverses]; return o?(moveDirection(o,byId)==="in"?"out":"in"):"out"; }
  return m.type==="opening"||m.type==="in"?"in":"out";
}
/* input: { type, amount, reason, category? , reverses? } · ctx: { byId (existing entries), cats (expense categories) }
   → { error, field } or { ok: true, move: { type, amount, reason, category?, reverses? } } */
export function checkCashMove(input,ctx={}){
  const type=input&&input.type, cats=ctx.cats&&ctx.cats.length?ctx.cats:DEFAULT_EXPENSE_CATS, byId=ctx.byId||{};
  if(!CASH_MOVE_TYPES.includes(type)) return {error:"Choose opening float, cash in, cash out or expense.",field:"type"};
  const reason=String(input.reason==null?"":input.reason).trim().replace(/\s+/g," ");
  if(type==="reversal"){
    const o=byId[input.reverses];
    if(!o) return {error:"That entry wasn't found.",field:"reverses"};
    if(o.type==="reversal") return {error:"A reversal can't be reversed. Add a new entry instead.",field:"reverses"};
    if(Object.values(byId).some(m=>m.type==="reversal"&&m.reverses===o.id)) return {error:"That entry has been reversed already.",field:"reverses"};
    if(reason.length<3) return {error:"Say why it's being reversed (at least 3 characters).",field:"reason"};
    return {ok:true,move:{type,amount:o.amount,reason:reason.slice(0,200),reverses:o.id}};
  }
  const a=+String(input.amount==null?"":input.amount).trim();
  if(!Number.isFinite(a)||a<=0) return {error:`Enter an amount more than ${inr(0)}.`,field:"amount"};
  if(tooPrecise(a)) return {error:"Use at most 2 decimal places.",field:"amount"};
  if(a>MAX_CASH_MOVE) return {error:"That amount is too large for one entry.",field:"amount"};
  const c=String(input.category||"").trim();
  if(type==="expense"&&(!c||!cats.includes(c))) return {error:"Choose a category for the expense.",field:"category"};
  if(type!=="opening"&&reason.length<3) return {error:"Write a reason (at least 3 characters).",field:"reason"};
  const move={type,amount:toRupees(toPaise(a)),reason:(reason||"Opening float").slice(0,200)};
  if(type==="expense") move.category=c;
  return {ok:true,move};
}
/* Editable expense categories: 1-40 characters each, no repeats, at most 30 */
export function checkExpenseCats(list){
  const out=[];
  for(const x of list||[]){ const c=String(x||"").trim().replace(/\s+/g," "); if(!c) continue; if(c.length>40) return {error:"A category can be at most 40 characters."}; if(!out.some(y=>y.toLowerCase()===c.toLowerCase())) out.push(c); }
  if(!out.length) return {error:"Keep at least one category."};
  if(out.length>30) return {error:"At most 30 categories."};
  return {ok:true,cats:out};
}
/* The day's close: expected cash (from the cash book), counted cash and the difference */
export function dayClose({day,scope,expected,counted,note}){
  const c=+String(counted==null?"":counted).trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day||""))) return {error:"Which day?"};
  if(!Number.isFinite(c)||c<0||tooPrecise(c)) return {error:"Enter the cash counted in the drawer.",field:"counted"};
  const e=toRupees(toPaise(expected));
  return {ok:true,close:{day,scope:scope||"shop",expected:e,counted:toRupees(toPaise(c)),diff:toRupees(toPaise(c)-toPaise(e)),note:String(note||"").trim().slice(0,200)}};
}
/* A close whose day has changed since (entries arrived later): "Changed after close" */
export const changedAfterClose=(close,expectedNow)=>!!close&&toPaise(close.expected)!==toPaise(expectedNow);
