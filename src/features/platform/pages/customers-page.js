// Console → Customers: every shop, from its own records (hangtag_platform_customers): who owns it, its plan and AutoPay,
// when its access ends, when it was last used, its catalog, stock and problems. Searched (shop, owner, phone, email,
// account ID, GSTIN), in a list, sorted, a page at a time. A row opens the shop's page (ten tabs) with the actions the role
// may take; the database previews each one, needs its reason, checks the role again and writes it to the audit log.
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { ACTIONS, CUSTOMER_LISTS, CUSTOMER_TABS, SORTS, autopayBadge, lifecycleBadge, pick, shopActions } from '../../../domain/platform/console.js';
import { count, day, money, when } from '../services/console-ui.js';
import { badgeHTML, chipsHTML, kv, listEmptyHTML, listErrorHTML, listLoadingHTML, openPanel, pagerHTML, setAddress, paint } from '../services/console-list.js';
import { activityHTML, hiddenHTML, paymentsTableHTML, subscriptionHTML } from '../services/console-detail.js';
import { confirmAction } from '../components/action-dialog.js';

const LIMIT = 25;
const name = r => r.shop_name || r.owner_name || r.email || "Shop without a name yet";

function rowsHTML(rows){
  return `<div class="pc-table-wrap"><table class="pc-table pc-stack"><thead><tr><th>Shop</th><th>Contact</th><th>Plan</th><th>Access until</th><th>AutoPay</th>
    <th>Last active</th><th class="num">Products</th><th class="num">Stock</th><th class="num">Errors (30 d)</th></tr></thead><tbody>${rows.map(r => `<tr>
    <td data-l="Shop"><button type="button" class="pc-rowbtn" data-pc-open="${esc(r.owner_id)}">${esc(name(r))}</button>${r.owner_name && r.shop_name ? `<br><small>${esc(r.owner_name)}</small>` : ""}</td>
    <td data-l="Contact">${esc(r.email || "—")}${r.phone ? `<br><small>${esc(r.phone)}</small>` : ""}</td>
    <td data-l="Plan">${badgeHTML(lifecycleBadge(r.lifecycle))}${r.plan_label ? `<br><small>${esc(r.plan_label)}</small>` : ""}</td>
    <td data-l="Access until" class="nowrap">${esc(day(r.access_until))}</td>
    <td data-l="AutoPay">${badgeHTML(autopayBadge(r.autopay_status))}</td>
    <td data-l="Last active" class="nowrap">${r.last_active ? esc(day(r.last_active)) : "Never"}</td>
    <td data-l="Products" class="num">${esc(count(r.products))}</td><td data-l="Stock" class="num">${esc(count(r.stock))}</td>
    <td data-l="Errors (30 d)" class="num">${+r.errors_30d ? `<span class="chip-s nodot bad">${esc(count(r.errors_30d))}</span>` : "0"}</td></tr>`).join("")}</tbody></table></div>`;
}

