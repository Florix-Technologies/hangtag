// Plans & Billing: the shop's Hangtag plan, choosing a plan (Monthly to 12 Months, prices and offers from the server), a promo
// code checked by the server, the summary the server computed, Pay Now (the payment provider's page) and the wait for its
// confirmation, AutoPay (the terms, the owner's explicit consent, the bank's approval, turning it off), and the payment
// history. The same checkout is drawn in Settings → Plans & Billing and on the lock screen that replaces
// the whole app once the trial or plan has ended (app/navigation.js). A team member sees "ask the owner"; only the owner
// pays. The browser never sends a price, discount or amount: it shows what the server answered.
import { store } from '../../../shared/state/store.js';
import { storage } from '../../../shared/state/persistence.js';
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { inrx } from '../../../shared/formatting/money.js';
import { dateText } from '../../../shared/formatting/dates.js';
import { userMessage, ERROR_CODES } from '../../../shared/errors/app-error.js';
import { requestSignOut } from '../../../shared/ui/session-actions.js';
import { renderAll } from '../../../shared/ui/render.js';
import { closeModal } from '../../../shared/components/modal.js';
import { logger } from '../../../shared/logging/logger.js';
import { PAYMENT_STATUS, autopayConsentText, autopayLive, bannerFor, daysLeft, lockCopy, perMonth, planFacts, statusChip } from '../../../domain/billing/subscription.js';
import { mayPay, refreshSubscription, subscriptionLocked, subscriptionNow, subscriptionStatus } from '../services/subscription.js';
import { can } from '../../shop/services/access.js';

const PENDING_KEY = "hangtag_sub_pending";   // a payment page opened on this device, still waiting for its confirmation
const AP_KEY = "hangtag_ap_pending";         // AutoPay's approval page opened on this device, waiting for the bank's answer
const POLL_EVERY = 3000, POLL_FOR = 10 * 60e3;
/* What the checkout shows: the server's plans, the chosen one, the promo typed, the server's quote, the payment waited for;
   AutoPay's terms, the owner's tick, and AutoPay's own messages */
const freshCheckout = () => ({ plans: null, config: null, payments: null, plan: "", promo: "", applied: "", quote: null, quoting: false, busy: false, msg: "", tone: "", done: null, loading: null, error: "",
  loadedAt: 0, autopay: null, apConsent: false, apBusy: false, apConfirm: false, apMsg: "", apTone: "",
  // the payer's mobile number, asked for here when the payment page needs one and the shop's saved number can't be used
  // (Settings may be out of reach: a shop whose plan ended is locked to this screen)
  needPhone: false, phone: "" });
const ck = freshCheckout();
/* The account the checkout belongs to. Another account signed in on this tab (no page reload): nothing of the previous
   one's stays (its payment history, a mobile number typed for it, its "Payment received"); the waits are this account's */
let ckAccount = null;
function forAccount(){
  const a = (store.authUser && store.authUser.id) || "";
  if(ckAccount === a) return;
  if(ckAccount !== null){ Object.assign(ck, freshCheckout()); stopPoll(); stopApPoll(); if(pending()) poll(); if(apPending()) apPoll(); }
  ckAccount = a;
}
let pollTimer = null, apTimer = null;
const pending = () => { const p = storage.get(PENDING_KEY, null); return p && typeof p === "object" && p.paymentId ? p : null; };
const setPending = p => { if(p) storage.set(PENDING_KEY, p); else storage.remove(PENDING_KEY); };
const apPending = () => { const p = storage.get(AP_KEY, null); return p && typeof p === "object" && p.startedAt ? p : null; };
const setApPending = p => { if(p) storage.set(AP_KEY, p); else storage.remove(AP_KEY); };
const money = n => inrx(+n || 0);
const when = v => { const t = Date.parse(v); return Number.isFinite(t) ? dateText(t) : ""; };

