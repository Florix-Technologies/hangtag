// Inventory → Smart reorder: a read-only, phone-first view of deterministic inventory signals.
import { qtyText } from '../../../domain/catalog/units.js';
import { kpi } from '../../../shared/components/kpi.js';
import { esc } from '../../../shared/dom.js';
import { dayKey, dayLab } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { thumb } from '../../products/components/thumb.js';
import { liveProducts } from '../../products/services/catalog.js';
import { can } from '../../shop/services/access.js';
import { inventoryIntelligence } from '../services/inventory-intelligence.js';
import { reorderPOsHTML } from '../components/purchase-orders.js';

const daysText = n => n == null ? 'No recent sales' : n < 1 ? 'Under 1 day' : `${n} day${n === 1 ? '' : 's'}`;
const lastSaleText = r => r.lastSale == null ? 'Never sold' : r.daysSinceLastSale < 1 ? 'Sold today' : `Last sold ${r.daysSinceLastSale} day${r.daysSinceLastSale === 1 ? '' : 's'} ago`;
const trendText = r => r.trend === 'rising' ? `↑ ${Math.max(0, r.trendPercent || 0)}%` : r.trend === 'falling' ? `↓ ${Math.abs(r.trendPercent || 0)}%` : r.trend === 'new' ? 'New demand' : r.trend === 'steady' ? 'Steady' : 'No trend yet';

const CONF = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence: few days with sales', none: 'no sales to go on' };
/* "runs out in about 4 days (by 9 Oct) · medium confidence" — at the forecast rate */
function forecastText(row){
  const d = row.lowestForecastDays != null ? row.lowestForecastDays : row.forecastDaysRemaining;
  if(d == null) return 'No recent sales to forecast from';
  const by = dayLab(dayKey(Date.now() + d * 864e5));
  return `${d <= 0 ? 'Sold out now' : `Runs out in about ${daysText(d).toLowerCase()} (by ${by})`} at ${qtyText(row.forecastVelocity, row.unit)}/day · ${CONF[row.confidence] || ''}`;
}
function risingCard(row){
  return `<div class="intel-watch-row intel-rising"><div><b>${esc(row.name)}</b><small>Demand up ${Math.max(0, row.trendPercent || 0)}% · ${esc(forecastText(row))}</small></div><span><b>${esc(qtyText(row.availableStock, row.unit))}</b><small>in stock</small></span></div>`;
}
function suggestionVariants(row){
  const list = row.variants.filter(v => v.shouldReorder);
  if(row.variants.length < 2 || !list.length) return '';
  return `<div class="intel-vars" aria-label="Suggested quantities by variant">${list.map(v => `<div><span>${esc(v.label || v.sku || 'One size')}</span><small>${esc(qtyText(v.currentStock, row.unit))} now</small><b>+${esc(qtyText(v.suggestedReorderQty, row.unit))}</b></div>`).join('')}</div>`;
}

function recommendationCard(row, product){
  const cover = row.variants.filter(v => v.shouldReorder && v.daysRemaining != null).map(v => v.daysRemaining);
  const lowestCover = cover.length ? Math.min(...cover) : row.lowestDaysRemaining;
  const critical = row.variants.some(v => v.shouldReorder && v.currentStock <= 0);
  const buy = can('manage_inventory');
  return `<article class="intel-card ${critical ? 'critical' : ''}">
    <div class="intel-card-head">${thumb(product, 'sm')}<div class="intel-name"><div><h4>${esc(row.name)}</h4><span class="intel-badge ${critical ? 'critical' : 'reorder'}">${critical ? 'Sold out' : 'Reorder'}</span></div><p>${esc(row.reason)}</p></div></div>
    <div class="intel-metrics">
      <div><span>In stock</span><b>${esc(qtyText(row.availableStock, row.unit))}</b></div>
      <div><span>Avg/day</span><b>${esc(qtyText(row.salesVelocity, row.unit))}</b></div>
      <div><span>Lowest cover</span><b>${esc(daysText(lowestCover))}</b></div>
      <div><span>Reorder point</span><b>${esc(qtyText(row.reorderPoint, row.unit))}</b></div>
    </div>
    <p class="intel-forecast"><b>Forecast</b> ${esc(forecastText(row))}</p>
    ${suggestionVariants(row)}
    <div class="intel-action"><div><span>Suggested reorder</span><strong>+${esc(qtyText(row.suggestedReorderQty, row.unit))}</strong><small>${row.reorderCostComplete ? `estimated cost ${esc(inr(row.reorderCost))}` : 'add cost prices for an estimated purchase cost'}</small></div>${buy ? `<button type="button" class="btn sm primary" data-stockin="${esc(row.id)}">Stock in</button>` : ''}</div>
  </article>`;
}

