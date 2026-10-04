// Bank accounts on screen: the list in Settings → Payments & Banks (and the summary on Reports), an account's sheet (balance,
// money in / out, transfer, adjustment, its ledger with reversals), and the forms to add or change an account and to record
// an entry. Rules: domain/finance/bank-accounts.js; use cases: use-cases/bank-accounts.js.
import { $, esc } from '../../../shared/dom.js';
import { inrx } from '../../../shared/formatting/money.js';
import { dayKey, dtLong } from '../../../shared/formatting/dates.js';
import { toast } from '../../../shared/components/toast.js';
import { closeModal } from '../../../shared/components/modal.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { renderAll } from '../../../shared/ui/render.js';
import { UI_ICON, emptyStateHTML, formActionsHTML, sheetHTML, statusChip } from '../../../shared/ui/kit.js';
import { accountBalances, accountLedger, bankAccount, bankAccounts, mayEditBanks, mayViewBanks, methodLanding, recordBankMove, reverseBankEntry, saveBankAccount } from '../use-cases/bank-accounts.js';
import { BANK_MOVE_LABELS } from '../../../domain/finance/bank-accounts.js';

const nameOf = a => a ? a.name + (a.last4 ? " ••" + a.last4 : "") : "—";
const signed = n => (n < 0 ? "− " : "+ ") + inrx(Math.abs(n));
function chipsOf(a, landing){
  return (a.isDefault ? statusChip("Default", "info") : "") + (landing.upi === a.id ? " " + statusChip("UPI lands here", "muted") : "") + (landing.card === a.id ? " " + statusChip("Card lands here", "muted") : "") + (a.active === false ? " " + statusChip("Switched off", "muted") : "");
}
/* Settings → Payments & Banks: the accounts with their balances */
export function bankAccountsSettingsHTML(){
  if(!mayViewBanks()) return "";
  const B = accountBalances(), landing = methodLanding(), edit = mayEditBanks();
  const list = B.rows.length ? `<div class="olist">${B.rows.map(r => `<button type="button" class="orow chev" data-bankopen="${esc(r.account.id)}"><span class="e-ic bankic">${UI_ICON.bank}</span><span class="o-main"><span class="o-t">${esc(nameOf(r.account))}</span><span class="o-s">${esc(r.account.bank || "Bank account")}</span><span class="o-chips">${chipsOf(r.account, landing)}</span></span><span class="o-end"><span class="o-amt">${inrx(r.balance)}</span><span class="o-s">balance</span></span></button>`).join("")}</div>`
    : emptyStateHTML({ icon: "bank", title: "No bank accounts yet", text: "Add the accounts your shop uses. UPI and card money then shows in the account it lands in, next to the money you move by hand.", cls: "compact plain" });
  const unmapped = B.rows.length && (!landing.upi || !landing.card) ? `<p class="note" style="margin:10px 0 0">${!landing.upi && !landing.card ? "UPI and card money" : !landing.upi ? "UPI money" : "Card money"} isn't counted in any account yet: choose where it lands in an account, or make one the default.</p>` : "";
  return `<div class="setblk" id="banksBlk"><h5>Bank accounts</h5><p class="note" style="margin:0 0 12px">Opening balances, money moved by hand, and where UPI and card money lands. ${B.rows.length ? "Total in active accounts: <b>" + inrx(B.total) + "</b>." : ""}</p>${list}${unmapped}
    ${edit ? `<div class="btnrow" style="margin-top:12px"><button type="button" class="btn" data-bankedit="">${UI_ICON.plus} Add bank account</button></div>` : ""}</div>`;
}
/* Reports: the balances, each opening its account */
export function bankSummaryHTML(){
  if(!mayViewBanks()) return "";
  const B = accountBalances();
  if(!B.rows.length) return `<p class="note" style="margin:12px 0 0">Add your bank accounts in Settings → Payments &amp; Banks to see UPI and card money account by account. <button type="button" class="link xs" data-setgo="payments" data-setfocus="banksBlk">Add an account</button></p>`;
  return `<div class="banksum">${B.rows.filter(r => r.account.active !== false).map(r => `<button type="button" class="banksum-r" data-bankopen="${esc(r.account.id)}"><span>${esc(nameOf(r.account))}</span><b>${inrx(r.balance)}</b></button>`).join("")}</div>`;
}