/* The shop's page: one tab at a time */
function tabHTML(tab, d){
  if(tab === "overview"){
    const o = d.overview;
    return `<dl class="pc-dl">${kv("Shop", o.shop_name)}${kv("Owner", o.owner_name)}${kv("Email", o.email)}${kv("Phone", o.phone)}${kv("GSTIN", o.gstin)}
      ${kv("City", [o.city, o.region].filter(Boolean).join(", "))}${kv("Business", o.business_type)}${kv("Account ID", `<code>${esc(o.owner_id)}</code>`, true)}
      ${kv("Signed up", when(o.signed_up_at))}${kv("Shop set up", o.onboarded_at ? when(o.onboarded_at) : "Not yet")}${kv("Last active", o.last_active ? when(o.last_active) : "Never")}
      ${kv("Plan", badgeHTML(lifecycleBadge(o.lifecycle)), true)}${kv("Access until", day(o.access_until))}${kv("Products", count(o.products))}${kv("Units in stock", count(o.stock))}
      ${kv("Problems, 30 days", count(o.errors_30d))}${kv("Paid to Hangtag (captured)", money(o.revenue))}</dl>`;
  }
  if(tab === "subscription") return subscriptionHTML(d.subscription);
  if(tab === "payments") return paymentsTableHTML(d.payments);
  if(tab === "usage"){
    const u = d.usage;
    if(!u) return hiddenHTML("usage");
    return `<dl class="pc-dl">${kv("Bills, all time", count(u.bills))}${kv("Bills, 30 days", count(u.bills_30d))}${kv("Bills, 7 days", count(u.bills_7d))}
      ${kv("Days with bills, 30 days", count(u.days_billing_30d))}${kv("Cancelled bills", count(u.cancelled_bills))}${kv("First bill", u.first_bill_at ? when(u.first_bill_at) : "None yet")}
      ${kv("Last bill", u.last_bill_at ? when(u.last_bill_at) : "None yet")}${kv("Team members", count(u.team))}${kv("Staff phones", count(u.phones))}
      ${kv("Customers saved", count(u.customers))}${kv("Last active", u.last_active ? when(u.last_active) : "Never")}</dl>`;
  }
  if(tab === "inventory"){
    const i = d.inventory;
    if(!i) return hiddenHTML("inventory");
    return `<dl class="pc-dl">${kv("Products on sale", count(i.products))}${kv("Variants on sale", count(i.variants))}${kv("Units in stock", count(i.stock))}
      ${kv("Archived products", count(i.archived))}${kv("Stock changes, 30 days", count(i.moves_30d))}${kv("Last stock change", i.last_change_at ? when(i.last_change_at) : "None yet")}</dl>
      <p class="note">Units in stock: what was received or adjusted, less what was sold, plus returns put back.</p>`;
  }
  if(tab === "communications"){
    const c = d.communications;
    if(!c) return hiddenHTML("messages");
    return `<dl class="pc-dl">${kv("Sent, 30 days", count(c.sent_30d))}${kv("Delivered, 30 days", count(c.delivered_30d))}${kv("Failed, 30 days", count(c.failed_30d))}${kv("Waiting", count(c.pending))}</dl>
      ${c.recent.length ? `<div class="pc-table-wrap"><table class="pc-table pc-stack"><thead><tr><th>When</th><th>Channel</th><th>Status</th><th>Provider</th><th>Problem</th></tr></thead><tbody>
        ${c.recent.map(m => `<tr><td data-l="When" class="nowrap">${esc(when(m.t))}</td><td data-l="Channel">${esc(m.channel)}</td>
          <td data-l="Status">${badgeHTML({ label: m.delivered_at ? "Delivered" : m.status === "sent" ? "Sent" : m.status === "failed" ? "Failed" : "Waiting", tone: m.status === "failed" ? "bad" : m.delivered_at ? "ok" : "" })}</td>
          <td data-l="Provider">${esc(m.provider || "—")}</td><td data-l="Problem">${esc(m.error || "—")}</td></tr>`).join("")}</tbody></table></div>`
        : '<div class="pc-empty"><p>No receipts or messages sent yet.</p></div>'}<p class="note">Who each message went to stays with the shop.</p>`;
  }
  if(tab === "errors"){
    const e = d.errors;
    if(!e) return hiddenHTML("errors");
    const where = { message: "Message", webhook: "Webhook", payment: "Plan payment" };
    return e.recent.length ? `<p class="note">${esc(count(e.count_30d))} in the last 30 days.</p><div class="pc-table-wrap"><table class="pc-table pc-stack"><thead><tr><th>When</th><th>Where</th><th>What</th><th>Detail</th></tr></thead><tbody>
      ${e.recent.map(x => `<tr><td data-l="When" class="nowrap">${esc(when(x.t))}</td><td data-l="Where">${esc(where[x.source] || x.source)}</td><td data-l="What">${esc(x.what || "—")}</td>
        <td data-l="Detail">${esc(x.detail || "—")}</td></tr>`).join("")}</tbody></table></div>`
      : '<div class="pc-empty"><p>No failed messages, webhooks or plan payments in the last 30 days.</p></div>';
  }
  if(tab === "referrals") return d.referrals ? '<div class="pc-empty"><p>Hangtag doesn\'t keep referrals yet, so there is nothing to show here.</p><p class="note">No sample figures.</p></div>' : hiddenHTML("referrals");
  if(tab === "wallet") return d.wallet ? '<div class="pc-empty"><p>Hangtag has no wallet or credit ledger yet: no balance to show, and no credit can be added.</p></div>' : hiddenHTML("the wallet");
  return activityHTML(d.activity);
}

