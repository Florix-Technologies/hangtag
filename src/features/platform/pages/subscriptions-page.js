// Console → Subscriptions: every shop's plan (hangtag_platform_subscriptions), from the subscription records the state
// machine and the provider's webhooks keep — the console never sets a plan's state itself. Customer, plan, status, trial,
// current period, next charge, AutoPay, the latest payment, the offer used. A row opens the plan in full, its payments and,
// for roles that may, giving a plan or extending it (previewed, with a reason, in the audit log).
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { ACTIONS, SORTS, SUBSCRIPTION_LISTS, autopayBadge, lifecycleBadge, paymentBadge, pick, shopActions } from '../../../domain/platform/console.js';
import { count, day, money } from '../services/console-ui.js';
import { badgeHTML, chipsHTML, listEmptyHTML, listErrorHTML, listLoadingHTML, openPanel, pagerHTML, setAddress, paint } from '../services/console-list.js';
import { paymentsTableHTML, subscriptionHTML } from '../services/console-detail.js';
import { confirmAction } from '../components/action-dialog.js';

const LIMIT = 25;
const name = r => r.shop_name || r.owner_name || r.email || "Shop without a name yet";

function rowsHTML(rows){
  return `<div class="pc-table-wrap"><table class="pc-table pc-stack"><thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th>Trial ends</th><th>Current period</th>
    <th>Next billing</th><th>AutoPay</th><th>Latest payment</th><th>Offer</th></tr></thead><tbody>${rows.map(r => `<tr>
    <td data-l="Customer"><button type="button" class="pc-rowbtn" data-pc-open="${esc(r.owner_id)}">${esc(name(r))}</button>${r.owner_name && r.shop_name ? `<br><small>${esc(r.owner_name)}</small>` : ""}</td>
    <td data-l="Plan">${esc(r.plan_label || "Trial")}</td>
    <td data-l="Status">${badgeHTML(lifecycleBadge(r.lifecycle))}</td>
    <td data-l="Trial ends" class="nowrap">${esc(day(r.trial_ends_at))}</td>
    <td data-l="Current period" class="nowrap">${r.period_end ? `${esc(day(r.period_start))} → ${esc(day(r.period_end))}` : "—"}</td>
    <td data-l="Next billing" class="nowrap">${r.next_charge_at ? esc(day(r.next_charge_at)) : r.access_until ? `<small>Renew by</small> ${esc(day(r.access_until))}` : "—"}</td>
    <td data-l="AutoPay">${badgeHTML(autopayBadge(r.autopay_status))}</td>
    <td data-l="Latest payment">${r.last_payment_status ? `${badgeHTML(paymentBadge(r.last_payment_status))}<br><small>${esc(day(r.last_payment_at))}</small>` : "None"}</td>
    <td data-l="Offer">${r.promo_code ? `<code>${esc(r.promo_code)}</code>${+r.discount ? `<br><small>−${esc(money(r.discount))}</small>` : ""}` : "—"}</td></tr>`).join("")}</tbody></table></div>`;
}

async function openSubscription(host, owner, { me, onChanged }){
  const P = use("platform"), pn = openPanel(host, { label: "Subscription" });
  const st = { d: null, msg: "" };
  const draw = () => {
    const d = st.d, s = d.subscription || {}, c = d.customer;
    const acts = d.can.subscriptions ? shopActions(me.perms, s.state).filter(a => a === "grant" || a === "extend") : [];
    pn.title.innerHTML = `<h2>${esc(name(c))}</h2><p class="note">${badgeHTML(lifecycleBadge(s.lifecycle || "none"))} ${esc(c.email || "")}</p>`;
    pn.body.innerHTML = `${st.msg ? `<p class="pc-msg ok" role="status">${esc(st.msg)}</p>` : ""}
      ${acts.length ? `<div class="pc-actions" role="group" aria-label="Actions">${acts.map(a => `<button type="button" class="btn sm" data-pc-act="${a}">${esc(ACTIONS[a].label)}</button>`).join("")}
        <a class="btn sm" href="#/customers?q=${encodeURIComponent(c.owner_id)}">Open the customer</a></div>`
        : `<div class="pc-actions"><a class="btn sm" href="#/customers?q=${encodeURIComponent(c.owner_id)}">Open the customer</a></div>`}
      ${subscriptionHTML(d.subscription)}<h3 class="pc-sub">Payments</h3>${paymentsTableHTML(d.payments)}`;
  };
  const load = async () => {
    pn.body.innerHTML = listLoadingHTML();
    try{ st.d = await P.subscription(owner); draw(); }
    catch(e){ pn.title.innerHTML = "<h2>Subscription</h2>"; pn.body.innerHTML = listErrorHTML(e); }
  };
  pn.body.addEventListener("click", async e => {
    const t = e.target.closest && e.target.closest("[data-pc-act],[data-pc-reload],a[href^='#/customers']");
    if(!t) return;
    if(t.matches("a")){ pn.close(); return; }
    if(t.dataset.pcReload !== undefined){ load(); return; }
    const act = t.dataset.pcAct, r = await confirmAction(pn.panel, { owner, action: act, shopName: name(st.d.customer), plans: st.d.plans });
    if(!r) return;
    st.msg = `Done: ${ACTIONS[act].label.toLowerCase()}. The audit log has who, why, before and after.`;
    await load();
    if(onChanged) onChanged();
  });
  await load();
}