function watchList(title, rows, kind, empty){
  const detail = r => kind === 'dead' ? `${r.deadStockVariants} variant${r.deadStockVariants === 1 ? '' : 's'} · ${lastSaleText(r)}` : kind === 'slow' ? `${r.slowStockVariants} slow variant${r.slowStockVariants === 1 ? '' : 's'} · ${lastSaleText(r)}` : lastSaleText(r);
  const value = r => {
    if(kind === 'fast') return [qtyText(r.salesVelocity, r.unit) + '/day', trendText(r)];
    if(kind === 'dead') return [inr(r.deadStockValue), 'dead stock value'];
    const covers = r.variants.filter(v => v.slowMoving && v.daysRemaining != null).map(v => v.daysRemaining);
    return [daysText(covers.length ? Math.max(...covers) : r.daysRemaining), 'highest stock cover'];
  };
  return `<section class="card intel-watch"><div class="card-h"><h3>${esc(title)}</h3><span class="intel-count">${rows.length}</span></div>${rows.length ? `<div>${rows.slice(0, 12).map(r => { const v = value(r); return `<div class="intel-watch-row"><span><b>${esc(r.name)}</b><small>${esc(detail(r))}</small></span><span><strong>${esc(v[0])}</strong><small>${esc(v[1])}</small></span></div>`; }).join('')}</div>` : `<p class="muted">${esc(empty)}</p>`}</section>`;
}

export function renderSmartReorder(host){
  const data = inventoryIntelligence(), rows = data.products, s = data.summary, c = data.config;
  if(!rows.length){
    host.innerHTML = `<div class="empty"><h2 class="vt">Smart reorder</h2><p>Add products and stock first. Recommendations will use the same inventory and bills already in Hangtag.</p><button type="button" class="btn sm" data-invsub="levels">Back to stock</button></div>`;
    return;
  }
  const byId = new Map(liveProducts().map(p => [p.id, p]));
  const reorder = rows.filter(r => r.shouldReorder);
  const fast = rows.filter(r => r.fastMoving);
  const slow = rows.filter(r => r.hasSlowStock);
  const dead = rows.filter(r => r.hasDeadStock);
  const rising = rows.filter(r => r.risingRisk);
  const marginSub = s.marginCoverage === 100 ? 'from stock with known costs' : `${s.marginCoverage}% of stock value has a cost`;
  host.innerHTML = `<div class="intel-head"><div><span class="eyebrow">Inventory intelligence</span><h2 class="vt">Smart reorder</h2><p>Calculated from your stock and completed bills. Suggestions are read-only: Hangtag never orders or changes stock for you.</p></div><button type="button" class="btn sm" data-invsub="levels">View stock</button></div>
    <div class="banner intel-method"><span><b>How this is calculated</b> · last ${c.velocityDays} days of net sales (the forecast weighs the last ${c.trendDays} days more when demand is rising or falling) · ${c.leadDays}-day lead time + ${c.safetyDays}-day buffer · reorder up to ${c.targetCoverDays} days</span><small>Deterministic · refreshes with your records</small></div>
    <div class="kpis four">${kpi('Reorder now', String(s.reorderProducts), `${s.reorderVariants} variant${s.reorderVariants === 1 ? '' : 's'} need attention`, s.reorderProducts ? 'warn' : '')}${kpi('Inventory value', inr(s.inventoryValue), 'at current selling prices')}${kpi('Potential gross margin', inr(s.marginOpportunity), marginSub)}${kpi('Dead stock value', inr(s.deadStockValue), `${s.deadStockVariants} variant${s.deadStockVariants === 1 ? '' : 's'} with no sale for ${c.deadDays}+ days`, s.deadStock ? 'crit' : '')}</div>
    ${reorderPOsHTML()}
    <section class="intel-section"><div class="intel-section-head"><div><h3>Recommended now</h3><p>Variants at or below their velocity-based reorder point.</p></div></div>${reorder.length ? `<div class="intel-list">${reorder.map(r => recommendationCard(r, byId.get(r.id) || { id: r.id, name: r.name })).join('')}</div>` : `<div class="empty compact"><p>No calculated reorder is needed right now. Products without enough sales history are left for you to judge.</p></div>`}</section>
    ${rising.length ? `<section class="intel-section"><div class="intel-section-head"><div><h3>May need ordering sooner</h3><p>Not at the reorder point yet, but demand is rising: at the recent rate they run out within the lead time and buffer (${c.leadDays + c.safetyDays} days).</p></div></div><div class="card intel-watch">${rising.map(risingCard).join('')}</div></section>` : ''}
    <div class="intel-watch-grid">${watchList('Fast movers', fast, 'fast', `Nothing has at least ${c.minFastUnits} net sales in the last ${c.velocityDays} days yet.`)}${watchList('Slow movers', slow, 'slow', 'No slow-moving stock detected.')}${watchList('Dead stock', dead, 'dead', `No stocked product has gone ${c.deadDays} days without a sale.`)}</div>
    <p class="note intel-footnote">Stock age uses first-in, first-out movement history. Margin uses saved cost prices only; missing costs are excluded, never guessed.</p>`;
}
