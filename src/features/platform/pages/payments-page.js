// Console → Payments: every plan payment (hangtag_platform_payments): the reference, the shop, the amount, the plan, when,
// the provider, the status (pending · captured · failed · cancelled · expired · granted · free) and the provider's own
// reference. Searched (shop, owner, phone, email, payment ID, provider reference), by status, between dates. A row opens
// the payment: its safe fields only (Hangtag keeps no card, token or key), its shop and plan, and what happened to it.
// Refunds are made at the provider and not recorded in Hangtag: the Refunded list says so.
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { PAYMENT_STATUSES, lifecycleBadge, paymentBadge, pick } from '../../../domain/platform/console.js';
import { count, day, endOfDay, money, startOfDay, when } from '../services/console-ui.js';
import { badgeHTML, chipsHTML, kv, listEmptyHTML, listErrorHTML, listLoadingHTML, openPanel, pagerHTML, setAddress, paint } from '../services/console-list.js';
import { activityHTML } from '../services/console-detail.js';

const LIMIT = 25;
const shop = r => r.shop_name || r.owner_name || r.email || "—";
const ref = id => String(id || "").slice(0, 8);

function rowsHTML(rows){
  return `<div class="pc-table-wrap"><table class="pc-table pc-stack"><thead><tr><th>Payment</th><th>Customer</th><th class="num">Amount</th><th>Plan</th><th>Date</th>
    <th>Provider</th><th>Status</th><th>Transaction reference</th></tr></thead><tbody>${rows.map(r => `<tr>
    <td data-l="Payment"><button type="button" class="pc-rowbtn" data-pc-open="${esc(r.id)}" aria-label="Payment ${esc(ref(r.id))}"><code>${esc(ref(r.id))}…</code></button></td>
    <td data-l="Customer">${esc(shop(r))}${r.owner_name && r.shop_name ? `<br><small>${esc(r.owner_name)}</small>` : ""}</td>
    <td data-l="Amount" class="num">${esc(money(r.amount))}${+r.discount ? `<br><small>−${esc(money(r.discount))}</small>` : ""}</td>
    <td data-l="Plan">${esc(r.plan_label || r.plan_code)}${r.promo_code ? `<br><small>${esc(r.promo_code)}</small>` : ""}</td>
    <td data-l="Date" class="nowrap">${esc(when(r.created_at))}</td>
    <td data-l="Provider">${esc(r.provider)}<br><small>${r.kind === "autopay" ? "AutoPay" : "One-time"}</small></td>
    <td data-l="Status">${badgeHTML(paymentBadge(r.status))}</td>
    <td data-l="Transaction reference">${r.provider_payment_id || r.provider_order_id ? `<code>${esc(r.provider_payment_id || r.provider_order_id)}</code>` : "—"}</td></tr>`).join("")}</tbody></table></div>`;
}

async function openPayment(host, pid){
  const P = use("platform"), pn = openPanel(host, { label: "Payment" });
  pn.body.innerHTML = listLoadingHTML();
  let p;
  try{ p = await P.payment(pid); }
  catch(e){ pn.title.innerHTML = "<h2>Payment</h2>"; pn.body.innerHTML = listErrorHTML(e); return; }
  const c = p.customer || {}, s = p.subscription || {};
  pn.title.innerHTML = `<h2>${esc(money(p.amount))} · ${esc(p.plan_label || p.plan_code)}</h2><p class="note">${badgeHTML(paymentBadge(p.status))} <code>${esc(p.id)}</code></p>`;
  pn.body.innerHTML = `<dl class="pc-dl">
      ${kv("Status", badgeHTML(paymentBadge(p.status)), true)}${kv("Amount", `${money(p.amount)} (price ${money(p.price)}${+p.discount ? `, discount ${money(p.discount)}` : ""})`)}
      ${kv("Plan", p.plan_label || p.plan_code)}${kv("Kind", p.kind === "autopay" ? "AutoPay charge" : "One-time payment")}${kv("Provider", p.provider)}
      ${kv("Provider payment reference", p.provider_payment_id ? `<code>${esc(p.provider_payment_id)}</code>` : "—", true)}
      ${kv("Provider order or subscription", p.provider_order_id ? `<code>${esc(p.provider_order_id)}</code>` : "—", true)}
      ${kv("Offer", p.promo ? `${p.promo.title || p.promo.code} (−${money(p.promo.discount)})` : p.promo_code || "—")}
      ${kv("Started", when(p.created_at))}${kv("Paid", p.paid_at ? when(p.paid_at) : "—")}${kv("Captured", p.captured_at ? when(p.captured_at) : "—")}
      ${kv("Period paid for", p.period_end ? `${day(p.period_start)} → ${day(p.period_end)}` : "—")}${kv("Given from the console", p.by_console ? "Yes" : "No")}
      ${kv("Note", p.note)}</dl>
    <h3 class="pc-sub">Customer</h3><dl class="pc-dl">${kv("Shop", c.shop_name)}${kv("Owner", c.owner_name)}${kv("Email", c.email)}${kv("Phone", c.phone)}
      ${kv("Plan now", badgeHTML(lifecycleBadge(s.lifecycle || "none")), true)}${kv("Access until", day(s.access_until))}</dl>
    <div class="pc-actions"><a class="btn sm" href="#/customers?q=${encodeURIComponent(p.owner_id)}">Open the customer</a></div>
    <h3 class="pc-sub">What happened</h3>${activityHTML(p.activity)}
    <p class="note">Hangtag keeps no card numbers, tokens or keys: the provider holds them.</p>`;
  pn.body.addEventListener("click", e => { if(e.target.closest && e.target.closest("a[href^='#/customers']")) pn.close(); });
}