/* ---------- the sheets ---------- */
let V = null;   // { kind: "acct" | "edit" | "move" | "rev", id, type, err, field, values }
function draw(){
  const host = $("#modalHost"); if(!host || !V) return;
  if(V.kind === "edit") host.innerHTML = editHTML();
  else if(V.kind === "move") host.innerHTML = moveHTML();
  else if(V.kind === "rev") host.innerHTML = revHTML();
  else host.innerHTML = acctHTML();
  const f = host.querySelector(V.field ? `[name="${V.field}"]` : "form input:not([type=hidden]):not([type=checkbox])");
  if(f && V.kind !== "acct") f.focus({ preventScroll: true });
}
const errHTML = () => V && V.err ? `<p class="autherr" role="alert">${esc(V.err)}</p>` : "";
export function openBankAccount(id){ if(!bankAccount(id)) return; V = { kind: "acct", id }; draw(); }
export function openBankEdit(id){ if(!mayEditBanks()) return; V = { kind: "edit", id: id || "" }; draw(); }
function acctHTML(){
  const L = accountLedger(V.id); if(!L) return "";
  const a = L.account, landing = methodLanding(), live = a.active !== false, others = bankAccounts().filter(x => x.id !== a.id && x.active !== false);
  const acts = live ? `<div class="btnrow bankacts"><button type="button" class="btn" data-bankmove="in">${UI_ICON.moneyIn} Money in</button><button type="button" class="btn" data-bankmove="out">${UI_ICON.moneyOut} Money out</button>${others.length ? `<button type="button" class="btn" data-bankmove="transfer">${UI_ICON.transfer} Transfer</button>` : ""}<button type="button" class="btn" data-bankmove="adjust">${UI_ICON.adjust} Adjust</button></div>` : `<p class="note">This account is switched off: switch it on to record money in it.</p>`;
  const rows = L.entries.slice().reverse();
  const reversed = new Set(L.entries.filter(e => e.reverses).map(e => e.reverses));
  const opening = `<div class="orow"><span class="o-main"><span class="o-t">Opening balance</span><span class="o-s">${esc(a.openingDate)}</span></span><span class="o-end"><span class="o-amt">${inrx(a.opening)}</span></span></div>`;
  const list = rows.length ? `<div class="olist banklist">${rows.map(e => `<div class="orow"><span class="o-main"><span class="o-t">${esc(e.label)}${e.status === "cancelled" ? " " + statusChip("Bill cancelled", "muted") : ""}${e.verification === "unverified" ? " " + statusChip("Unverified", "warn") : ""}</span><span class="o-s">${esc(dtLong(e.t))}${e.reason ? " · " + esc(e.reason) : ""}${e.ref ? " · ref " + esc(e.ref) : ""}</span></span>
      <span class="o-end"><span class="o-amt ${e.amount < 0 ? "neg" : "pos"}">${signed(e.amount)}</span><span class="o-s">${inrx(e.balance)}</span>${e.moveId && e.kind !== "reversal" && !reversed.has(e.moveId) ? `<button type="button" class="link xs" data-bankrev="${esc(e.moveId)}">Reverse</button>` : ""}</span></div>`).join("")}${opening}</div>`
    : `<div class="olist banklist">${opening}</div><p class="note">No money moved in this account since ${esc(a.openingDate)}.</p>`;
  return sheetHTML({ id: "bankSheet", cls: "banksheet", title: nameOf(a), sub: esc((a.bank || "Bank account") + " · opening " + inrx(a.opening) + " on " + a.openingDate),
    body: `<div class="bankhead"><div><span class="eyebrow">Balance</span><div class="bankbal">${inrx(L.balance)}</div><div class="note">In ${inrx(L.in)} · Out ${inrx(L.out)}</div></div><div class="o-chips">${chipsOf(a, landing)}</div></div>
      ${acts}<h4 class="section-t">Transactions</h4>${list}`,
    foot: mayEditBanks() ? `<button type="button" class="btn" data-bankedit="${esc(a.id)}">${UI_ICON.edit} Edit account</button>` : "" });
}
function editHTML(){
  const a = V.values || (V.id ? bankAccount(V.id) : null) || { name: "", bank: "", last4: "", opening: "", openingDate: dayKey(Date.now()), active: true, isDefault: !bankAccounts().length, methods: bankAccounts().length ? [] : ["upi", "card"] };
  const has = m => (a.methods || []).includes(m);
  return sheetHTML({ id: "bankEdit", title: V.id ? "Edit bank account" : "Add bank account", sub: "Never the full account number: the last 4 digits are enough to recognise it.", keep: true,
    body: `<form id="bankForm" class="authform" novalidate><input type="hidden" name="id" value="${esc(V.id || "")}"><div class="pgrid">
      <label class="f"><span class="lab">Display name<span class="req">*</span></span><input name="name" maxlength="60" value="${esc(a.name)}" placeholder="HDFC Current" autocomplete="off"></label>
      <label class="f"><span class="lab">Bank</span><input name="bank" maxlength="60" value="${esc(a.bank || "")}" placeholder="HDFC Bank" autocomplete="off"></label>
      <label class="f"><span class="lab">Last 4 digits <small>(optional)</small></span><input name="last4" inputmode="numeric" maxlength="4" value="${esc(a.last4 || "")}" autocomplete="off"></label>
      <label class="f"><span class="lab">Opening balance (₹)</span><input name="opening" type="number" inputmode="decimal" step="0.01" value="${esc(a.opening === 0 && !V.id ? "" : a.opening)}" placeholder="0"></label>
      <label class="f"><span class="lab">Balance on date</span><input name="openingDate" type="date" value="${esc(a.openingDate || dayKey(Date.now()))}" max="${dayKey(Date.now())}"></label>
    </div>
    <p class="lab" style="margin:14px 0 4px">Money that lands in this account</p>
    <label class="chk"><input type="checkbox" name="m_upi"${has("upi") ? " checked" : ""}> UPI payments</label>
    <label class="chk"><input type="checkbox" name="m_card"${has("card") ? " checked" : ""}> Card machine settlements</label>
    <label class="chk"><input type="checkbox" name="isDefault"${a.isDefault ? " checked" : ""}> Default account <small class="muted">(UPI or card money not given to another account lands here)</small></label>
    <label class="chk"><input type="checkbox" name="active"${a.active !== false ? " checked" : ""}> Active</label>
    ${errHTML()}${formActionsHTML({ save: V.id ? "Save account" : "Add account" })}</form>` });
}
function moveHTML(){
  const a = bankAccount(V.id), t = V.type, v = V.values || {}, others = bankAccounts().filter(x => x.id !== V.id && x.active !== false);
  const help = { in: "Money that came into this account without a bill: a deposit, a loan, a transfer from outside.", out: "Money that left this account: rent, salaries, a supplier paid by bank transfer, bank charges.",
    transfer: "Money moved from this account to another of the shop's accounts.", adjust: "Correct the balance to match the bank statement. Say why." }[t];
  return sheetHTML({ id: "bankMove", title: BANK_MOVE_LABELS[t] + " · " + nameOf(a), sub: esc(help), keep: true,
    body: `<form id="bankMoveForm" class="authform" novalidate><input type="hidden" name="type" value="${esc(t)}"><div class="pgrid">
      <label class="f"><span class="lab">Amount (₹)<span class="req">*</span></span><input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" value="${esc(v.amount || "")}"></label>
      ${t === "transfer" ? `<label class="f"><span class="lab">To account<span class="req">*</span></span><select name="to">${others.map(o => `<option value="${esc(o.id)}"${v.to === o.id ? " selected" : ""}>${esc(nameOf(o))}</option>`).join("")}</select></label>` : ""}
      ${t === "adjust" ? `<label class="f"><span class="lab">The balance goes</span><select name="direction"><option value="up"${v.direction !== "down" ? " selected" : ""}>Up (add)</option><option value="down"${v.direction === "down" ? " selected" : ""}>Down (take off)</option></select></label>` : ""}
      <label class="f full"><span class="lab">${t === "adjust" ? 'Reason<span class="req">*</span>' : "Note <small>(optional)</small>"}</span><input name="reason" maxlength="200" value="${esc(v.reason || "")}" placeholder="${t === "adjust" ? "e.g. bank charges on the statement" : t === "out" ? "e.g. shop rent for October" : ""}" autocomplete="off"></label>
    </div>${errHTML()}${formActionsHTML({ save: "Record " + BANK_MOVE_LABELS[t].toLowerCase() })}</form>` });
}
function revHTML(){
  return sheetHTML({ id: "bankRev", title: "Reverse this entry", sub: "The entry stays in the ledger; a reversal for the same amount puts the balance back.", keep: true,
    body: `<form id="bankRevForm" class="authform" novalidate><label class="f full"><span class="lab">Why<span class="req">*</span></span><input name="reason" maxlength="200" autocomplete="off" placeholder="e.g. entered twice"></label>${errHTML()}${formActionsHTML({ save: "Reverse entry" })}</form>` });
}
function after(msg){ renderSync(); flushSbQueue(); renderAll(); toast(msg); }