/* The shop's page in the side panel; actions shown only to roles that may take them (the database checks again) */
export async function openCustomer(host, owner, { me, onChanged, tab = "overview" }){
  const P = use("platform"), pn = openPanel(host, { label: "Customer" });
  const st = { tab, d: null, msg: "" };
  const draw = () => {
    const d = st.d, o = d.overview, acts = shopActions(me.perms, o.state).filter(a => (a === "suspend" || a === "restore" ? d.can.suspend : a === "sign_out" ? d.can.sessions : d.can.subscriptions));
    pn.title.innerHTML = `<h2>${esc(name(o))}</h2><p class="note">${badgeHTML(lifecycleBadge(o.lifecycle))} ${esc(o.email || "")}</p>`;
    pn.body.innerHTML = `${st.msg ? `<p class="pc-msg ok" role="status">${esc(st.msg)}</p>` : ""}
      ${acts.length ? `<div class="pc-actions" role="group" aria-label="Actions">${acts.map(a => `<button type="button" class="btn sm${ACTIONS[a].danger ? " danger" : ""}" data-pc-act="${a}">${esc(ACTIONS[a].label)}</button>`).join("")}</div>` : ""}
      <div class="pc-tabs" role="tablist" aria-label="Customer">${CUSTOMER_TABS.map(([k, l]) => `<button type="button" role="tab" id="pcTab-${k}" aria-controls="pcTabPanel" aria-selected="${k === st.tab ? "true" : "false"}" tabindex="${k === st.tab ? "0" : "-1"}" data-pc-tab="${k}">${esc(l)}</button>`).join("")}</div>
      <div class="pc-tabpanel" id="pcTabPanel" role="tabpanel" aria-labelledby="pcTab-${st.tab}" tabindex="0">${tabHTML(st.tab, d)}</div>`;
  };
  const load = async () => {
    pn.body.innerHTML = listLoadingHTML();
    try{ st.d = await P.customer(owner); draw(); }
    catch(e){ pn.title.innerHTML = "<h2>Customer</h2>"; pn.body.innerHTML = listErrorHTML(e); }
  };
  pn.body.addEventListener("click", async e => {
    const t = e.target.closest && e.target.closest("[data-pc-tab],[data-pc-act],[data-pc-reload]");
    if(!t) return;
    if(t.dataset.pcReload !== undefined){ load(); return; }
    if(t.dataset.pcTab){ st.tab = t.dataset.pcTab; draw(); const b = pn.body.querySelector(`[data-pc-tab="${st.tab}"]`); if(b) b.focus(); return; }
    const act = t.dataset.pcAct, r = await confirmAction(pn.panel, { owner, action: act, shopName: name(st.d.overview), plans: st.d.plans });
    if(!r) return;
    st.msg = `Done: ${ACTIONS[act].label.toLowerCase()}. The audit log has who, why, before and after.`;
    await load();
    if(onChanged) onChanged();
  });
  // arrow keys move between the tabs
  pn.body.addEventListener("keydown", e => {
    const t = e.target.closest && e.target.closest("[data-pc-tab]");
    if(!t || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    const keys = CUSTOMER_TABS.map(([k]) => k), i = keys.indexOf(st.tab);
    st.tab = keys[(i + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length]; draw();
    const b = pn.body.querySelector(`[data-pc-tab="${st.tab}"]`); if(b) b.focus();
  });
  await load();
  return pn;
}

export async function renderCustomers(main, { me, query = {} }){
  const P = use("platform");
  const st = { q: query.q || "", list: pick(CUSTOMER_LISTS, query.filter), sort: pick(SORTS, query.sort), offset: 0, data: null, err: null, loading: true, seq: 0 };
  main.innerHTML = `<div class="pc-page">
    <div class="pc-head"><h1>Customers</h1><span class="note" id="pcTotal"></span><button type="button" class="btn sm" data-pc-reload>Refresh</button></div>
    <form class="pc-tools" role="search" data-pc-search novalidate>
      <label class="pc-f pc-grow"><span>Search</span><input type="search" name="q" value="${esc(st.q)}" maxlength="120" autocomplete="off" placeholder="Shop, owner, phone, email, GSTIN or account ID"></label>
      <label class="pc-f"><span>Sort</span><select name="sort">${SORTS.map(([k, l]) => `<option value="${k}"${k === st.sort ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <button type="submit" class="btn sm">Search</button></form>
    <div id="pcChips"></div><div id="pcRes" aria-live="polite"></div></div>`;
  const chips = main.querySelector("#pcChips"), res = main.querySelector("#pcRes"), total = main.querySelector("#pcTotal");
  const draw = () => {
    paint(chips, chipsHTML(CUSTOMER_LISTS, st.data && st.data.counts, st.list, "Lists"));
    if(st.err){ res.innerHTML = listErrorHTML(st.err); total.textContent = ""; return; }
    if(st.loading && !st.data){ res.innerHTML = listLoadingHTML(); return; }
    const d = st.data;
    total.textContent = `${count(d.total)} shown of ${count(d.counts ? d.counts.all : d.total)}`;
    res.classList.toggle("pc-busy", st.loading);
    res.innerHTML = d.rows.length ? rowsHTML(d.rows) + pagerHTML(d.total, st.offset, LIMIT)
      : listEmptyHTML(st.q || st.list !== "all" ? "No customers match this search and list." : "No shops have signed up yet.", !!(st.q || st.list !== "all"));
  };
  const load = async () => {
    const seq = ++st.seq;
    st.loading = true; st.err = null; draw();
    setAddress("customers", { filter: st.list, sort: st.sort === "newest" ? "" : st.sort, q: st.q });
    try{
      const d = await P.customers({ q: st.q, list: st.list, sort: st.sort, limit: LIMIT, offset: st.offset });
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
    if(!t || (e.target.closest(".pc-panel-wrap") && !t.matches("[data-pc-open]"))) return;
    if(t.dataset.pcList){ st.list = t.dataset.pcList; st.offset = 0; load(); }
    else if(t.dataset.pcPage){ st.offset = Math.max(0, st.offset + (t.dataset.pcPage === "next" ? LIMIT : -LIMIT)); load(); }
    else if(t.dataset.pcOpen){ openCustomer(main, t.dataset.pcOpen, { me, onChanged: load }); }
    else if(t.dataset.pcClear !== undefined){ st.q = ""; st.list = "all"; st.offset = 0; const i = main.querySelector('input[name="q"]'); if(i) i.value = ""; load(); }
    else if(t.dataset.pcReload !== undefined){ load(); }
  };
  await load();
}
