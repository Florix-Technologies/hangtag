// Console → Dashboard: the totals the database counted (hangtag_platform_dashboard): shops, plans, AutoPay, the money the
// payment provider captured, the offers' counters against their caps, usage. Totals only — never a shop's own rows.
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { dashboardTiles, offerProgress } from '../../../domain/platform/console.js';
import { count, day, errorPanelHTML, loadingHTML, money, when } from '../services/console-ui.js';

function offersHTML(list){
  if(!list.length) return `<p class="note">No offers with a cap yet.</p>`;
  return `<div class="pc-tiles wide">${list.map(o => {
    const p = offerProgress(o);
    return `<div class="pc-tile"><span class="pc-tl">${esc(o.title)} <code>${esc(o.code)}</code>${o.active ? "" : ' <span class="chip-s nodot">Off</span>'}</span>
      <b class="pc-tv">${esc(count(p.redeemed))}${p.cap != null ? ` <small>of ${esc(count(p.cap))} redeemed</small>` : " <small>redeemed</small>"}</b>
      ${p.cap != null ? `<div class="pc-bar" role="progressbar" aria-label="${esc(o.title)}: redeemed of the cap" aria-valuemin="0" aria-valuemax="${p.cap}" aria-valuenow="${p.redeemed}"><i style="width:${(p.share * 100).toFixed(1)}%"></i></div>
        <small>${esc(count(p.left))} left${o.ends_at ? ` · ends ${esc(day(o.ends_at))}` : ""}</small>` : ""}</div>`;
  }).join("")}</div>`;
}

export async function renderDashboard(main){
  main.innerHTML = loadingHTML("Dashboard");
  let d;
  try{ d = await use("platform").dashboard(); }catch(e){ main.innerHTML = errorPanelHTML("Dashboard", e); return; }
  main.innerHTML = `<div class="pc-page">
    <div class="pc-head"><h1>Dashboard</h1><span class="note">Counted ${esc(when(d.generated_at))}</span><button type="button" class="btn sm" data-pc-dash="reload">Refresh</button></div>
    ${dashboardTiles(d).map((g, i) => `<section class="pc-group" aria-labelledby="pcg${i}"><h2 id="pcg${i}">${esc(g.group)}</h2>
      <div class="pc-tiles">${g.items.map(t => `<div class="pc-tile"><span class="pc-tl">${esc(t.label)}</span><b class="pc-tv">${esc(t.money ? money(t.value) : count(t.value))}</b>${t.hint ? `<small>${esc(t.hint)}</small>` : ""}</div>`).join("")}</div></section>`).join("")}
    <section class="pc-group" aria-labelledby="pcgOffers"><h2 id="pcgOffers">Offers</h2>${offersHTML(Array.isArray(d.offers) ? d.offers : [])}</section>
  </div>`;
  main.querySelector('[data-pc-dash="reload"]').addEventListener("click", () => renderDashboard(main));
}
