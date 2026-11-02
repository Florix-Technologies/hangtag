// The Hangtag Agent's tool host: lists the tools (domain/agent/agent-tools.js) this person may use in this shop and runs
// a call — the same way for the Agent's own answers, an AI provider's tool calls (services/agent-runner.js) or any MCP
// client. Every call is checked here: the tool exists, the role has one of its permissions, the shop has its capability
// on, the arguments fit its schema. The answers come from the shop's records through the calculations Home, Reports and
// Smart reorder already use (data below); a tool never invents a figure — when there is nothing, it says so.
// Open tools only return what to open (structuredContent.action); draft tools only return a proposal
// (structuredContent.proposal, requiresConfirmation) that a person saves with a tap (use-cases/agent-actions.js).
import { AGENT_TOOLS, agentTool, checkToolArgs, mcpToolOf, toolError, toolResult } from '../../../domain/agent/agent-tools.js';
import { CAPABILITIES } from '../../../domain/shop/capabilities.js';
import { isUnverified, unverifiedPayments } from '../../../domain/sales/payments.js';
import { vLabel } from '../../../domain/catalog/variants.js';
import { store } from '../../../shared/state/store.js';
import { addDays, dayKey, dayLong, hhmm } from '../../../shared/formatting/dates.js';
import { inr, moneyRegion } from '../../../shared/formatting/money.js';
import { D } from '../../inventory/services/ledger.js';
import { stockOf } from '../../inventory/services/stock.js';
import { inventoryIntelligence } from '../../inventory/services/inventory-intelligence.js';
import { reorderGroups, reorderPlan } from '../../inventory/use-cases/purchase-orders.js';
import { liveProducts } from '../../products/services/catalog.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { periodData } from '../../reports/services/report-data.js';
import { recentBills, salesTrend, stockAlerts, todayFigures } from '../../home/services/home-signals.js';
import { can } from '../../shop/services/access.js';
import { hasCap, shopTypeLabel } from '../../shop/services/shop-caps.js';
import { createReadOnlyBusinessQuery } from './business-query.js';
import { businessTodayView } from '../../reports/services/business-today.js';
import { customerInsightOf } from '../../customers/services/customer-insight.js';
import { briefingView } from '../../reports/services/daily-briefing.js';
import { REF_LABELS } from '../../../domain/reports/business-today.js';
import { governToolResult } from '../../../domain/agent/governance.js';
import { currentTrace, traceStep } from '../../../shared/logging/diagnostics.js';
import { logger } from '../../../shared/logging/logger.js';

