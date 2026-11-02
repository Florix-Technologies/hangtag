// The top of a customer's profile (services/customer-insight.js): one summary — total purchases, bills, what they owe, the
// last purchase — with Collect payment when they owe; what their bills show (the Hangtag Agent's plain observations, each
// from their own records); what they buy most; and how they pay. Explanatory and non-invasive: only the shop's records,
// nothing about the person beyond what they bought and paid; money observations (dues, returns, where they stand) only for
// those who handle money or see reports.
import { customerInsightOf } from '../services/customer-insight.js';
import { accountOf } from '../services/customer-account.js';
import { can, canAny } from '../../shop/services/access.js';
import { moduleShown } from '../../shop/services/modules.js';
import { NAV_ICONS } from '../../../shared/constants/nav-icons.js';
import { esc } from '../../../shared/dom.js';
import { dayKey, dayLab } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

const plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + "s"}`;
const fmtQ = q => String(Math.round(q * 1000) / 1000);
const ago = d => d == null ? "" : d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;

export function insightHTML(c){
  const I = customerInsightOf(c.id), A = accountOf(c.id), S = I.summary, owes = A.outstanding > 0;
  const money = canAny(["view_reports", "collect_credit"]), reports = can("view_reports");
  const sum = `<div class="tmini cust4">
      <div><span>Total purchases</span><b data-acctbuy>${inrx(A.purchases)}</b><small>${S.returned > 0 ? `${inr(S.returned)} came back` : "&nbsp;"}</small></div>
      <div><span>Bills</span><b>${S.bills}</b><small>${S.bills ? `${inr(S.avgBill)} a bill` : "&nbsp;"}</small></div>
      <div class="${owes ? "owes" : ""}"><span>Outstanding</span><b data-acctdue>${inrx(A.outstanding)}</b><small>${owes && S.oldestDueDays != null ? `oldest ${ago(S.oldestDueDays)}` : "&nbsp;"}</small></div>
      <div><span>Last purchase</span><b>${S.last ? esc(dayLab(dayKey(S.last))) : "—"}</b><small>${S.last ? esc(ago(S.daysSinceLast)) : "&nbsp;"}</small></div></div>
    ${owes && can("collect_credit") ? `<div class="setactions acctact"><button class="btn sm primary" data-collect="${esc(c.id)}">Collect payment</button></div>` : ""}`;
  // what their bills show (money lines only for those who handle money; where they stand only with reports)
  const ins = I.insights.filter(x => x.kind === "serve" || (money && (x.id !== "standing" || reports)));
  const ask = reports && moduleShown("assistant") ? `<button type="button" class="link xs" data-tab="assistant" data-ask-question="${esc("Tell me about " + c.name)}">Ask the Agent</button>` : "";
  const insights = ins.length ? `<section class="cinsight" aria-label="What their bills show"><h4 class="custh">${NAV_ICONS.assistant || ""}<span>What their bills show</span>${ask}</h4>
      <ul>${ins.map(x => `<li data-cins="${esc(x.id)}">${esc(x.text)}</li>`).join("")}</ul><p class="note">From this shop&rsquo;s own bills — nothing else is collected.</p></section>` : "";
  const top = I.products.slice(0, 5);
  const products = top.length ? `<h4 class="custh">Buys most</h4><div class="ctop">${top.map(p => `<button type="button" class="ctop-r" data-prodopen="${esc(p.id)}"><span class="ct-n">${esc(p.name)}</span><span class="ct-q">${fmtQ(p.q)} · ${plural(p.bills, "bill")}</span><b class="ct-a">${inr(p.amount)}</b><small class="ct-l">last ${esc(dayLab(dayKey(p.last)))}</small></button>`).join("")}</div>` : "";
  const P = I.payments, mix = P.methods.filter(m => m.amount > 0);
  const pays = mix.length ? `<h4 class="custh">How they pay</h4><div class="cpay" role="img" aria-label="${esc(mix.map(m => `${m.label} ${m.share}%`).join(", "))}">${mix.map(m => `<i class="cp-${esc(m.key)}" style="flex:${m.share || 1}"></i>`).join("")}</div>
      <p class="cpay-l">${mix.map(m => `<span class="cp-k cp-${esc(m.key)}"><i></i>${esc(m.label)} <b>${inr(m.amount)}</b> <small>${m.share}%</small></span>`).join("")}</p>
      <p class="note">Paid <b data-acctpaid>${inrx(A.paid)}</b> of ${inrx(A.purchases)}${P.onAccount.bills ? `; ${inr(P.onAccount.amount)} taken on account on ${plural(P.onAccount.bills, "bill")}${P.onAccount.paidOff && P.onAccount.usualDays != null ? `, usually paid within ${plural(P.onAccount.usualDays, "day")}` : ""}` : ""}.</p>` : "";
  return sum + insights + products + pays;
}
