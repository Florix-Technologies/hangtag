// The Platform Console's detail panels, shared by Customers, Subscriptions and Payments: a shop's plan in full, its
// payments, its history. Only what the database returned is drawn; a part the role may not see says so.
import { esc } from '../../../shared/dom.js';
import { activityLabel, autopayBadge, lifecycleBadge, paymentBadge, stateLabel, ROLE_LABELS } from '../../../domain/platform/console.js';
import { count, day, money, when } from './console-ui.js';
import { badgeHTML, kv } from './console-list.js';

export const hiddenHTML = what => `<div class="pc-empty"><p>Your console role can't see ${esc(what)}.</p></div>`;
const span = (a, b) => (a || b ? `${day(a)} → ${day(b)}` : "—");
const code = v => (v ? `<code>${esc(v)}</code>` : "—");

/* A shop's plan (hangtag_platform_sub_json) */
export function subscriptionHTML(s){
  if(s === undefined || s === null) return hiddenHTML("plans");
  if(!s.lifecycle || s.lifecycle === "none" || s.state === "none") return `<div class="pc-empty"><p>No plan yet: this account hasn't finished setting up its shop.</p></div>`;
  const ap = s.autopay || {}, plan = s.plan, promo = s.promo, susp = s.suspension;
  return `<dl class="pc-dl">
    ${kv("Status", `${badgeHTML(lifecycleBadge(s.lifecycle))} <small>${esc(stateLabel(s.state))}</small>`, true)}
    ${kv("Plan", plan ? `${esc(plan.label)} · ${esc(money(plan.price))} for ${esc(count(plan.months))} month${plan.months === 1 ? "" : "s"}` : "Trial (no paid plan yet)", true)}
    ${kv("Trial", span(s.trial_started_at, s.trial_ends_at))}
    ${kv("Current paid period", s.period_end ? span(s.period_start, s.period_end) : "—")}
    ${kv("Access until", day(s.access_until))}
    ${kv("Next charge (AutoPay)", s.next_charge_at ? when(s.next_charge_at) : "—")}
    ${kv("Wallet used", "None: Hangtag has no wallet yet")}
  </dl>
  <h3 class="pc-sub">AutoPay</h3>
  <dl class="pc-dl">
    ${kv("Mandate", badgeHTML(autopayBadge(ap.status)), true)}
    ${kv("Required for the trial", ap.required ? "Yes" : "No")}
    ${kv("Renews", ap.plan_label ? `${ap.plan_label} · ${money(ap.price)}` : "—")}
    ${kv("Provider", ap.provider || "—")}
    ${kv("Provider subscription ID", code(ap.subscription_id), true)}
    ${kv("Authorised", ap.authorized_at ? when(ap.authorized_at) : "—")}
    ${kv("Consent", ap.consent_at ? `${when(ap.consent_at)} (${ap.consent_version || "—"})` : "—")}
    ${kv("Last failure", ap.failed_at ? when(ap.failed_at) : "—")}
    ${kv("Turned off", ap.cancelled_at ? when(ap.cancelled_at) : "—")}
  </dl>
  ${promo ? `<h3 class="pc-sub">Offer used</h3><dl class="pc-dl">${kv("Code", code(promo.code), true)}${kv("Offer", promo.title || "—")}${kv("Discount", money(promo.discount))}
    ${kv("Paid", `${money(promo.amount)} of ${money(promo.price)}`)}${kv("When", when(promo.paid_at))}</dl>` : ""}
  ${susp ? `<h3 class="pc-sub">Suspension</h3><dl class="pc-dl">${kv("Since", when(susp.at))}${kv("By", ROLE_LABELS[susp.by_role] || susp.by_role || "—")}${kv("Reason", susp.reason || "—")}</dl>` : ""}`;
}

/* A shop's plan payments (hangtag_platform_pay_json each) */
export function paymentsTableHTML(list){
  if(list === undefined || list === null) return hiddenHTML("payments");
  if(!list.length) return `<div class="pc-empty"><p>No plan payments yet.</p></div>`;
  return `<div class="pc-table-wrap"><table class="pc-table pc-stack"><thead><tr><th>When</th><th>Plan</th><th class="num">Amount</th><th>Status</th><th>Provider</th><th>Reference</th></tr></thead>
    <tbody>${list.map(p => `<tr><td data-l="When" class="nowrap">${esc(when(p.created_at))}</td><td data-l="Plan">${esc(p.plan_label || p.plan_code)}${p.promo_code ? `<br><small>${esc(p.promo_code)}</small>` : ""}</td>
      <td data-l="Amount" class="num">${esc(money(p.amount))}${+p.discount ? `<br><small>−${esc(money(p.discount))}</small>` : ""}</td><td data-l="Status">${badgeHTML(paymentBadge(p.status))}</td>
      <td data-l="Provider">${esc(p.provider)}<br><small>${p.kind === "autopay" ? "AutoPay" : "One-time"}</small></td>
      <td data-l="Reference">${code(p.provider_payment_id || p.provider_order_id)}</td></tr>`).join("")}</tbody></table></div>`;
}

/* A shop's (or a payment's) history, newest first: what happened, and for the console's actions who and why */
export function activityHTML(list){
  if(!Array.isArray(list) || !list.length) return `<div class="pc-empty"><p>Nothing recorded yet.</p></div>`;
  return `<ol class="pc-timeline">${list.map(a => `<li${a.ok === false ? ' class="bad"' : ""}><span class="pc-when">${esc(when(a.t))}</span>
    <span class="pc-what">${esc(activityLabel(a.kind))}${a.ok === false ? ' <span class="chip-s nodot bad">Not done</span>' : ""}</span>
    ${a.detail ? `<span class="pc-why">${esc(a.detail)}</span>` : ""}${a.by_role || a.by_email ? `<small>${esc([a.by_email, ROLE_LABELS[a.by_role] || a.by_role].filter(Boolean).join(" · "))}</small>` : ""}</li>`).join("")}</ol>`;
}