/* ---------- loading what the server says ---------- */
function load(force){
  if(ck.loading && !force) return ck.loading;
  const svc = use("subscriptionService");
  ck.loading = (async () => {
    ck.error = "";
    const [plans, config, payments, autopay] = await Promise.all([
      svc.plans().catch(e => { ck.error = userMessage(e, "The plans couldn't be loaded. Check the connection and try again."); return null; }),
      mayPay() ? svc.config() : Promise.resolve(null),
      mayPay() ? svc.payments().catch(() => null) : Promise.resolve(null),
      mayPay() ? svc.autopayQuote().catch(() => null) : Promise.resolve(null),   // none on a database without AutoPay
    ]);
    if(plans) ck.plans = plans;
    ck.config = config; ck.payments = payments; ck.autopay = autopay; ck.loadedAt = Date.now();
    const was = pending();   // after a reload while a payment waits (the return from the payment page), its plan stays chosen
    if(ck.plans && ck.plans.length && !ck.plans.some(p => p.code === ck.plan)) ck.plan = ((was && ck.plans.find(p => p.code === was.plan)) || ck.plans.find(p => p.months === 3) || ck.plans[0]).code;
    redraw();
    if(mayPay() && ck.plan) await quote();
  })().finally(() => { ck.loading = null; });
  return ck.loading;
}
async function quote(){
  if(!ck.plan || !mayPay()) return;
  ck.quoting = true; redraw();
  try{
    const q = await use("subscriptionService").quote(ck.plan, ck.applied);
    ck.quote = q;
    if(ck.applied && q && q.promo){ ck.msg = q.promo.message || ""; ck.tone = q.promo.valid ? "ok" : "bad"; }
  }catch(e){ ck.quote = null; ck.msg = userMessage(e, "The price couldn't be worked out. Try again."); ck.tone = "bad"; }
  ck.quoting = false; redraw();
}

/* ---------- the parts ---------- */
const chipHTML = c => `<span class="chip-s ${esc(c.tone)}">${esc(c.label)}</span>`;
function factsHTML(s, now, trialShown){
  const rows = planFacts(s, now).filter(r => !trialShown || !/^(Trial ends on|Days remaining)$/.test(r.label));
  return rows.length ? `<dl class="subfacts">${rows.map(r => `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd></div>`).join("")}</dl>` : "";
}
function planCardsHTML(where){
  if(!ck.plans) return ck.error ? `<p class="note bad" role="alert">${esc(ck.error)} <button type="button" class="btn sm" data-sub-act="reload">Try again</button></p>` : `<p class="note">Loading the plans…</p>`;
  if(!ck.plans.length) return `<p class="note">No plans are on sale right now. Contact Hangtag support.</p>`;
  return `<fieldset class="subplans"><legend class="sr">Choose a plan</legend>${ck.plans.map(p => {
    const pm = perMonth(p), o = p.offer;
    const sub = o ? `<span class="sp-m sp-offer">${esc(o.title || "Offer")}${o.remaining != null ? ` · ${esc(String(o.remaining))} left` : ""}</span>`
      : pm ? `<span class="sp-m">${esc(money(pm))} a month</span>` : `<span class="sp-m">Billed once</span>`;
    return `<label class="subplan${o ? " offer" : ""}"><input type="radio" name="subPlan" id="subPlan-${where}-${esc(p.code)}" value="${esc(p.code)}"${p.code === ck.plan ? " checked" : ""}${ck.busy ? " disabled" : ""}>
      <span class="sp-l">${esc(p.label)}</span><span class="sp-p">${o ? `<s>${esc(money(p.price))}</s> ${esc(money(o.price))}` : esc(money(p.price))}</span>${sub}</label>`;
  }).join("")}</fieldset>`;
}
function summaryHTML(){
  const q = ck.quote;
  if(!q) return ck.quoting ? `<p class="note">Working out the price…</p>` : "";
  const disc = +q.discount || 0;
  return `<dl class="subsum" aria-live="polite"><div><dt>Plan price</dt><dd>${esc(money(q.price))}</dd></div>
    <div><dt>Promo discount</dt><dd>${disc ? "−" + esc(money(disc)) : esc(money(0))}</dd></div>
    <div class="tot"><dt>Final amount</dt><dd>${esc(money(q.amount))}</dd></div></dl>
    ${q.promo && q.promo.valid && q.promo.auto ? `<p class="note subfine">${esc(q.promo.message || "Offer applied.")}${q.promo.remaining != null ? ` ${esc(String(q.promo.remaining))} left.` : ""}</p>` : ""}`;
}
/* AutoPay: its terms and the owner's explicit consent (nothing to pay today during a trial, the plan after it), or AutoPay as
   it is now (on, failing, waiting for the bank) with a way to turn it off */