export async function renderPayments(main, { query = {} }){
  const P = use("platform");
  const st = { q: query.q || "", status: pick(PAYMENT_STATUSES, query.status), days: /^\d{1,3}$/.test(query.days || "") ? +query.days : null, from: "", to: "",
    offset: 0, data: null, err: null, loading: true, seq: 0 };
  main.innerHTML = `<div class="pc-page">
    <div class="pc-head"><h1>Payments</h1><span class="note" id="pcTotal"></span><button type="button" class="btn sm" data-pc-reload>Refresh</button></div>
    <form class="pc-tools" role="search" data-pc-search novalidate>
      <label class="pc-f pc-grow"><span>Search</span><input type="search" name="q" value="${esc(st.q)}" maxlength="120" autocomplete="off" placeholder="Shop, phone, email, payment ID or provider reference"></label>
      <label class="pc-f"><span>From</span><input type="date" name="from"></label><label class="pc-f"><span>To</span><input type="date" name="to"></label>
      <button type="submit" class="btn sm">Search</button></form>
    <div id="pcChips"></div><div id="pcRes" aria-live="polite"></div></div>`;
  const chips = main.querySelector("#pcChips"), res = main.querySelector("#pcRes"), total = main.querySelector("#pcTotal");
  const draw = () => {
    paint(chips, chipsHTML(PAYMENT_STATUSES, st.data && st.data.counts, st.status, "Status")
      + (st.days ? `<p class="pc-filter-note">Last ${esc(count(st.days))} days <button type="button" class="btn sm" data-pc-days-clear aria-label="Show every date">✕</button></p>` : ""));
    if(st.err){ res.innerHTML = listErrorHTML(st.err); total.textContent = ""; return; }
    if(st.loading && !st.data){ res.innerHTML = listLoadingHTML(); return; }
    const d = st.data, narrowed = !!(st.q || st.status !== "all" || st.days || st.from || st.to);
    total.textContent = `${count(d.total)} shown · ${money(d.captured_amount)} captured`;
    res.classList.toggle("pc-busy", st.loading);
    if(st.status === "refunded" && !d.rows.length){
      res.innerHTML = `<div class="pc-empty"><p>Hangtag doesn't record refunds: a refund is made at the payment provider and isn't shown here.</p></div>`;
      return;
    }
    res.innerHTML = d.rows.length ? rowsHTML(d.rows) + pagerHTML(d.total, st.offset, LIMIT)
      : listEmptyHTML(narrowed ? "No payments match this search, status and dates." : "No plan payments yet.", narrowed);
  };
  const load = async () => {
    const seq = ++st.seq;
    st.loading = true; st.err = null; draw();
    setAddress("payments", { status: st.status, days: st.days || "", q: st.q });
    try{
      const d = await P.payments({ q: st.q, status: st.status, from: startOfDay(st.from) || null, to: endOfDay(st.to) || null, days: st.days, limit: LIMIT, offset: st.offset });
      if(seq !== st.seq) return;
      st.data = d;
    }catch(e){ if(seq !== st.seq) return; st.err = e; }
    st.loading = false; draw();
  };
  let timer = 0;
  main.onsubmit = e => {
    const f = e.target;
    if(!f.matches("[data-pc-search]")) return;
    e.preventDefault();
    st.q = String(f.elements.q.value || "").trim(); st.from = f.elements.from.value; st.to = f.elements.to.value;
    if(st.from || st.to) st.days = null;
    st.offset = 0; load();
  };
  main.oninput = e => {
    if(e.target.name !== "q" || !e.target.closest("[data-pc-search]")) return;
    clearTimeout(timer);
    timer = setTimeout(() => { const v = String(e.target.value || "").trim(); if(v !== st.q){ st.q = v; st.offset = 0; load(); } }, 400);
  };
  main.onchange = e => {
    const n = e.target.name;
    if((n !== "from" && n !== "to") || !e.target.closest("[data-pc-search]")) return;
    st[n] = e.target.value; if(st.from || st.to) st.days = null; st.offset = 0; load();
  };
  main.onclick = e => {
    const t = e.target.closest && e.target.closest("[data-pc-list],[data-pc-page],[data-pc-open],[data-pc-clear],[data-pc-reload],[data-pc-days-clear]");
    if(!t || e.target.closest(".pc-panel-wrap")) return;
    if(t.dataset.pcList){ st.status = t.dataset.pcList; st.offset = 0; load(); }
    else if(t.dataset.pcPage){ st.offset = Math.max(0, st.offset + (t.dataset.pcPage === "next" ? LIMIT : -LIMIT)); load(); }
    else if(t.dataset.pcOpen){ openPayment(main, t.dataset.pcOpen); }
    else if(t.dataset.pcDaysClear !== undefined){ st.days = null; st.offset = 0; load(); }
    else if(t.dataset.pcClear !== undefined){
      st.q = ""; st.status = "all"; st.days = null; st.from = ""; st.to = ""; st.offset = 0;
      const f = main.querySelector("[data-pc-search]"); if(f){ f.elements.q.value = ""; f.elements.from.value = ""; f.elements.to.value = ""; }
      load();
    }
    else if(t.dataset.pcReload !== undefined){ load(); }
  };
  await load();
}
