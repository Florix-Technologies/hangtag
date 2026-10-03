// Gift vouchers on the phone. Issue: ₹ amount → (customer) → Issue; Hangtag makes the code and QR. Spend: on the payment
// screen (features/sales/components/payment-sheet.js). The list shows what is left on each voucher.
import { VOUCHER_LABELS } from '../../../domain/sales/vouchers.js';
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { inrx } from '../../../shared/formatting/money.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { can } from '../../shop/services/access.js';
import { cancelVoucher, issueVoucher, refreshVouchers, usesVouchers, voucherHistory, voucherList, voucherStatus } from '../use-cases/vouchers.js';
import { bizError, bizSheet, chip } from './biz-sheet.js';

const V = () => store.bizView || {};
const TONE = { active: "ok", fully_redeemed: "muted", expired: "warn", cancelled: "bad" };
const qr = text => { try{ return use("qrCodeService").render(text, { unit: "px", size: 180, margin: 2 }); }catch{ return ""; } };
/* Under an empty bill: sell a voucher (shops that use them) */
export const voucherSellHTML = () => usesVouchers() && can("create_sale") ? `<button type="button" class="link xs" data-gvnew>Sell a gift voucher</button>` : "";
export function openVoucherIssue(){
  const c = store.cartCust;
  store.bizView = { kind: "gvnew", amount: "", method: "cash", custId: c && c.id || "", custName: c && c.name || "", expires: "", busy: false, err: "" };
  renderVoucherIssue();
}
function renderVoucherIssue(){
  const F = V();
  if(F.voucher){
    const v = F.voucher;
    bizSheet({ label: "Gift voucher", body: `<div class="gvcard"><span class="gvamt">${inrx(v.amount)}</span>${qr(v.code)}<span class="gvcode">${esc(v.code)}</span>${v.custName ? `<small>For ${esc(v.custName)}</small>` : ""}${v.expires ? `<small>Use by ${esc(v.expires)}</small>` : ""}</div>
      <p class="note">Give the customer this code or QR. It works only at your shop, all at once or in parts.</p>`,
      foot: `${typeof navigator !== "undefined" && navigator.share ? `<button type="button" class="btn sm" data-gvshare>Share</button>` : ""}<button type="button" class="btn sm primary" data-biz="close">Done</button>` });
    return;
  }
  bizSheet({ label: "Sell a gift voucher", body: `<label class="f full">Amount<input data-gvf="amount" type="number" inputmode="decimal" min="1" step="any" value="${esc(F.amount)}" placeholder="₹" style="font-size:22px"></label>
      <div class="seg" role="group" aria-label="Paid by">${["cash", "upi", "card"].map(m => `<button type="button" data-gvmethod="${m}" aria-pressed="${F.method === m}">${m === "upi" ? "UPI" : m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div>
      ${F.custName ? `<p class="note">For <b>${esc(F.custName)}</b> (the customer on the bill)</p>` : `<p class="note">For anyone (add a customer to the bill first to name it for them).</p>`}
      <details><summary>Use by a date</summary><label class="f">Last day<input data-gvf="expires" type="date" value="${esc(F.expires)}"></label></details>`,
    foot: `<button type="button" class="btn sm" data-biz="close">Cancel</button><button type="button" class="btn sm primary" data-gvissue${F.busy ? " disabled" : ""}>${F.busy ? "Issuing…" : "Issue"}</button>` });
}
export function openVoucherList(){
  store.bizView = { kind: "gvlist", err: "" };
  renderVoucherList();
  refreshVouchers().then(r => { if(!r.error && V().kind === "gvlist") renderVoucherList(); });
}
function renderVoucherList(){
  const list = voucherList();
  bizSheet({ label: "Gift vouchers", body: (list.length ? `<div class="bizlist">${list.slice(0, 100).map(v => { const st = voucherStatus(v);
      return `<button type="button" class="bizrow" data-gvopen="${esc(v.id)}"><span><b>···${esc(v.code.slice(-4))} · ${inrx(v.balance)} of ${inrx(v.amount)} left</b><small>${esc(v.custName || "Anyone")}${v.expires ? ` · use by ${esc(v.expires)}` : ""}</small></span>${chip(VOUCHER_LABELS[st], TONE[st])}</button>`; }).join("")}</div>` : `<p class="muted">No vouchers yet.</p>`),
    foot: can("create_sale") ? `<button type="button" class="btn sm primary" data-gvnew>Sell a voucher</button>` : "" });
}
async function openVoucher(id){
  const v = voucherList().find(x => x.id === id); if(!v) return;
  store.bizView = { kind: "gvone", id, err: "" };
  const st = voucherStatus(v), h = await voucherHistory(id);
  if(V().kind !== "gvone" || V().id !== id) return;
  const rows = (h.history || []).map(r => `<div class="disc-row"><span><b>${r.kind === "reverse" ? "Given back" : "Spent"} ${inrx(r.amount)}</b><small>${esc(dtLong(r.t))}</small></span></div>`).join("");
  bizSheet({ label: `Voucher ···${v.code.slice(-4)}`, sub: `${inrx(v.balance)} of ${inrx(v.amount)} left`, body: `<div>${chip(VOUCHER_LABELS[st], TONE[st])}</div>${rows || `<p class="muted">${h.error ? esc(h.error) : "Not used yet."}</p>`}`,
    foot: st === "active" && v.balance === v.amount && can("manage_settings") ? `<button type="button" class="btn sm danger" data-gvcancel>Cancel voucher</button>` : `<button type="button" class="btn sm" data-biz="close">Done</button>` });
}
export function vouchersClick(t){
  if(t.closest("[data-gvnew]")){ openVoucherIssue(); return true; }
  if(t.closest("[data-gvlist]")){ openVoucherList(); return true; }
  const o = t.closest("[data-gvopen]"); if(o){ openVoucher(o.dataset.gvopen); return true; }
  const F = V();
  const m = t.closest("[data-gvmethod]"); if(m && F.kind === "gvnew"){ F.method = m.dataset.gvmethod; renderVoucherIssue(); return true; }
  if(t.closest("[data-gvissue]") && F.kind === "gvnew" && !F.busy){
    F.busy = true; renderVoucherIssue();
    issueVoucher({ amount: F.amount, method: F.method, custId: F.custId, expires: F.expires }).then(r => {
      if(V() !== F) return;
      F.busy = false;
      if(r.error){ F.err = r.error; renderVoucherIssue(); return; }
      F.voucher = { ...r.voucher, custName: r.voucher.custName || F.custName }; F.err = ""; renderVoucherIssue(); renderAll();
      toast(`Voucher of ${inrx(r.voucher.amount)} issued.`);
    });
    return true;
  }
  if(t.closest("[data-gvshare]") && F.voucher){ navigator.share({ title: "Gift voucher", text: `Gift voucher ${F.voucher.code} for ${inrx(F.voucher.amount)} at ${store.profile && store.profile.shop_name || "our shop"}.` }).catch(() => {}); return true; }
  if(t.closest("[data-gvcancel]") && F.kind === "gvone"){
    const why = window.prompt("Why is this voucher cancelled?") || ""; if(!why) return true;
    cancelVoucher(F.id, why).then(r => { if(r && r.error){ bizError(r.error); return; } toast("Voucher cancelled."); openVoucherList(); });
    return true;
  }
  return false;
}
export function vouchersInput(t){
  const F = V(); if(F.kind !== "gvnew" || !t.matches("[data-gvf]")) return false;
  F[t.dataset.gvf] = t.value; return true;
}
export function vouchersSettingsHTML(){
  if(!usesVouchers()) return "";
  const active = voucherList().filter(v => voucherStatus(v) === "active");
  return `<div class="setpart"><h5 class="subh">Gift vouchers</h5><p class="note" style="margin:0">${active.length ? `${active.length} active · ${inrx(active.reduce((a, v) => a + v.balance, 0))} still to spend` : "Sell a voucher; customers pay with it later."}</p>
    <div class="setactions"><button type="button" class="btn sm" data-gvlist>Open vouchers</button>${can("create_sale") ? `<button type="button" class="btn sm" data-gvnew>Sell a voucher</button>` : ""}</div></div>`;
}
