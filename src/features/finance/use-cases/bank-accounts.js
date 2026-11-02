// Bank accounts (Settings → Payments & Banks; rules in domain/finance/bank-accounts.js): add and change the shop's accounts,
// record money moved by hand (in, out, transfer, adjustment), reverse a mistake, and read each account's ledger and the
// balances. Kept on this device first with the commerce records ("bizRepository" kinds ba and bm) and uploaded from there
// (schema.sql section 3s). The UPI and card money of the bank book lands in the account its method maps to.
import { store } from '../../../shared/state/store.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { can, notAllowedText } from '../../shop/services/access.js';
import { bankBalances, bankLedger, checkBankAccount, checkBankMove, exclusiveChanges, methodAccounts, reverseBankMove } from '../../../domain/finance/bank-accounts.js';
import { bankBook } from '../../../domain/finance/books.js';
import { shopTransactions } from '../services/books-data.js';
import { uid } from '../../../shared/utils/ids.js';
import { dayKey } from '../../../shared/formatting/dates.js';

export const bankAccounts = () => bizRepository().list("ba");
export const bankMoves = () => bizRepository().list("bm");
export const bankAccount = id => bizRepository().get("ba", id);
/* May the person signed in see the accounts, change them, record entries? */
export const mayViewBanks = () => can("view_reports") || can("manage_settings");
export const mayEditBanks = () => can("manage_settings");
/* Add or change an account: { id?, name, bank, last4, opening, openingDate, active, isDefault, methods } → { account } | { error, field } */
export function saveBankAccount(input){
  if(!mayEditBanks()) return { error: notAllowedText("change the shop's bank accounts") };
  const r = checkBankAccount(input, dayKey(Date.now()));
  if(r.error) return r;
  const old = input && input.id ? bankAccount(input.id) : null, others = bankAccounts().filter(a => !old || a.id !== old.id);
  const acct = Object.assign({}, r.account, { id: old ? old.id : "ba_" + uid() });
  if(!others.some(a => a.active !== false)) acct.isDefault = acct.active !== false;   // the only account is the default
  if(acct.isDefault && acct.active === false) return { error: "The default account can't be switched off. Make another account the default first.", field: "active" };
  exclusiveChanges(others, acct).forEach(a => bizRepository().save("ba", a));
  bizRepository().save("ba", acct);
  return { account: acct };
}
/* Money moved by hand: { type: in|out|transfer|adjust, account, to?, amount, direction?, reason? } → { move } | { error, field } */
export function recordBankMove(input){
  if(!mayViewBanks()) return { error: notAllowedText("record bank entries") };
  const t = Date.now(), r = checkBankMove(Object.assign({}, input, { t }), { accounts: bankAccounts() });
  if(r.error) return r;
  const move = Object.assign({}, r.move, { id: "bm_" + uid(), t, dev: store.dev });
  bizRepository().save("bm", move);
  return { move };
}
/* Put a mistaken entry right: the same entry the other way, with the reason → { move } | { error } */
export function reverseBankEntry(id, reason){
  if(!mayViewBanks()) return { error: notAllowedText("reverse bank entries") };
  const r = reverseBankMove(id, reason, { moves: bankMoves() });
  if(r.error) return r;
  const move = Object.assign({}, r.move, { id: "bm_" + uid(), t: Date.now(), dev: store.dev });
  bizRepository().save("bm", move);
  return { move };
}
/* Everything an account's ledger is made of */
export const bankContext = () => ({ accounts: bankAccounts(), moves: bankMoves(), bankEntries: bankBook(shopTransactions()).entries });
export const accountLedger = id => { const a = bankAccount(id); return a ? bankLedger(a, bankContext()) : null; };
export const accountBalances = () => bankBalances(bankContext());
/* Where UPI and card money lands: { upi: account id | null, card: … } */
export const methodLanding = () => methodAccounts(bankAccounts());