function autopayHTML(){
  const s = subscriptionStatus(), ap = s && s.autopay;
  if(!mayPay() || !ap) return "";
  if(autopayLive(ap)) return autopayOnHTML(s, ap);
  const q = ck.autopay;
  if(!q) return ck.loading ? `<p class="note">Loading AutoPay…</p>` : "";
  if(!q.available || (ck.config && !ck.config.autopay)) return s.state === "trial_setup" ? `<p class="note subnote" role="note">AutoPay isn't available right now. Pay for a plan below to start, or try again later.</p>` : "";
  const price = money(q.price), today = money(q.today), first = when(q.first_charge_at), months = (q.plan && q.plan.months) || 1;
  // what the bank or UPI app may take to confirm the mandate (the provider refunds it): said before the owner agrees
  const verify = ck.config && +ck.config.autopay_verify > 0 ? money(+ck.config.autopay_verify) : "";
  return `<div class="apcard" data-apcard>
    <div class="ap-h"><h6>AutoPay</h6>${ap.required ? `<span class="chip-s warn">Required for the free trial</span>` : ""}</div>
    <dl class="subsum ap-terms"><div class="tot"><dt>Today</dt><dd>${esc(today)}</dd></div>
      <div><dt>${+q.today === 0 ? "After your trial" : "Then"}</dt><dd>${esc(price)} / ${months > 1 ? esc(months + " months") : "month"}</dd></div>
      <div><dt>First charge</dt><dd>${esc(first)}</dd></div>
      ${verify ? `<div><dt>To confirm AutoPay</dt><dd>${esc(verify)}, refunded</dd></div>` : ""}</dl>
    ${ck.needPhone ? `<div class="subpromo subphone"><label for="apPhone">Mobile number for AutoPay</label>
      <div class="subpromo-row"><input id="apPhone" name="subPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" value="${esc(ck.phone)}" placeholder="10-digit mobile number"${ck.apBusy ? " disabled" : ""}></div></div>` : ""}
    <label class="ap-consent"><input type="checkbox" id="apConsent" data-ap-consent${ck.apConsent ? " checked" : ""}${ck.apBusy ? " disabled" : ""}><span>${esc(autopayConsentText({ price, today, months, firstChargeOn: first }))}</span></label>
    <button type="button" class="btn primary subpay" data-sub-act="ap-start"${!ck.apConsent || ck.apBusy ? " disabled" : ""}${ck.apBusy ? ' aria-busy="true"' : ""}>Set up AutoPay · ${esc(today)} today</button>
    <p class="note subfine">You approve AutoPay with your bank or UPI app on a secure page.${verify ? ` To confirm it, UPI or a card takes ${esc(verify)}, which is refunded (a bank-account mandate takes nothing); nothing else is charged before ${esc(first)}.` : ""} Cancel any time before a renewal, here in Plans &amp; Billing.</p>
    ${ck.apMsg ? `<p class="subpromo-msg ${esc(ck.apTone)}" role="status">${esc(ck.apMsg)}</p>` : ""}</div>`;
}
function autopayOnHTML(s, ap){
  const waiting = ap.status === "pending", failing = ap.status === "past_due";
  const chip = waiting ? ["muted", "Waiting for approval"] : failing ? ["warn", "Charge failed"] : ["ok", "On"];
  return `<div class="apcard on" data-apcard>
    <div class="ap-h"><h6>AutoPay</h6><span class="chip-s ${chip[0]}">${chip[1]}</span></div>
    <p class="ap-line">${waiting ? "Approve AutoPay with your bank or UPI app. This updates as soon as your bank confirms it."
      : `${esc(money(ap.price))} · ${esc(ap.plan_label || "plan")}${ap.next_charge_at ? ` · next charge on ${esc(when(ap.next_charge_at))}` : ""} · cancel any time before it`}</p>
    ${failing ? `<p class="note">The last charge didn't go through. A failed charge may be tried again; to pay another way, turn AutoPay off first.</p>` : ""}
    ${ck.apConfirm ? `<div class="ap-confirm" role="group" aria-labelledby="apConfirmT"><p id="apConfirmT"><b>Turn off AutoPay?</b> Nothing more is charged. You keep using Hangtag until ${esc(when(s.access_until))}.</p>
        <div class="btnrow"><button type="button" class="btn danger" data-sub-act="ap-cancel-yes"${ck.apBusy ? " disabled" : ""}>Turn off AutoPay</button><button type="button" class="btn" data-sub-act="ap-cancel-no">Keep AutoPay</button></div></div>`
      : `<div class="btnrow">${waiting ? `<button type="button" class="btn" data-sub-act="ap-check"${ck.apBusy ? " disabled" : ""}>Check again</button>` : ""}<button type="button" class="btn text" data-sub-act="ap-cancel">${waiting ? "Cancel the set-up" : "Turn off AutoPay"}</button></div>`}
    ${ck.apMsg ? `<p class="subpromo-msg ${esc(ck.apTone)}" role="status">${esc(ck.apMsg)}</p>` : ""}</div>`;
}
function payHTML(){
  const q = ck.quote, p = pending();
  if(ck.done) return `<div class="subdone" role="status"><b>Payment received.</b> Your ${esc(ck.done.label || "plan")} runs until ${esc(when(ck.done.period_end))}. Everything is open again.</div>`;
  if(p) return `<div class="subwait" role="status"><b>Waiting for the payment…</b><span>Finish paying on the payment page. This screen unlocks as soon as the payment is confirmed.</span>
      <div class="btnrow"><button type="button" class="btn primary" data-sub-act="check"${ck.busy ? ' aria-busy="true"' : ""}>I've paid</button>
      ${p.payUrl && /^https:\/\//.test(p.payUrl) ? `<a class="btn" href="${esc(p.payUrl)}" target="_blank" rel="noopener">Open the payment page</a>` : ""}
      <button type="button" class="btn text" data-sub-act="forget">Choose again</button></div></div>`;
  if(!q) return "";
  const st = subscriptionStatus();
  if(st && autopayLive(st.autopay)) return `<p class="note subnote" role="note">AutoPay is set up: your plan renews by itself. To pay for a different plan, turn AutoPay off first.</p>`;
  const free = +q.amount === 0;
  if(!free && ck.config && !ck.config.available) return `<p class="note subnote" role="note">Online payment isn't set up yet. Contact Hangtag support to choose a plan.</p>`;
  if(!ck.config && !free) return `<p class="note">Checking how you can pay…</p>`;
  return `<button type="button" class="btn primary subpay" data-sub-act="pay"${ck.busy || ck.quoting ? " disabled" : ""}${ck.busy ? ' aria-busy="true"' : ""}>${free ? "Start the plan (nothing to pay)" : "Pay " + esc(money(q.amount))}</button>
    <p class="note subfine">You pay on a secure payment page. Your plan starts after the current one ends, so no days are lost.</p>`;
}
function checkoutHTML(where){
  return `<form class="subck" data-subck novalidate>
    ${planCardsHTML(where)}
    <div class="subpromo"><label for="subPromo-${where}">Promo code</label>
      <div class="subpromo-row"><input id="subPromo-${where}" name="subPromo" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" value="${esc(ck.promo)}" placeholder="Enter a code"${ck.busy ? " disabled" : ""}>
      <button type="button" class="btn" data-sub-act="apply"${ck.busy || ck.quoting ? " disabled" : ""}>Apply</button></div>
      <p class="subpromo-msg ${esc(ck.tone)}" aria-live="polite">${esc(ck.msg)}</p></div>
    ${ck.needPhone && !pending() ? `<div class="subpromo subphone"><label for="subPhone-${where}">Mobile number for the payment</label>
      <div class="subpromo-row"><input id="subPhone-${where}" name="subPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" value="${esc(ck.phone)}" placeholder="10-digit mobile number"${ck.busy ? " disabled" : ""}></div></div>` : ""}
    ${summaryHTML()}
    ${payHTML()}
  </form>`;
}
function historyHTML(){
  const list = ck.payments;
  if(!list) return "";
  if(!list.length) return `<p class="note">No payments yet.</p>`;
  const label = code => { const p = (ck.plans || []).find(x => x.code === code); return p ? p.label : code; };
  return `<ul class="subhist">${list.map(p => `<li><span class="sh-main"><b>${esc(label(p.plan_code))}</b><small>${esc(when(p.paid_at || p.created_at))}${p.kind === "autopay" ? " · AutoPay" : ""}${p.promo_code ? " · " + esc(p.promo_code) : ""}${p.status === "paid" && p.period_end ? " · until " + esc(when(p.period_end)) : ""}</small></span>
    <span class="sh-amt">${esc(money(p.amount))}</span><span class="chip-s ${p.status === "paid" ? "ok" : p.status === "created" ? "muted" : "bad"}">${esc(PAYMENT_STATUS[p.status] || p.status)}</span></li>`).join("")}</ul>`;
}

/* Settings → Plans & Billing (the owner) */
export function plansBillingHTML(){
  forAccount();
  const s = subscriptionStatus(), now = subscriptionNow();
  // asked from the server only when the section is really on the screen (Settings also builds sections it doesn't show), and
  // again when what it showed is over a minute old (AutoPay or the offers may have changed)
  if((!ck.plans || Date.now() - (ck.loadedAt || 0) > 60e3) && !ck.loading) setTimeout(() => { if(document.getElementById("plansBlk")) load(true); }, 0);
  if(!s || s.state === "unavailable") return `<div class="setblk" id="plansBlk"><h5>Your plan</h5><p class="note">${s ? "Plans & Billing isn't available on this shop's database yet." : "Your plan shows here once you're online."}</p></div>`;
  const chip = statusChip(s, now), n = daysLeft(s, now);
  return `<div id="plansBlk">
    <div class="setblk subnow"><div class="subnow-h"><h5>Your plan</h5>${chipHTML(chip)}</div>
      ${s.state === "trial_active" && !subscriptionLocked() ? `<p class="subbig">${n} day${n === 1 ? "" : "s"} remaining <span>Trial ends on ${esc(when(s.trial_ends_at))}</span></p>` : ""}
      ${factsHTML(s, now, s.state === "trial_active" && !subscriptionLocked())}</div>
    ${mayPay() && s.autopay ? `<div class="setblk" id="apBlk">${autopayHTML()}</div>` : ""}
    <div class="setblk"><h5>${s.plan_code ? "Renew or upgrade" : "Choose a plan"}</h5>${checkoutHTML("set")}</div>
    <div class="setblk"><h5>Payment history</h5>${historyHTML() || `<p class="note">Loading…</p>`}</div></div>`;
}

/* The lock screen: the whole app is replaced by it while the shop's plan has ended */
function lockHTML(){
  const s = subscriptionStatus(), now = subscriptionNow(), owner = mayPay(), c = lockCopy(s, now, owner);
  const shop = store.profile && store.profile.shop_name ? store.profile.shop_name : "";
  return `<div class="lock-card">
    <div class="lock-brand">Hangtag${shop ? ` · <span>${esc(shop)}</span>` : ""}</div>
    <div class="lock-head"><h1 id="lockT">${esc(c.title)}</h1><span class="chip-s bad">${esc(c.chip)}</span></div>
    ${c.ended ? `<p class="lock-ended">${s && s.state === "suspended" ? "" : "Ended on "}<b>${esc(c.ended)}</b></p>` : ""}
    <p class="lock-sub">${esc(c.body)}</p>
    ${owner && s && s.state === "trial_setup" ? `<section class="lock-sec" aria-labelledby="lockApT"><h2 id="lockApT">Start with AutoPay</h2>${autopayHTML()}</section>` : ""}
    ${owner && s && s.state !== "suspended" ? `<section class="lock-sec" aria-labelledby="lockPlansT"><h2 id="lockPlansT">${s.state === "trial_setup" ? "Or pay for a plan now" : "Choose a plan"}</h2>${checkoutHTML("lock")}</section>
      <section class="lock-sec" aria-labelledby="lockHistT"><h2 id="lockHistT">Payment history</h2>${historyHTML() || `<p class="note">Loading…</p>`}</section>` : ""}
    <div class="lock-foot"><button type="button" class="btn" data-sub-act="refresh">Check again</button><button type="button" class="btn text" data-sub-act="signout">Sign out</button></div>
  </div>`;
}
/* Draw (or remove) the lock screen. Returns whether the app is locked. Called by app/navigation.js before any screen. */
export function renderLockScreen(){
  const locked = subscriptionLocked(), root = document.documentElement;
  let host = document.getElementById("lockScreen");
  if(!locked){
    if(host){ host.remove(); delete root.dataset.locked; }
    return false;
  }
  forAccount();
  if(!host){
    host = document.createElement("div");
    host.id = "lockScreen"; host.className = "lockscr"; host.setAttribute("role", "dialog"); host.setAttribute("aria-modal", "true"); host.setAttribute("aria-labelledby", "lockT");
    document.body.appendChild(host);
    closeModal();
    ck.done = null;   // an earlier "Payment received" no longer holds once the shop locks again: Pay is offered
    setTimeout(() => load(true), 0);   // fresh plans, offers and AutoPay for the screen that now replaces the app
  }
  root.dataset.locked = "1";
  const keep = document.activeElement && host.contains(document.activeElement) ? document.activeElement.id : "";
  host.innerHTML = lockHTML();
  if(keep && document.getElementById(keep)) document.getElementById(keep).focus();
  else if(!host.contains(document.activeElement)){ const h = host.querySelector("h1"); if(h){ h.tabIndex = -1; h.focus({ preventScroll: true }); } }
  if(pending() && !pollTimer) poll();
  return true;
}
/* Redraw whichever checkout is on the screen (Settings or the lock screen), keeping the person's place in it */
function redraw(){
  if(document.getElementById("lockScreen")){ renderLockScreen(); return; }
  const blk = document.getElementById("plansBlk");
  if(!blk) return;
  const a = document.activeElement, id = a && blk.contains(a) ? a.id : "", sel = a && a.name === "subPlan" ? a.value : "";
  blk.outerHTML = plansBillingHTML();
  if(id && document.getElementById(id)) document.getElementById(id).focus();
  else if(sel){ const r = document.getElementById("subPlan-set-" + sel); if(r) r.focus(); }
}

/* Home: a slim line during the trial and when a paid plan has a week or less left (the owner and managers) */
export function subscriptionBannerHTML(){
  if(!store.authUser || subscriptionLocked() || !(mayPay() || can("manage_settings"))) return "";
  const b = bannerFor(subscriptionStatus(), subscriptionNow());
  if(!b) return "";
  return `<div class="subban ${esc(b.tone)}" role="status"><span>${esc(b.text)}</span>${mayPay() ? `<button type="button" class="btn sm" data-setgo="plans">${esc(b.cta)}</button>` : `<small>Ask the owner to choose a plan.</small>`}</div>`;
}

/* ---------- AutoPay ---------- */
async function apStart(){
  if(ck.apBusy || !ck.autopay || !ck.apConsent) return;
  ck.apBusy = true; ck.apMsg = ""; redraw();
  // a page opened right away keeps the browser from blocking it (the bank's page arrives from the server a moment later)
  const win = window.open("", "_blank");
  try{
    const r = await use("subscriptionService").autopayStart(ck.autopay.consent_version, ck.needPhone ? ck.phone.trim() : "");
    if(!r || !r.auth_url || !/^https:\/\//.test(r.auth_url)) throw new Error("no page");
    setApPending({ startedAt: Date.now() });
    // the app's own AutoPay page opens only a session this app was just given (autopay-checkout.js): a link someone else
    // made with their own Cashfree session can't use Hangtag's page to ask for a mandate
    try{ const cf = new URLSearchParams(new URL(r.auth_url).hash.slice(1)).get("cf"); if(cf) storage.set("hangtag.autopay.session", { cf, at: Date.now() }); }catch{ /* an address it can't read: the page then refuses it */ }
    if(win){ try{ win.opener = null; win.location.href = r.auth_url; }catch{ /* "Check again" waits for it */ } }
    ck.apBusy = false; ck.apConsent = false; ck.apMsg = "Approve AutoPay on the page that opened. This updates by itself."; ck.apTone = "";
    ck.needPhone = false; ck.phone = "";   // the number typed for this set-up isn't kept
    await refreshSubscription({ force: true });
    redraw(); apPoll();
  }catch(e){
    if(win) win.close();
    // AutoPay's page needs a mobile number the shop hasn't saved (or one that isn't a mobile): asked for in the card
    const why = e && e.details && e.details.error;
    if(why === "phone_required" || why === "bad_phone") ck.needPhone = true;
    ck.apBusy = false; ck.apMsg = e && e.code === ERROR_CODES.NOT_CONFIGURED ? "AutoPay isn't available right now. Pay for a plan instead." : userMessage(e, "AutoPay couldn't be started. Try again."); ck.apTone = "bad";
    redraw();
  }
}
async function apCheck(manual){
  if(manual){ ck.apBusy = true; redraw(); }
  try{
    const r = await use("subscriptionService").autopayVerify();
    if(r && r.status === "active"){ setApPending(null); stopApPoll(); ck.apMsg = "AutoPay is on."; ck.apTone = "ok"; ck.apBusy = false; await refreshSubscription({ force: true }); load(true); renderAll(); return; }
    if(r && ["cancelled", "halted", "none"].includes(r.status)){ setApPending(null); stopApPoll(); ck.apMsg = "AutoPay wasn't approved. You can set it up again."; ck.apTone = "bad"; await refreshSubscription({ force: true }); }
    else if(manual){ ck.apMsg = "Your bank hasn't confirmed AutoPay yet. It can take a minute."; ck.apTone = ""; }
  }catch(e){
    if(manual){ ck.apMsg = userMessage(e, "AutoPay couldn't be checked. Try again."); ck.apTone = "bad"; }
    else if(!(e && e.code === ERROR_CODES.NETWORK)) logger.warn("AutoPay check failed:", e && e.code);
  }
  ck.apBusy = false; redraw();
}
function stopApPoll(){ if(apTimer){ clearTimeout(apTimer); apTimer = null; } }
function apPoll(){
  stopApPoll();
  const p = apPending(); if(!p) return;
  if(Date.now() - p.startedAt > POLL_FOR){ setApPending(null); return; }   // "Check again" still works
  apTimer = setTimeout(async () => { apTimer = null; await apCheck(false); if(apPending()) apPoll(); }, POLL_EVERY);
}
async function apCancel(){
  if(ck.apBusy) return;
  ck.apBusy = true; redraw();
  try{
    await use("subscriptionService").autopayCancel();
    setApPending(null); stopApPoll();
    ck.apConfirm = false; ck.apMsg = "AutoPay is off. Nothing more will be charged."; ck.apTone = "ok";
    await refreshSubscription({ force: true }); load(true);
  }catch(e){ ck.apMsg = userMessage(e, "AutoPay couldn't be turned off. Try again."); ck.apTone = "bad"; }
  ck.apBusy = false; renderAll(); redraw();
}

/* ---------- paying ---------- */
async function pay(){
  if(ck.busy || !ck.quote) return;
  ck.busy = true; ck.msg = ""; redraw();
  // a page opened right away keeps the browser from blocking it (the address arrives from the server a moment later)
  const free = +ck.quote.amount === 0, win = free ? null : window.open("", "_blank");
  try{
    const r = await use("subscriptionService").checkout(ck.plan, ck.applied, ck.needPhone ? ck.phone.trim() : "");
    if(r && r.free){ if(win) win.close(); await succeeded({ plan_code: ck.plan, period_end: r.period_end }); return; }
    if(!r || !r.pay_url || !/^https:\/\//.test(r.pay_url)) throw new Error("no page");
    setPending({ paymentId: r.payment_id, payUrl: r.pay_url, plan: ck.plan, startedAt: Date.now() });
    if(win){ try{ win.opener = null; win.location.href = r.pay_url; }catch{ /* the link below opens it */ } }
    ck.busy = false; redraw(); poll();
  }catch(e){
    if(win) win.close();
    ck.busy = false;
    // the payment page needs a mobile number the shop hasn't saved (or one that isn't a mobile): asked for beside Pay
    const why = e && e.details && e.details.error;
    if(why === "phone_required" || why === "bad_phone") ck.needPhone = true;
    ck.msg = e && e.code === ERROR_CODES.NOT_CONFIGURED ? "Online payment isn't set up yet. Contact Hangtag support to choose a plan." : userMessage(e, "The payment couldn't be started. Try again.");
    ck.tone = "bad";
    if(e && e.code === ERROR_CODES.NOT_CONFIGURED) ck.config = { available: false };
    redraw();
  }
}
async function succeeded(r){
  const plan = (ck.plans || []).find(p => p.code === (r.plan_code || ck.plan));
  setPending(null); stopPoll();
  if(plan) ck.plan = plan.code;   // the plan chosen on the screen is the one just paid for
  ck.busy = false; ck.done = { label: plan ? plan.label : "plan", period_end: r.period_end }; ck.msg = ""; ck.applied = ""; ck.promo = "";
  ck.needPhone = false; ck.phone = "";   // a mobile number typed for that payment isn't kept for the next
  await refreshSubscription({ force: true });
  load(true);
  renderAll();   // unlocked at once: the app comes back without a reload
}
async function check(manual){
  const p = pending();
  // the wait was settled elsewhere meanwhile (another tab of this device shares it): show where things stand now
  if(!p){ stopPoll(); await refreshSubscription({ force: true }); renderAll(); return; }
  if(manual){ ck.busy = true; redraw(); }
  try{
    const r = await use("subscriptionService").verify(p.paymentId);
    const cur = pending();
    if(!cur || cur.paymentId !== p.paymentId){
      // the wait changed while this was asked (another tab, or "Choose again" then Pay): the answer is about an older page
      // and never clears the newer wait; money that page took shows in the plan
      if(r && r.status === "paid"){ await refreshSubscription({ force: true }); renderAll(); }
      ck.busy = false; redraw(); return;
    }
    if(r && r.status === "paid"){ await succeeded({ plan_code: r.plan_code || p.plan, period_end: r.period_end }); return; }
    if(r && ["expired", "cancelled", "failed"].includes(r.status)){
      setPending(null); stopPoll();
      ck.msg = r.status === "expired" ? "The payment page expired. Choose Pay again." : "The payment didn't go through. Nothing was charged for this plan; try again.";
      ck.tone = "bad";
    }else if(manual){ ck.msg = "The payment isn't confirmed yet. It can take a minute."; ck.tone = ""; }
  }catch(e){
    if(manual){ ck.msg = userMessage(e, "The payment couldn't be checked. Try again."); ck.tone = "bad"; }
    else if(!(e && e.code === ERROR_CODES.NETWORK)) logger.warn("Plan payment check failed:", e && e.code);
  }
  ck.busy = false; redraw();
}
function stopPoll(){ if(pollTimer){ clearTimeout(pollTimer); pollTimer = null; } }
function poll(){
  stopPoll();
  const p = pending(); if(!p) return;
  // stops checking by itself; "I've paid" still works. No redraw here: the lock screen calls poll() as it draws (a redraw
  // would draw it again, and again)
  if(Date.now() - (p.startedAt || 0) > POLL_FOR) return;
  pollTimer = setTimeout(async () => { pollTimer = null; await check(false); if(pending()) poll(); }, POLL_EVERY);
}

/* Back from the payment page (…/#plans?payment=<id>, perhaps with the provider's own parameters after it): keep waiting
   for that payment */
function returnedFromPayment(){
  const m = /^#plans\?payment=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[&?].*)?$/i.exec(location.hash || "");
  if(!m) return;
  const p = pending();
  // back from the page now: the wait (and its polling) starts again from this moment, however long the paying took
  setPending(Object.assign({}, p && p.paymentId === m[1] ? p : {}, { paymentId: m[1], startedAt: Date.now() }));
  history.replaceState(null, "", location.pathname + location.search);
  ck.msg = ""; ck.tone = "";   // an earlier "expired" or "didn't go through" is about another page
  poll();
  redraw();   // an app already open on this screen shows the wait at once
}
/* Back from approving AutoPay on the provider's page (…/#plans?autopay=back, through the webhook function): checked again
   from this moment */
function returnedFromAutopay(){
  if(!/^#plans\?autopay=back(?:[&?].*)?$/i.test(location.hash || "")) return;
  history.replaceState(null, "", location.pathname + location.search);
  setApPending({ startedAt: Date.now() });
  apPoll();
  redraw();
}

let installed = false;
export function installPlansBillingEvents(){
  if(installed) return;
  installed = true;
  document.addEventListener("click", e => {
    const b = e.target && e.target.closest && e.target.closest("[data-sub-act]");
    if(!b) return;
    const act = b.dataset.subAct;
    if(act === "apply"){ const f = b.closest("[data-subck]"), inp = f && f.querySelector('input[name="subPromo"]'), v = ((inp || {}).value || "").trim().toUpperCase(); ck.promo = v; ck.applied = v; ck.msg = v ? "" : "Type a promo code first."; ck.tone = v ? "" : "bad"; if(v) quote(); else redraw(); }
    else if(act === "pay") pay();
    else if(act === "check") check(true);
    else if(act === "forget"){ setPending(null); stopPoll(); ck.msg = ""; redraw(); }
    else if(act === "reload") load(true);
    else if(act === "refresh"){ b.setAttribute("aria-busy", "true"); refreshSubscription({ force: true }).then(() => { load(true); renderAll(); }); }
    else if(act === "signout") requestSignOut();
    else if(act === "ap-start") apStart();
    else if(act === "ap-check") apCheck(true);
    else if(act === "ap-cancel"){ ck.apConfirm = true; ck.apMsg = ""; redraw(); }
    else if(act === "ap-cancel-no"){ ck.apConfirm = false; redraw(); }
    else if(act === "ap-cancel-yes") apCancel();
  });
  document.addEventListener("change", e => {
    const r = e.target;
    if(r && r.name === "subPlan" && r.checked){ ck.plan = r.value; ck.done = null; if(ck.applied){ ck.msg = ""; } quote(); }
    if(r && r.matches && r.matches("[data-ap-consent]")){ ck.apConsent = !!r.checked; ck.apMsg = ""; redraw(); }
  });
  document.addEventListener("submit", e => { if(e.target && e.target.matches && e.target.matches("[data-subck]")) e.preventDefault(); });
  document.addEventListener("input", e => { if(e.target && e.target.name === "subPromo"){ ck.promo = e.target.value; if(!e.target.value.trim() && ck.applied){ ck.applied = ""; ck.msg = ""; quote(); } } });
  document.addEventListener("input", e => { if(e.target && e.target.name === "subPhone") ck.phone = e.target.value; });
  document.addEventListener("keydown", e => {
    if(e.key === "Enter" && e.target && e.target.name === "subPromo"){ e.preventDefault(); const f = e.target.closest("[data-subck]"), b = f && f.querySelector('[data-sub-act="apply"]'); if(b) b.click(); }
  });
  // While locked, keyboard shortcuts and clicks can't reach the app behind the lock screen
  const outside = e => subscriptionLocked() && !(e.target && e.target.closest && e.target.closest("#lockScreen"));
  document.addEventListener("keydown", e => { if(outside(e) && e.key !== "Tab") e.stopImmediatePropagation(); }, true);
  document.addEventListener("click", e => { if(outside(e)){ e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  returnedFromPayment(); returnedFromAutopay();
  // a return that only changes the address's #part (the app already open in this tab) counts too
  window.addEventListener("hashchange", () => { returnedFromPayment(); returnedFromAutopay(); });
  if(pending()) poll();
  if(apPending()) apPoll();
}