/* Registered once at start-up (app/modules.js) */
let on = false;
export function installBankEvents(){
  if(on) return; on = true;
  document.addEventListener("click", e => {
    const t = e.target && e.target.closest ? e.target : null; if(!t) return;
    const op = t.closest("[data-bankopen]"); if(op){ openBankAccount(op.dataset.bankopen); return; }
    const ed = t.closest("[data-bankedit]"); if(ed){ openBankEdit(ed.dataset.bankedit); return; }
    const mv = t.closest("[data-bankmove]"); if(mv && V){ V = { kind: "move", id: V.id, type: mv.dataset.bankmove }; draw(); return; }
    const rv = t.closest("[data-bankrev]"); if(rv && V){ V = { kind: "rev", id: V.id, rev: rv.dataset.bankrev }; draw(); return; }
    // Cancel or × on a form goes back to the account (or closes when adding one)
    if(V && (t.closest("#bankEdit [data-modal-close], #bankMove [data-modal-close], #bankRev [data-modal-close]") || (t.matches("[type=reset]") && t.closest("#bankForm, #bankMoveForm, #bankRevForm")))){
      e.preventDefault(); e.stopImmediatePropagation();
      if(V.kind === "edit" && !V.id){ V = null; closeModal(); } else { V = { kind: "acct", id: V.id }; draw(); }
      return;
    }
    if(t.closest("#bankSheet [data-modal-close]") || t.matches("[data-modal-scrim]")) V = null;
  }, true);
  document.addEventListener("submit", e => {
    const f = e.target; if(!f || !["bankForm", "bankMoveForm", "bankRevForm"].includes(f.id)) return;
    e.preventDefault();
    const d = new FormData(f), val = k => d.get(k);
    if(f.id === "bankForm"){
      const values = { id: val("id"), name: val("name"), bank: val("bank"), last4: val("last4"), opening: val("opening"), openingDate: val("openingDate"),
        isDefault: !!val("isDefault"), active: !!val("active"), methods: [val("m_upi") ? "upi" : "", val("m_card") ? "card" : ""].filter(Boolean) };
      const r = saveBankAccount(values);
      if(r.error){ V = Object.assign({}, V, { err: r.error, field: r.field, values }); draw(); return; }
      V = { kind: "acct", id: r.account.id }; draw(); after(values.id ? "Bank account saved." : "Bank account added."); return;
    }
    if(f.id === "bankMoveForm"){
      const values = { type: val("type"), amount: val("amount"), to: val("to"), direction: val("direction"), reason: val("reason") };
      const r = recordBankMove(Object.assign({ account: V.id }, values));
      if(r.error){ V = Object.assign({}, V, { err: r.error, field: r.field, values }); draw(); return; }
      V = { kind: "acct", id: V.id }; draw(); after(BANK_MOVE_LABELS[values.type] + " recorded."); return;
    }
    const r = reverseBankEntry(V.rev, val("reason"));
    if(r.error){ V = Object.assign({}, V, { err: r.error, field: "reason" }); draw(); return; }
    V = { kind: "acct", id: V.id }; draw(); after("Entry reversed.");
  });
}