/* What a reason may open from an answer (performAgentAction shows each; nothing is changed) */
const OPENABLE = ["bill", "product", "customer", "report", "reconcile", "reorder", "cashbook", "bankbook", "customers", "bills", "banks", "pos", "stock"];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const PERIOD_WORDS = { today: "today", yesterday: "yesterday", "7d": "in the last 7 days", month: "this month", lastmonth: "last month", "30d": "in the last 30 days" };
const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
/* the best matches for a name: exact, then starting with it, then containing it */
function bestMatches(list, q, keys){
  const n = norm(q), score = x => { const vals = keys(x).map(norm).filter(Boolean); return vals.some(v => v === n) ? 3 : vals.some(v => v.startsWith(n)) ? 2 : vals.some(v => v.includes(n)) ? 1 : 0; };
  const scored = list.map(x => [score(x), x]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
  return scored.length && scored[0][0] === 3 ? scored.filter(([s]) => s === 3).map(([, x]) => x) : scored.map(([, x]) => x);
}

/* What each tool does with the data. data: the shop's records (appAgentData() below, or a test's fake) */
const RUN = {
  get_today_sales(_, d){
    const x = d.today();
    const vs = x.comparedWith || "this time yesterday", ch = x.changePct == null ? "" : x.changePct === 0 ? `, the same as ${vs}` : `, ${Math.abs(x.changePct)}% ${x.changePct > 0 ? "more" : "less"} than ${vs}`;
    const pay = x.payments ? ` Cash ${inr(x.payments.cash)}, UPI ${inr(x.payments.upi)}, card ${inr(x.payments.card)}.` : "";
    const chans = x.channels && x.channels.length > 1 ? ` By channel: ${x.channels.map(c => `${c.label} ${inr(c.sales)}`).join(", ")}.` : "";
    return { text: x.bills ? `Today: ${inr(x.sales)} from ${plural(x.bills, "bill")}${ch}. Average bill ${inr(x.averageBill)}, ${plural(x.pieces, "piece")} sold.${pay}${chans}` : "No bills yet today.", data: x };
  },
  get_sales_trend({ days }, d){
    const x = d.trend(days), ch = x.previousTotal ? Math.round((x.total - x.previousTotal) / x.previousTotal * 100) : null;
    const best = x.days.reduce((b, y) => y.sales > (b ? b.sales : 0) ? y : b, null);
    return { text: x.total ? `${inr(x.total)} in the last ${days} days${ch == null ? "" : ` (${ch >= 0 ? "up" : "down"} ${Math.abs(ch)}% on the ${days} days before)`}. Best day: ${dayLong(best.date)}, ${inr(best.sales)}.` : `No sales in the last ${days} days.`,
      data: { ...x, changePct: ch } };
  },
  get_low_stock({ limit }, d){
    const all = d.lowStock(), out = all.filter(x => x.level === "out").length, items = all.slice(0, limit);
    return { text: all.length ? `${plural(out, "variant")} sold out and ${plural(all.length - out, "variant")} running low. ${items.slice(0, 5).map(x => `${x.product}${x.variant ? " " + x.variant : ""}: ${x.stock <= 0 ? "sold out" : x.stock + " left"}`).join("; ")}.` : "Nothing is running low.",
      data: { soldOut: out, low: all.length - out, items } };
  },
  get_reorder_candidates({ limit }, d){
    const all = d.reorder(), items = all.slice(0, limit), soon = d.risingSoon ? d.risingSoon() : [];
    const more = soon.length ? ` May need ordering sooner (demand rising): ${soon.slice(0, 3).map(x => `${x.product}, about ${x.forecastDaysLeft} days left at the recent rate`).join("; ")}.` : "";
    return { text: (all.length ? `${plural(all.length, "product")} to reorder. ${items.slice(0, 5).map(x => `${x.product}: ${x.stock <= 0 ? "sold out" : x.daysLeft == null ? "running low" : `about ${x.daysLeft} days left`}${x.suggestedQty ? `, order ${x.suggestedQty}${x.unit && x.unit !== "pcs" ? " " + x.unit : ""}` : ""}`).join("; ")}.` : "Nothing needs reordering right now.") + more,
      data: { count: all.length, items, risingSoon: soon.slice(0, limit) } };
  },
  get_customer_dues({ limit }, d){
    const x = d.dues();
    return { text: x.total ? `${inr(x.total)} owed by ${plural(x.customers, "customer")}. ${x.rows.slice(0, 5).map(r => `${r.name} ${inr(r.amount)}`).join(", ")}.` : "No customer owes the shop anything.",
      data: { total: x.total, customers: x.customers, rows: x.rows.slice(0, limit) } };
  },
  get_recent_bills({ limit }, d){
    const bills = d.recentBills(limit);
    return { text: bills.length ? bills.map(b => `${b.no} ${b.time} ${b.customer}: ${inr(b.total)}, ${b.state === "unpaid" ? `${inr(b.owed)} still owed` : b.state}`).join("; ") + "." : "No bills yet.", data: { bills } };
  },
  get_payment_reconciliation({ days }, d){
    const x = d.reconciliation(days), um = x.unmatched;
    return { text: `${x.unverified.count ? `${plural(x.unverified.count, "UPI payment")} (${inr(x.unverified.amount)}) checked only by hand in the last ${days} days.` : `Every UPI payment in the last ${days} days is verified or has a reference.`} ${um.loaded ? um.count ? `${plural(um.count, "payment")} (${inr(um.amount)}) received that ${um.count === 1 ? "isn't" : "aren't"} on any bill.` : "No unmatched receipts." : "Unmatched receipts haven't been loaded from the payment provider on this device."}`,
      data: x };
  },
  get_order_status(_, d){
    const x = d.orders();
    const parts = [`${plural(x.salesOrders, "sales order")} to deliver (${inr(x.salesOrdersValue)})`, `${plural(x.quotations, "quotation")} waiting`, x.onlineOrders ? `${x.onlineOrders} from the online store` : "", `${plural(x.heldBills, "bill")} on hold`, `${plural(x.purchaseOrdersToReceive, "purchase order")} to receive`].filter(Boolean);
    return { text: parts.join(", ") + ".", data: x };
  },
  get_profit_summary({ period }, d){
    const x = d.profit(period), cov = Math.round((x.coverage || 0) * 100);
    return { text: !x.netSales ? `No sales ${PERIOD_WORDS[period]}.` : `Gross profit ${PERIOD_WORDS[period]}: ${inr(x.grossProfit)}${x.margin == null ? "" : ` (${x.margin}% margin)`}${x.complete ? "." : ` — on the ${cov}% of net sales whose cost price is known; add the missing cost prices for the whole figure.`}`,
      data: x };
  },
  get_gst_summary({ period }, d){
    const x = d.gst(period);
    return { text: x.gst ? `GST ${PERIOD_WORDS[period]}: ${inr(x.gst)} on ${inr(x.taxable)} (CGST ${inr(x.cgst)}, SGST ${inr(x.sgst)}, IGST ${inr(x.igst)}).` : `No GST on bills ${PERIOD_WORDS[period]}.`, data: x };
  },
  get_business_profile(_, d){
    const x = d.profile();
    return { text: `${x.name || "This shop"}: ${x.type}${x.city ? `, ${x.city}` : ""}${x.state ? `, ${x.state}` : ""}. ${x.gstin ? `GST registered (${x.gstin}).` : "Not GST registered."}${x.features.length ? ` Uses ${x.features.join(", ")}.` : ""}`, data: x };
  },
  get_business_today({ figure }, d){
    const x = d.businessToday(), by = Object.fromEntries(x.figures.map(f => [f.key, f]));
    const pick = { sales: ["sales"], average_bill: ["avgBill"], margin: ["profit"], receivables: ["receivables"], stock: ["stock"], reconciliation: ["reconciliation"],
      payments: [["cash", "upi", "card"].find(k => by[k] && by[k].unusual) || "cash"], all: x.unusual.length ? x.unusual : ["sales"] }[figure] || ["sales"];
    const figs = pick.map(k => by[k]).filter(Boolean);
    if(!figs.length) return { text: figure === "margin" ? "Gross profit isn't available to your role." : "That figure isn't available to your role.", data: { figure, figures: [] } };
    const says = f => [f.headline, ...f.reasons.map(r => r.text), f.check ? "Worth checking: " + f.check : ""].filter(Boolean).join(" ");
    const text = figure === "all" ? (x.unusual.length ? [x.summary, ...figs.map(f => f.reasons.map(r => r.text).join(" "))].filter(Boolean).join(" ") : x.summary + " " + says(by.sales)) : figs.map(says).join(" ");
    const ref = figs.flatMap(f => f.reasons).map(r => r.ref).find(r => r && OPENABLE.includes(r.target));
    return { text: text.trim(), data: { figure, comparedWith: x.comparison ? x.comparison.label : null, unusual: x.unusual, summary: x.summary,
        figures: figs.map(f => ({ key: f.key, label: f.label, value: f.value, sub: f.sub, unusual: f.unusual, headline: f.headline, reasons: f.reasons.map(r => ({ text: r.text, ref: r.ref || null })), check: f.check || null })) },
      action: ref ? { kind: "open", target: ref.target, id: ref.id || "", label: REF_LABELS[ref.target] || "Open" } : null };
  },
  get_customer_insight({ name }, d){
    const m = d.findCustomers(name);
    if(!m.length) return { error: `No customer called “${name}”.` };
    if(m.length > 1 && norm(m[0].name) !== norm(name)) return { text: `${m.length} customers match “${name}”: ${m.slice(0, 5).map(c => c.name).join(", ")}. Which one?`, data: { matches: m.slice(0, 5) } };
    const c = m[0], x = d.customerInsight(c.id), S = x.summary;
    if(!S.bills) return { text: `${c.name} hasn't bought anything yet.`, data: { customer: { id: c.id, name: c.name }, summary: S }, action: { kind: "open", target: "customer", id: c.id, label: `Open ${c.name}` } };
    const ago = S.daysSinceLast === 0 ? "today" : S.daysSinceLast === 1 ? "yesterday" : `${S.daysSinceLast} days ago`, top = x.products.slice(0, 3), main = x.payments.methods[0];
    const text = [`${c.name}: ${inr(S.purchases)} over ${plural(S.bills, "bill")} (${inr(S.avgBill)} a bill), last on ${dayLong(dayKey(S.last))} (${ago}).`,
      S.outstanding > 0 ? `Owes ${inr(S.outstanding)}${S.oldestDueDays != null ? `, the oldest part from ${S.oldestDueDays} days ago` : ""}.` : "Owes nothing.",
      top.length ? `Buys most: ${top.map(p => `${p.name} (${p.q})`).join(", ")}.` : "", main ? `Pays mostly by ${main.label} (${main.share}%).` : "", ...x.insights.map(i => i.text)].filter(Boolean).join(" ");
    return { text, data: { customer: { id: c.id, name: c.name }, summary: S, topProducts: x.products.slice(0, 5).map(p => ({ id: p.id, name: p.name, qty: p.q, amount: p.amount, bills: p.bills, last: dayKey(p.last) })),
      payments: x.payments, insights: x.insights.map(i => i.text) }, action: { kind: "open", target: "customer", id: c.id, label: `Open ${c.name}'s profile` } };
  },
  get_daily_briefing(_, d){
    const x = d.briefing(), ref = x.first.ref && OPENABLE.includes(x.first.ref.target) ? x.first.ref : null;
    return { text: [`First: ${x.first.text}`, ...x.sections.map(s => `${s.title}: ${s.lines.map(l => l.text).join(" ")}`)].join(" "),
      data: { title: x.title, first: x.first, quiet: x.quiet, sections: x.sections.map(s => ({ key: s.key, title: s.title, lines: s.lines.map(l => ({ text: l.text, ref: l.ref || null })) })) },
      action: ref ? { kind: "open", target: ref.target, id: ref.id || "", label: REF_LABELS[ref.target] || "Open" } : null };
  },
  open_bill({ bill_no }, d){
    const m = d.findBills(bill_no);
    if(!m.length) return { error: `No bill numbered “${bill_no}” on this device.` };
    if(m.length > 1) return { text: `${m.length} bills match “${bill_no}”: ${m.slice(0, 5).map(b => b.no).join(", ")}. Which one?`, data: { matches: m.slice(0, 5) } };
    const b = m[0];
    return { text: `Bill ${b.no}: ${inr(b.total)}${b.customer ? ` to ${b.customer}` : ""}, ${b.when}.`, data: { bill: b }, action: { kind: "open", target: "bill", id: b.id, label: `Open bill ${b.no}` } };
  },
  open_product({ name }, d){
    const m = d.findProducts(name);
    if(!m.length) return { error: `No product called “${name}”.` };
    if(m.length > 1 && norm(m[0].name) !== norm(name)) return { text: `${m.length} products match “${name}”: ${m.slice(0, 5).map(p => p.name).join(", ")}. Which one?`, data: { matches: m.slice(0, 5) } };
    const p = m[0];
    return { text: `${p.name}: ${p.stock} in stock.`, data: { product: p }, action: { kind: "open", target: "product", id: p.id, label: `Open ${p.name}` } };
  },
  open_customer({ name }, d){
    const m = d.findCustomers(name);
    if(!m.length) return { error: `No customer called “${name}”.` };
    if(m.length > 1 && norm(m[0].name) !== norm(name)) return { text: `${m.length} customers match “${name}”: ${m.slice(0, 5).map(c => c.name).join(", ")}. Which one?`, data: { matches: m.slice(0, 5) } };
    const c = m[0];
    return { text: `${c.name}${c.owes ? ` owes ${inr(c.owes)}` : " owes nothing"}.`, data: { customer: c }, action: { kind: "open", target: "customer", id: c.id, label: `Open ${c.name}'s account` } };
  },
  open_report({ period }){
    return { text: `Reports ${PERIOD_WORDS[period]}.`, data: { period }, action: { kind: "open", target: "report", id: period, label: `Open Reports (${PERIOD_WORDS[period]})` } };
  },
  draft_reorder({ budget }, d){
    if(budget != null && d.purchasePlan){
      const p = d.purchasePlan(budget), line = l => `${l.name}${l.vl ? " " + l.vl : ""} × ${l.q}${l.partial ? ` (of ${l.wanted})` : ""} ${inr(l.cost)}`;
      return { text: p.lines.length ? `Within ${inr(budget)}: ${p.lines.map(line).join(", ")}. Total ${inr(p.total)}, ${inr(p.left)} left.${p.skipped.length ? ` Waiting for more budget: ${p.skipped.map(l => l.name).join(", ")}.` : ""}${p.unknownCost.length ? ` No cost price, not planned: ${p.unknownCost.map(l => l.name).join(", ")}.` : ""} Nothing has been ordered.`
        : p.unknownCost.length && !p.skipped.length ? `The products to reorder have no cost price, so they can't be planned within a budget: ${p.unknownCost.map(l => l.name).join(", ")}.` : p.skipped.length ? `Nothing fits ${inr(budget)}: even one ${p.skipped[0].name} costs ${inr(p.skipped[0].price)}.` : "Nothing needs reordering right now.",
        data: { budget, total: p.total, left: p.left, lines: p.lines.map(l => ({ product: l.name, variant: l.vl || "", qty: l.q, wanted: l.partial ? l.wanted : l.q, cost: l.cost, supplier: l.supplier || null, daysLeft: l.days })),
          skipped: p.skipped.map(l => ({ product: l.name, qty: l.q })), unknownCost: p.unknownCost.map(l => ({ product: l.name, qty: l.q })) },
        action: { kind: "open", target: "reorder", id: "smart", label: "Open Smart reorder" } };
    }
    const groups = d.reorderGroups();
    return { text: groups.length ? groups.map(g => `${g.supplier || "Supplier not known yet"}: ${g.items.map(l => `${l.name}${l.vl ? " " + l.vl : ""} × ${l.q}`).join(", ")}${g.total ? ` (about ${inr(g.total)})` : ""}`).join(". ") + ". Nothing has been ordered." : "Nothing needs reordering right now.",
      data: { groups: groups.map(g => ({ supplierId: g.supplierId || null, supplier: g.supplier || null, total: g.total, items: g.items.map(l => ({ product: l.name, variant: l.vl || "", qty: l.q, unitCost: l.price == null ? null : l.price })) })) },
      action: groups.length ? { kind: "open", target: "reorder", id: "smart", label: "Open Smart reorder" } : null };
  },
  draft_purchase_order({ supplier }, d){
    const groups = d.reorderGroups(), withSup = groups.filter(g => g.supplierId);
    if(!groups.length) return { text: "Nothing needs reordering, so there is no purchase order to draft.", data: { groups: 0 } };
    const g = supplier ? withSup.find(x => norm(x.supplier).includes(norm(supplier))) : withSup[0];
    if(!g) return supplier ? { error: `No reorder suggestion for a supplier called “${supplier}”.` }
      : { text: "These products haven't been bought from a supplier yet, so I can't tell whom to order from. Choose the supplier in Smart reorder.", data: { groups: groups.length }, action: { kind: "open", target: "reorder", id: "smart", label: "Open Smart reorder" } };
    const proposal = { kind: "purchase_order", requiresConfirmation: true, supplierId: g.supplierId, supplier: g.supplier, total: g.total, items: g.items.map(l => ({ ...l })) };
    return { text: `Draft purchase order for ${g.supplier}: ${g.items.map(l => `${l.name}${l.vl ? " " + l.vl : ""} × ${l.q}`).join(", ")}${g.total ? `, about ${inr(g.total)}` : ""}. It is saved as a draft only if you confirm, and isn't sent.`, data: { supplier: g.supplier, lines: g.items.length, total: g.total }, proposal };
  },
};

/* How many rows a tool's figures carry (its first list), for the chain */
const rowsIn = d => { const list = Object.values(d || {}).find(Array.isArray); return list ? list.length : 0; };
/* access: { can(perm), hasCap(cap) }; data: the shop's records */
export function createAgentToolHost({ access, data }){
  const allowed = t => (!t.perms.length || t.perms.some(p => access.can(p))) && (!t.cap || access.hasCap(t.cap));
  return Object.freeze({
    /* MCP tools/list: only what this person may use here */
    listTools: () => AGENT_TOOLS.filter(allowed).map(mcpToolOf),
    allowed: name => { const t = agentTool(name); return !!t && allowed(t); },
    /* MCP tools/call → { content, structuredContent: { ...data, action?, proposal? }, isError } */
    callTool(toolName, args){
      // each call is a step of the question's chain (shared/logging/diagnostics.js: the tool, whether it worked, the rows)
      const trace = currentTrace(), t0 = Date.now(), step = (ok, code, ms) => { if(trace) traceStep(trace, "tool", { op: toolName, ok, code, ms }); };
      const t = agentTool(toolName);
      if(!t){ step(false, "UNKNOWN_TOOL"); return toolError(`There is no tool called “${toolName}”.`); }
      if(!allowed(t)){ step(false, "NOT_ALLOWED"); return toolError(t.cap && !access.hasCap(t.cap) ? `${t.title} is switched off for this shop.` : `Your role can't use “${t.title}”.`); }
      const a = checkToolArgs(t, args); if(!a.ok){ step(false, "BAD_ARGUMENTS"); return toolError(a.error); }
      let r;
      try{ r = RUN[t.name](a.args, data); }catch{ step(false, "READ_FAILED"); return toolError(`Couldn't read the shop's data for “${t.title}”.`); }
      if(r.error){ step(false, "NO_ANSWER"); return toolError(r.error); }
      // governed (domain/agent/governance.js): only a screen the app has, only a proposal a person can save, no shop or user ids
      const g = governToolResult(t, r);
      if(g.refused.length) logger.event("agent", "tool-refused", { op: toolName, count: g.refused.length }, "warn");
      step(true, g.refused.length ? "GOVERNED" : "", Date.now() - t0);
      if(trace) traceStep(trace, "result", { op: toolName, count: rowsIn(g.data) });
      return toolResult(r.text, { tool: t.name, kind: t.kind, ...g.data, ...(g.action ? { action: g.action } : {}), ...(g.proposal ? { proposal: g.proposal } : {}), ...(g.refused.length ? { refused: g.refused } : {}) });
    },
  });
}

/* ---------- the shop's records, through the calculations the app already uses ---------- */
export function appAgentData(now = () => Date.now()){
  const q = createReadOnlyBusinessQuery({ now });
  const billOut = s => ({ id: s.id, no: s.no || "", total: s.total, customer: s.cust && s.cust.name || "", when: `${dayLong(dayKey(s.t))} ${hhmm(s.t)}`, cancelled: !!s.void });
  return {
    today(){
      const T = todayFigures(now()), x = q.sales("today");
      return { date: dayKey(now()), sales: T.sales, bills: T.bills, averageBill: T.bills ? Math.round(T.avg * 100) / 100 : 0, pieces: T.pieces, returns: x.returns || 0, changePct: T.change,
        comparedWith: T.comparison ? T.comparison.label : null, payments: T.money,
        channels: (T.channels || []).map(c => ({ channel: c.key, label: c.label, sales: c.sales, bills: c.bills })) };
    },
    trend(days){ const x = salesTrend(now(), days); return { days: x.days.map(y => ({ date: y.k, sales: y.sales, bills: y.bills })), total: x.total, previousTotal: x.prevTotal }; },
    lowStock: () => stockAlerts().map(a => ({ productId: a.p.id, product: a.p.name, variant: vLabel(a.v) || "", stock: a.n, level: a.level })),
    reorder: () => inventoryIntelligence({ now: now() }).products.filter(r => r.shouldReorder).map(r => ({ productId: r.id, product: r.name, stock: r.currentStock, daysLeft: r.lowestDaysRemaining, forecastDaysLeft: r.lowestForecastDays, confidence: r.confidence, suggestedQty: r.suggestedReorderQty, unit: r.unit, reason: r.reason })),
    risingSoon: () => inventoryIntelligence({ now: now() }).products.filter(r => r.risingRisk).map(r => ({ productId: r.id, product: r.name, stock: r.availableStock, forecastDaysLeft: r.lowestForecastDays, trendPercent: r.trendPercent, confidence: r.confidence })),
    purchasePlan: budget => reorderPlan(budget),
    dues: () => q.dues(),
    recentBills: limit => recentBills(limit).map(({ s, st }) => ({ id: s.id, no: s.no || "", time: dayKey(s.t) === dayKey(now()) ? hhmm(s.t) : `${dayLong(dayKey(s.t))} ${hhmm(s.t)}`, customer: s.cust && s.cust.name || "Walk-in", total: s.total, state: st.key, owed: st.owed })),
    reconciliation(days){
      const k = dayKey(now()), bills = periodData(addDays(k, -(days - 1)), k, "").live.filter(isUnverified);
      const amount = bills.reduce((a, s) => a + unverifiedPayments(s).reduce((b, p) => b + (+p.amount || 0), 0), 0), um = store.unmatched;
      const open = (um || []).filter(I => !I.resolution || I.resolution === "open");
      return { unverified: { count: bills.length, amount: Math.round(amount * 100) / 100, bills: bills.slice(0, 10).map(s => ({ id: s.id, no: s.no || "", amount: unverifiedPayments(s).reduce((b, p) => b + (+p.amount || 0), 0) })) },
        unmatched: { loaded: um != null, count: open.length, amount: open.reduce((a, I) => a + (+I.paidAmount || 0), 0) } };
    },
    orders(){
      const o = q.orders(), po = q.purchaseOrders();
      return { salesOrders: o.sales, salesOrdersValue: o.salesValue, quotations: o.quotes, quotationsValue: o.quoteValue, onlineOrders: o.mobile, heldBills: Object.values(store.heldCarts || {}).filter(Boolean).length,
        purchaseOrdersToReceive: po.sent, purchaseOrderDrafts: po.drafts, purchaseOrdersValue: po.value };
    },
    profit: period => q.profit(period),
    gst: period => q.gst(period),
    profile(){
      const p = store.profile || {};
      return { name: (store.access && store.access.shopName) || p.shop_name || "", type: shopTypeLabel(), city: p.city || "", state: p.state || "", gstin: p.gstin || "", currency: moneyRegion().currency,
        features: CAPABILITIES.filter(c => hasCap(c.key)).map(c => c.label) };
    },
    findBills(no){
      // the number as printed ("INV-000127"), or its last digits ("127", "inv 127")
      const n = norm(no), tail = /(\d+)\s*$/.exec(n), digits = tail ? +tail[1] : null, all = D().sales;
      const exact = all.filter(s => norm(s.no) === n);
      return (exact.length ? exact : digits != null ? all.filter(s => { const m = /(\d+)\D*$/.exec(s.no || ""); return m && +m[1] === digits; }) : []).sort((a, b) => b.t - a.t).map(billOut);
    },
    findProducts: name => bestMatches(liveProducts(), name, p => [p.name, ...variantsOf(p).map(v => v.sku)]).slice(0, 8).map(p => ({ id: p.id, name: p.name, stock: variantsOf(p).reduce((a, v) => a + Math.max(0, stockOf(v.id)), 0) })),
    findCustomers(name){
      const owed = q.dues().rows, list = Object.values(store.customers || {}).filter(Boolean), digits = String(name).replace(/\D/g, "");
      const m = digits.length >= 4 ? list.filter(c => String(c.phone || "").replace(/\D/g, "").includes(digits)) : bestMatches(list, name, c => [c.name]);
      return m.slice(0, 8).map(c => ({ id: c.id, name: c.name, phone: c.phone || "", owes: (owed.find(r => r.id === c.id) || {}).amount || 0 }));
    },
    reorderGroups: () => reorderGroups(),
    /* Business today, every figure (the tool is for those who see reports and books) */
    businessToday: () => businessTodayView(now(), { profit: true, money: true, position: true }),
    /* the owner's morning briefing (yesterday, and what to do first) */
    briefing: () => briefingView(now()),
    /* a customer's insight, with only the observations this person may see (as on the profile) */
    customerInsight(id){
      const x = customerInsightOf(id, now()), money = can("view_reports") || can("collect_credit");
      return { ...x, insights: x.insights.filter(i => i.kind === "serve" || (money && (i.id !== "standing" || can("view_reports")))) };
    },
  };
}
/* The tool host for the person signed in, on this shop's records */
export const appAgentToolHost = () => createAgentToolHost({ access: { can: p => can(p), hasCap: c => hasCap(c) }, data: appAgentData() });