export async function renderSubscriptions(main, { me, query = {} }){
  const P = use("platform");
  const st = { q: query.q || "", list: pick(SUBSCRIPTION_LISTS, query.filter), sort: query.sort && SORTS.some(([k]) => k === query.sort) ? query.sort : "expiry",
    offset: 0, data: null, err: null, loading: true, seq: 0 };
  main.innerHTML = `<div class="pc-page">
    <div class="pc-head"><h1>Subscriptions</h1><span class="note" id="pcTotal"></span><button type="button" class="btn sm" data-pc-reload>Refresh</button></div>
    <form class="pc-tools" role="search" data-pc-search novalidate>
      <label class="pc-f pc-grow"><span>Search</span><input type="search" name="q" value="${esc(st.q)}" maxlength="120" autocomplete="off" placeholder="Shop, owner, phone, email, GSTIN or account ID"></label>
      <label class="pc-f"><span>Sort</span><select name="sort">${SORTS.map(([k, l]) => `<option value="${k}"${k === st.sort ? " selected" : ""}>${esc(k === "expiry" ? "Ending soonest" : l)}</option>`).join("")}</select></label>
      <button type="submit" class="btn sm">Search</button></form>
    <div id="pcChips"></div><div id="pcRes" aria-live="polite"></div>
    <p class="note">Plans move only with payments the provider confirmed (its webhooks) and the console's audited actions.</p></div>`;
  const chips = main.querySelector("#pcChips"), res = main.querySelector("#pcRes"), total = main.querySelector("#pcTotal");
  const draw = () => {
    paint(chips, chipsHTML(SUBSCRIPTION_LISTS, st.data && st.data.counts, st.list, "Lists"));
    if(st.err){ res.innerHTML = listErrorHTML(st.err); total.textContent = ""; return; }
    if(st.loading && !st.data){ res.innerHTML = listLoadingHTML(); return; }
    const d = st.data;
    total.textContent = `${count(d.total)} shown of ${count(d.counts ? d.counts.all : d.total)}`;
    res.classList.toggle("pc-busy", st.loading);
    res.innerHTML = d.rows.length ? rowsHTML(d.rows) + pagerHTML(d.total, st.offset, LIMIT)
      : listEmptyHTML(st.q || st.list !== "all" ? "No subscriptions match this search and list." : "No shop has a plan yet.", !!(st.q || st.list !== "all"));
  };
  const load = async () => {
    const seq = ++st.seq;
    st.loading = true; st.err = null; draw();
    setAddress("subscriptions", { filter: st.list, sort: st.sort === "expiry" ? "" : st.sort, q: st.q });
    try{
      const d = await P.subscriptions({ q: st.q, list: st.list, sort: st.sort, limit: LIMIT, offset: st.offset });
      if(seq !== st.seq) return;
      st.data = d;
    }catch(e){ if(seq !== st.seq) return; st.err = e; }
    st.loading = false; draw();
  };
  let timer = 0;
  main.onsubmit = e => {
    const f = e.target;
    if(!f.matches("[data-pc-search]")) return;
    e.preventDefault(); st.q = String(f.elements.q.value || "").trim(); st.sort = f.elements.sort.value; st.offset = 0; load();
  };
  main.oninput = e => {
    if(e.target.name !== "q" || !e.target.closest("[data-pc-search]")) return;
    clearTimeout(timer);
    timer = setTimeout(() => { const v = String(e.target.value || "").trim(); if(v !== st.q){ st.q = v; st.offset = 0; load(); } }, 400);
  };
  main.onchange = e => { if(e.target.name === "sort" && e.target.closest("[data-pc-search]")){ st.sort = e.target.value; st.offset = 0; load(); } };
  main.onclick = e => {
    const t = e.target.closest && e.target.closest("[data-pc-list],[data-pc-page],[data-pc-open],[data-pc-clear],[data-pc-reload]");
    if(!t || e.target.closest(".pc-panel-wrap")) return;
    if(t.dataset.pcList){ st.list = t.dataset.pcList; st.offset = 0; load(); }
    else if(t.dataset.pcPage){ st.offset = Math.max(0, st.offset + (t.dataset.pcPage === "next" ? LIMIT : -LIMIT)); load(); }
    else if(t.dataset.pcOpen){ openSubscription(main, t.dataset.pcOpen, { me, onChanged: load }); }
    else if(t.dataset.pcClear !== undefined){ st.q = ""; st.list = "all"; st.offset = 0; const i = main.querySelector('input[name="q"]'); if(i) i.value = ""; load(); }
    else if(t.dataset.pcReload !== undefined){ load(); }
  };
  await load();
}
