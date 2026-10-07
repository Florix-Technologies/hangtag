// Ask Hangtag: deterministic, read-only answers from the shop's own data — no AI service needed. It understands greetings
// and "help", sales, profit, payments (cash, UPI, card), customer and supplier dues, stock and its value, low / dead / slow
// / fast stock and what to reorder, purchase orders, orders, returns, expenses, GST, bank balances and cash in hand, in
// loose everyday phrasing, for today, yesterday, this week, this month, last month or the last 30 days. A question that
// only names another period ("and yesterday?") asks the previous question again for that period. It also opens bills,
// products, customers and reports, drafts a reorder or a purchase order, and reads the sales trend, payments to
// reconcile, recent bills and the business profile — through the Agent's tools (tools: the tool host,
// services/agent-tools.js), which check the person's role. Answers carry actions (buttons: open something, or ask a next
// question) and, from a draft tool, a proposal that is saved only when the person confirms it. An optional provider
// (server-side only, never a key in this app) may answer what the local parser doesn't, through answerReadOnly().
import { agentTool } from '../../../domain/agent/agent-tools.js';
import { REF_LABELS } from '../../../domain/reports/business-today.js';
import { dayLab } from '../../../shared/formatting/dates.js';
import { currencyMarkSource, inr, numberText } from '../../../shared/formatting/money.js';

const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
const lower = value => clean(value).toLowerCase().replace(/[’']/g, "'").replace(/[?!.,]+/g, ' ').replace(/\s+/g, ' ').trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

const PERIODS = [
  [/\byesterday\b|\bkal\b/, 'yesterday'],
  [/\blast month\b|\bprevious month\b/, 'lastmonth'],
  [/\b(this|current) month\b|\bmonthly\b|\bthis mon\b|\bmonth so far\b/, 'month'],
  [/\b(this|current) week\b|\blast 7 days?\b|\bpast 7 days?\b|\bweekly\b|\bthis wk\b/, '7d'],
  [/\b(last|past) 30 days?\b|\blast month or so\b/, '30d'],
  [/\btoday\b|\btoday's\b|\baaj\b|\bso far\b/, 'today'],
];
function askedPeriod(text, fallback = 'today'){
  for(const [re, p] of PERIODS) if(re.test(text)) return p;
  return fallback;
}
const has = (text, re) => re.test(text);
/* The question's intent, or null when it isn't one Ask Hangtag knows */
export function parseBusinessQuestion(question){
  const text = lower(question);
  if(!text) return null;
  const period = askedPeriod(text);
  // "good morning" is a greeting; "morning briefing" / "morning summary" asks for something
  if(has(text, /^(hi+|hello+|hey+|hiya|namaste|namaskar|good (morning|afternoon|evening|day)|morning|evening|yo|hola)\b/) && text.split(' ').length <= 5
    && !has(text, /\b(briefing|brief|summary|report|update|sales?|stock|dues?)\b/)) return { kind: 'greeting' };
  if(has(text, /^(thanks|thank you|thx|ty|ok thanks|great thanks|cool|nice)\b/)) return { kind: 'thanks' };
  if(has(text, /\bhelp\b|what can you do|what can i ask|how (do|does) (this|it) work|what do you know|commands|^menu$|options/)) return { kind: 'help' };
  const tool = toolIntent(text); if(tool) return tool;
  if(has(text, /\b(reorder|re-order|order more|buy more|restock|what should i (buy|order)|what to (buy|order)|need to order)\b/)) return { kind: 'inventory', view: 'reorder', period };
  if(has(text, /\b(running low|low stock|stock low|almost (out|finished)|low on|finishing)\b/)) return { kind: 'inventory', view: 'low', period };
  if(has(text, /\b(dead stock|haven'?t sold|not sold|unsold|not selling|no sales recently|never sold)\b/)) return { kind: 'inventory', view: 'dead', period };
  if(has(text, /\b(slow moving|slow-moving|slow stock|slow sellers?|moving slowly)\b/)) return { kind: 'inventory', view: 'slow', period };
  if(has(text, /\b(fastest|fast moving|fast-moving|fast sellers?|top sell(ing|ers)?|best sell(ing|ers)?|selling most|most sold|popular)\b/)) return { kind: 'products', metric: 'quantity', period: period === 'today' && !/\btoday\b/.test(text) ? '30d' : period };
  if(has(text, /\b(most profit|profitable products?|profit by product|which products? (make|made) (the )?most)\b/)) return { kind: 'products', metric: 'profit', period: period === 'today' && !/\btoday\b/.test(text) ? 'month' : period };
  if(has(text, /\b(supplier|vendor|suppliers|vendors)\b/) && has(text, /\b(due|dues|owe|owed|pay|payable|pending|outstanding|balance)\b/)) return { kind: 'supplierDues' };
  if(has(text, /\b(outstanding|customer dues?|dues|owed to me|owe me|receivables?|udhaar|udhar|credit (given|pending)|who owes)\b/)) return { kind: 'dues' };
  if(has(text, /\b(bank|account)s?\b/) && has(text, /\b(balance|balances|how much|money|in the bank|total)\b/)) return { kind: 'banks' };
  if(has(text, /\bcash in (hand|drawer|the drawer|counter)\b|\bdrawer\b|\bcounter cash\b|\bclosing cash\b/)) return { kind: 'cashInHand' };
  if(has(text, /\b(expense|expenses|spent|spend|spending|kharcha)\b/)) return { kind: 'expenses', period };
  if(has(text, /\b(purchase orders?|pos\b|po\b|orders? to (receive|arrive)|supplier orders?)\b/)) return { kind: 'purchaseOrders' };
  if(has(text, /\b(gst|tax|taxes|cgst|sgst|igst)\b/)) return { kind: 'gst', period: period === 'today' && !/\btoday\b/.test(text) ? 'month' : period };
  if(has(text, /\b(returns?|returned|refunds?|refunded|exchanges?)\b/)) return { kind: 'returns', period };
  if(has(text, /\b(quotations?|quotes?|sales orders?|pending orders?|open orders?|orders? (to deliver|pending)|online orders?|store orders?)\b/) || /^orders?\b/.test(text)) return { kind: 'orders' };
  if(has(text, /\b(stock value|inventory value|value of (my )?stock|how much stock|stock worth|inventory worth|total stock|stock summary|how many pieces)\b/)) return { kind: 'stock' };
  if(has(text, /\bcard\b/) && !has(text, /\bgift card\b/)) return { kind: 'payment', method: 'card', period };
  if(has(text, /\bupi\b|\bgpay\b|\bphonepe\b|\bpaytm\b/)) return { kind: 'payment', method: 'upi', period };
  if(has(text, /\bcash\b/)) return { kind: 'payment', method: 'cash', period };
  if(has(text, /\b(payments?|collections?|collected|received|how (did )?(people|customers) pay|payment modes?|methods?)\b/)) return { kind: 'payments', period };
  if(has(text, /\b(profit|margin|earned|earning|earnings|made money|kamai)\b/)) return { kind: 'profit', period };
  if(has(text, /\b(sell|sold|sales|sale|revenue|turnover|takings|business|bikri|did we do|how much did)\b/)) return { kind: 'sales', period };
  if(has(text, /\b(stock|inventory)\b/)) return { kind: 'stock' };
  return null;
}
/* Requests answered by one of the Agent's tools: { kind: 'tool', tool, args, open? (an explicit "open …": shown at once) } */
function toolIntent(text){
  const t = (tool, args = {}, open = false) => ({ kind: 'tool', tool, args, open });
  const after = re => { const m = re.exec(text); return m ? m[m.length - 1].trim() : ''; };
  // the morning briefing: "my briefing", "how was yesterday", "what should I do first"
  if(has(text, /\b(briefing|brief me|morning (summary|report|update)|daily (summary|report)|how was yesterday|summary of yesterday|yesterday's summary|what should i do (first|today)|start (my|the) day)\b/)) return t('get_daily_briefing');
  // a why-question about today's figures: Business today, explained
  const fig = businessFigure(text);
  if(fig) return t('get_business_today', { figure: fig });
  // a bill by its number: "INV-000127", "open bill 127", "show invoice inv-b-000045"
  const billNo = after(/\b(?:open|show|find|view|see)\s+(?:the\s+)?(?:bill|invoice|receipt)\s*(?:no|number|#)?\s*([a-z0-9#-]*\d[a-z0-9-]*)\b/) || after(/\b((?!(?:po|pq|so|dc|cn)-)[a-z]{2,5}-(?:[a-z]-)?\d{2,})\b/);
  if(billNo) return t('open_bill', { bill_no: billNo.replace(/^#/, '') }, true);
  if(has(text, /\b(recent|latest|last few|last \d+|today's)\s+(bills?|invoices?)\b|\bbills? (made )?today\b|^bills?$/)) return t('get_recent_bills', { limit: 5 });
  // what a customer's bills say: "tell me about Riya", "how is Riya doing", "what does Riya buy", "Riya's history"
  const about = after(/^tell me about\s+(?:the\s+)?(?:customer\s+)?(.+)$/) || after(/^how(?: is|'s)\s+(.+?)\s+doing$/) || after(/^what does\s+(.+?)\s+(?:usually\s+)?buy$/)
    || after(/^(.+?)'s\s+(?:history|insights?|profile|purchases|buying)$/);
  if(about && !askedPeriod(about, '') && !/^(today|business|sales|stock|profit|gst|cash|upi|card|payments?|dues?|orders?|returns?|expenses?|banks?|inventory|reorder|it|things|(my|the|this) (shop|business|store))$/.test(about))
    return t('get_customer_insight', { name: about });
  const cust = after(/\b(?:open|show|find)\s+(?:the\s+)?customer\s+(.+)$/) || after(/^(?:open|show)\s+(.+?)(?:'s)?\s+(?:account|khata|ledger)$/) || after(/^(.+?)'s\s+(?:account|khata|ledger)$/);
  if(cust) return t('open_customer', { name: cust }, true);
  const prod = after(/\b(?:open|show|find)\s+(?:the\s+)?(?:product|item)\s+(.+)$/);
  if(prod) return t('open_product', { name: prod }, true);
  if(has(text, /\b(?:open|show|go to)\s+(?:the\s+|my\s+)?reports?\b/)) return t('open_report', { period: askedPeriod(text) }, true);
  if(has(text, /\b(draft|make|create|prepare|raise|new)\b.{0,24}\b(purchase orders?|po)\b/)){
    const sup = after(/\b(?:for|from|to)\s+([a-z0-9][a-z0-9 &.'-]{1,60})$/);
    return t('draft_purchase_order', sup ? { supplier: sup } : {});
  }
  // "what should I buy with ₹20,000?", "reorder within 15k": a purchase plan within that budget
  const cur = currencyMarkSource();
  const money = new RegExp("(?:" + cur + "|\\bbudget\\b|\\bwith\\b|\\bwithin\\b|\\bspend\\b|\\bfor\\b)\\s*(?:of\\s*)?(?:" + cur + "\\s*)?(\\d{1,3}(?: \\d{3})+|\\d{3,}|\\d+(?:\\.\\d+)?\\s*k)\\b", "i").exec(text);
  if(money && has(text, /\b(buy|reorder|re-order|purchase|order|restock|stock up|spend)\b/)){
    const m = money[1].replace(/\s+/g, ''), budget = /k$/.test(m) ? Math.round(parseFloat(m) * 1000) : +m;
    if(budget > 0) return t('draft_reorder', { budget });
  }
  if(has(text, /\b(draft|make|prepare|create)\b.{0,20}\b(reorder|re-order|restock)\b|\breorder list\b|\bwhat (should|do) i order from (each|which) supplier\b/)) return t('draft_reorder');
  if(has(text, /\b(trend|day by day|daily sales|sales by day|each day|per day|day-?wise)\b/)) return t('get_sales_trend', { days: /\b30\b|month/.test(text) ? 30 : /\b14\b|fortnight|two weeks/.test(text) ? 14 : 7 });
  if(has(text, /\b(reconcil\w*|unverified|to verify|not verified|unmatched)\b/)) return t('get_payment_reconciliation', { days: 30 });
  if(has(text, /\b(business profile|shop (details|profile|info)|(my|the) (shop|business)('s)? (details|info|profile)|about (my|the) (shop|business)|gstin)\b/)) return t('get_business_profile');
  return null;
}
/* "Why are sales down?", "why is cash short", "what's unusual today", "explain today's margin": which of Business today's
   figures the question is about (all: whatever is out of the ordinary), or null when it isn't such a question */
function businessFigure(text){
  const asks = has(text, /\b(why|explain\w*|reasons?)\b/), today = has(text, /\b(unusual|out of the ordinary|business today|how (is|was) (the )?business|what'?s (wrong|different|going on))\b/);
  if(!asks && !today) return null;
  const fig = has(text, /\b(reconcil\w*|mismatch\w*|unmatched|drawer|day close|closing)\b|\bcash\b.*\b(short|over|missing|less|more)\b|\b(short|missing)\b.*\bcash\b/) ? 'reconciliation'
    : has(text, /\b(margin|profit|profits)\b/) ? 'margin'
    : has(text, /\b(average|avg|basket|bill size|bill value)\b/) ? 'average_bill'
    : has(text, /\b(upi|card|cash|payments?|payment mix)\b/) ? 'payments'
    : has(text, /\b(owe|owed|owes|dues?|receivables?|outstanding|udhaa?r|credit)\b/) ? 'receivables'
    : has(text, /\b(stock|inventory)\b/) ? 'stock'
    : has(text, /\b(sales?|sold|sell\w*|revenue|turnover|takings|bikri|bills?|slow|busy)\b/) ? 'sales' : null;
  if(fig) return fig;
  return today || has(text, /\btoday\b/) ? 'all' : null;
}
/* "and yesterday?", "what about this month" — only a period: the previous question again for that period */
export function followUpIntent(question, previous){
  const text = lower(question);
  if(!previous || !text || text.split(' ').length > 6) return null;
  const rest = text.replace(/\b(and|what|about|how|for|the|then|same|also|ok|so)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const p = askedPeriod(rest, '');
  if(!p || !PERIODS.some(([re]) => re.test(rest) && rest.replace(re, '').trim() === '')) return null;
  return 'period' in previous || ['sales', 'profit', 'payment', 'payments', 'returns', 'expenses', 'gst', 'products'].includes(previous.kind) ? Object.assign({}, previous, { period: p }) : null;
}

const HELP_ROWS = [
  { label: 'Sales and profit', value: '“How much did I sell today?” · “Profit this month”' },
  { label: 'Payments', value: '“UPI today” · “Card payments yesterday” · “Cash in hand”' },
  { label: 'Dues', value: '“Who owes me money?” · “What do I owe suppliers?”' },
  { label: 'Stock', value: '“What should I reorder?” · “Low stock” · “Dead stock” · “Stock value”' },
  { label: 'Orders and purchases', value: '“Open orders” · “Purchase orders to receive”' },
  { label: 'Money', value: '“Expenses this week” · “GST this month” · “Bank balances”' },
  { label: 'Why', value: '“Why are sales down today?” · “Why is cash short?” · “What\'s unusual today?”' },
  { label: 'Customers', value: '“Tell me about Riya” · “What does Riya buy?”' },
  { label: 'Briefing', value: '“My morning briefing” · “How was yesterday?” · “What should I do first?”' },
  { label: 'Open and draft', value: '“Open bill 127” · “Open customer Riya” · “Recent bills” · “Draft a purchase order”' },
];
const SUGGEST = 'Try “How much did I sell today?”, “What should I reorder?” or “Who owes me money?”.';
const unavailable = () => ({
  supported: false,
  title: "I can't answer that from your shop's data yet",
  text: 'I can help with sales, profit, payments, customer and supplier dues, stock and reordering, orders, expenses, GST and bank balances. ' + SUGGEST,
  rows: HELP_ROWS,
});

/* Buttons for an answer: open something (the tool host says whether this person may), or ask a next question */
const openAct = (target, id, label) => ({ kind: 'open', target, id, label });
const askAct = (question, label) => ({ kind: 'ask', question, label: label || question });
const may = (host, tool) => !!host && host.allowed(tool);
function actionsFor(intent, host, answer){
  const k = intent.kind, acts = [];
  if(['sales', 'profit', 'payment', 'payments', 'gst', 'returns'].includes(k) && may(host, 'open_report')) acts.push(openAct('report', intent.period || 'today', 'Open Reports'));
  if(k === 'dues' && may(host, 'open_customer')) (answer.dueRows || []).slice(0, 3).forEach(r => acts.push(openAct('customer', r.id, `Open ${r.name}`)));
  if(k === 'inventory' && (intent.view === 'reorder' || intent.view === 'low')){
    if(may(host, 'draft_reorder')) acts.push(openAct('reorder', 'smart', 'Open Smart reorder'));
    if(may(host, 'draft_purchase_order') && answer.rows.length) acts.push(askAct('Draft a purchase order'));
  }
  return acts;
}
const STATE_WORDS = { paid: 'paid', unpaid: 'unpaid', cancelled: 'cancelled' };
function toolAnswer(intent, host){
  const def = agentTool(intent.tool), title = def ? def.title : 'Hangtag Agent';
  if(!host) return unavailable();
  const r = host.callTool(intent.tool, intent.args), x = r.structuredContent || {}, text = (r.content[0] || {}).text || '';
  const out = { supported: true, title, text, rows: [], actions: [], proposal: null, toolsUsed: [intent.tool], refused: x.refused || [] };
  if(r.isError) return out;
  const tool = intent.tool;
  if(tool === 'get_recent_bills'){
    out.rows = x.bills.map(b => ({ label: `${b.no} · ${b.customer}`, value: b.state === 'unpaid' ? `${inr(b.total)} · ${inr(b.owed)} owed` : `${inr(b.total)} · ${STATE_WORDS[b.state] || b.state}` }));
    if(may(host, 'open_bill')) out.actions = x.bills.slice(0, 3).map(b => openAct('bill', b.id, `Open ${b.no}`));
  }else if(tool === 'get_sales_trend'){
    out.rows = x.days.slice(-14).map(d => ({ label: dayLab(d.date), value: `${inr(d.sales)} · ${plural(d.bills, 'bill')}` }));
    if(may(host, 'open_report')) out.actions = [openAct('report', intent.args.days >= 30 ? '30d' : '7d', 'Open Reports')];
  }else if(tool === 'get_payment_reconciliation'){
    out.rows = x.unverified.bills.map(b => ({ label: b.no, value: `${inr(b.amount)} UPI, checked by hand` }));
    if(may(host, 'open_report')) out.actions = [openAct('reconcile', '30d', 'Open Reconciliation')];
  }else if(tool === 'get_business_today'){
    const figs = x.figures || [];
    out.title = figs.length === 1 ? figs[0].label + (figs[0].unusual ? ': why it is out of the ordinary' : ': how today looks') : 'Business today';
    if(figs.length) out.text = intent.args.figure === 'all' && x.unusual && x.unusual.length ? x.summary || text : figs.map(f => f.headline).join(' ');
    out.rows = figs.flatMap(f => [...f.reasons.map(r => ({ label: figs.length > 1 ? f.label : 'Why', value: r.text })), ...(f.check ? [{ label: 'Worth checking', value: f.check }] : [])]);
    const tools = { bill: 'open_bill', customer: 'open_customer', product: 'open_product', report: 'open_report', reconcile: 'open_report', cashbook: 'open_report', bankbook: 'open_report', reorder: 'draft_reorder' }, seen = new Set();
    figs.flatMap(f => f.reasons).map(r => r.ref).filter(Boolean).forEach(ref => { const k = ref.target + '|' + (ref.id || ''); if(seen.has(k) || out.actions.length >= 3) return; seen.add(k);
      if(!tools[ref.target] || may(host, tools[ref.target])) out.actions.push(openAct(ref.target, ref.id || '', REF_LABELS[ref.target] || 'Open')); });
  }else if(tool === 'get_daily_briefing' && x.first){
    out.title = 'Morning briefing';
    out.text = (x.quiet ? 'All clear: ' : 'First: ') + x.first.text;
    out.rows = (x.sections || []).flatMap(s => s.lines.map(l => ({ label: s.title, value: l.text })));
    const tools = { bill: 'open_bill', customer: 'open_customer', product: 'open_product', report: 'open_report', reconcile: 'open_report', cashbook: 'open_report', bankbook: 'open_report', reorder: 'draft_reorder' }, seen = new Set();
    [x.first.ref, ...(x.sections || []).flatMap(s => s.lines.map(l => l.ref))].filter(Boolean).forEach(ref => { const k = ref.target + '|' + (ref.id || ''); if(seen.has(k) || out.actions.length >= 3) return; seen.add(k);
      if(!tools[ref.target] || may(host, tools[ref.target])) out.actions.push(openAct(ref.target, ref.id || '', REF_LABELS[ref.target] || 'Open')); });
  }else if(tool === 'get_customer_insight' && x.customer){
    out.title = x.customer.name;
    if(x.summary && x.summary.bills){
      out.text = (r.content[0] || {}).text.split('. ').slice(0, 2).join('. ').replace(/\.?$/, '.');
      out.rows = [...(x.topProducts || []).slice(0, 3).map(p => ({ label: 'Buys', value: `${p.name} · ${p.qty} on ${plural(p.bills, 'bill')}` })), ...(x.insights || []).map(s => ({ label: 'Noticed', value: s }))];
    }
    if(x.action && may(host, 'open_customer')) out.actions.push(x.action);
  }else if(tool === 'get_business_profile'){
    out.rows = [{ label: 'Business', value: x.type }, ...(x.city || x.state ? [{ label: 'Place', value: [x.city, x.state].filter(Boolean).join(', ') }] : []), { label: 'GSTIN', value: x.gstin || 'Not registered' }, ...(x.features.length ? [{ label: 'Uses', value: x.features.join(', ') }] : [])];
  }else if(tool === 'draft_reorder' && x.lines){
    out.rows = x.lines.map(l => ({ label: `${l.product}${l.variant ? ' ' + l.variant : ''}`, value: `${l.qty}${l.qty !== l.wanted ? ` of ${l.wanted}` : ''} · ${inr(l.cost)} · ${l.supplier || 'supplier not known yet'}` }));
    if(x.action) out.actions.push(x.action);
    if(may(host, 'draft_purchase_order') && x.lines.some(l => l.supplier)) out.actions.push(askAct('Draft a purchase order'));
  }else if(tool === 'draft_reorder'){
    out.rows = x.groups.flatMap(g => g.items.map(l => ({ label: `${l.product}${l.variant ? ' ' + l.variant : ''}`, value: `${l.qty} · ${g.supplier || 'supplier not known yet'}` })));
    if(x.action) out.actions.push(x.action);
    if(may(host, 'draft_purchase_order')) x.groups.filter(g => g.supplier).slice(0, 3).forEach(g => out.actions.push(askAct(`Draft a purchase order for ${g.supplier}`)));
  }else if(tool === 'draft_purchase_order'){
    if(x.proposal) out.proposal = x.proposal;
    if(x.action) out.actions.push(x.action);
  }else if(x.action) out.actions.push(x.action);
  out.autoOpen = !!(intent.open && x.action);
  return out;
}

function localAnswer(intent, query){
  const k = intent.kind;
  if(k === 'greeting') return { supported: true, title: 'Hi 👋', text: 'I can help with sales, profit, stock, payments, customer dues and reordering. ' + SUGGEST, rows: [] };
  if(k === 'thanks') return { supported: true, title: "You're welcome", text: 'Ask me anything else about the shop: ' + SUGGEST, rows: [] };
  if(k === 'help') return { supported: true, title: 'What you can ask', text: 'Answers come from this shop’s own bills, stock and books on this device. Nothing is changed, and no AI service is used.', rows: HELP_ROWS };
  if(k === 'sales'){
    const x = query.sales(intent.period);
    return { supported: true, title: `Sales ${x.label}`, text: `${inr(x.total)} from ${plural(x.bills || 0, 'bill')}${x.returns ? `, after ${inr(x.returns)} of returns` : ''}.${x.bills ? ` Average bill ${inr(x.avgBill || (x.total / x.bills))}.` : ''}`, rows: [] };
  }
  if(k === 'profit'){
    const x = query.profit(intent.period), coverage = Math.round(x.coverage * 100);
    return { supported: true, title: `Gross profit ${x.label}`, text: `${inr(x.grossProfit)}${coverage < 100 ? ` on the ${coverage}% of net sales with a saved cost` : ''}.${x.complete ? '' : ' Add the missing product costs for a complete figure.'}`, rows: [] };
  }
  if(k === 'payment' || k === 'payments'){
    const x = query.payments(intent.period), name = { cash: 'Cash', upi: 'UPI', card: 'Card' };
    if(k === 'payment'){
      const m = x.methods[intent.method] || { in: 0, refunds: 0, net: 0 };
      return { supported: true, title: `${name[intent.method]} ${x.label}`, text: `${inr(m.in)} received${m.refunds ? `, ${inr(m.refunds)} refunded, ${inr(m.net == null ? m.in - m.refunds : m.net)} net` : ''}.`, rows: [] };
    }
    const rows = ['cash', 'upi', 'card'].map(m => ({ label: name[m], value: inr((x.methods[m] || {}).in || 0) }));
    return { supported: true, title: `Payments ${x.label}`, text: 'Money received by each method (before refunds).', rows };
  }
  if(k === 'dues'){
    const x = query.dues();
    return { supported: true, title: 'Customers who owe you', text: x.total ? `${inr(x.total)} across ${plural(x.customers, 'customer')}.` : 'No customer owes the shop anything right now.', rows: x.rows.slice(0, 8).map(r => ({ label: r.name, value: inr(r.amount) })), dueRows: x.rows.slice(0, 3) };
  }
  if(k === 'supplierDues'){
    const x = query.supplierDues();
    return { supported: true, title: 'What you owe suppliers', text: x.total ? `${inr(x.total)} to ${plural(x.suppliers, 'supplier')}, on purchases not fully paid.` : 'Every supplier bill is paid.', rows: x.rows.slice(0, 8).map(r => ({ label: r.name, value: inr(r.amount) })) };
  }
  if(k === 'products'){
    const rows = query.products(intent.period, intent.metric, 5);
    return { supported: true, title: intent.metric === 'profit' ? 'Products by gross profit' : 'Fastest-selling products', text: rows.length ? `From completed bills and returns, ${periodLabel(intent.period)}.` : 'There are no completed sales in that period.', rows: rows.map(r => ({ label: r.name, value: intent.metric === 'profit' ? `${inr(r.profit)}${r.complete ? '' : ' (some costs missing)'}` : `${r.quantity} sold` })) };
  }
  if(k === 'inventory'){
    const rows = query.inventory(intent.view, 8);
    const names = { reorder: 'Suggested reorders', low: 'Stock running low', dead: 'Dead stock', slow: 'Slow-moving stock' };
    return { supported: true, title: names[intent.view] || 'Inventory', text: rows.length ? 'From current stock and sales history. Nothing is ordered automatically.' : intent.view === 'reorder' || intent.view === 'low' ? 'Nothing needs reordering right now.' : 'No products match.', rows: rows.map(r => ({ label: r.productName || r.name || 'Product', value: r.reason || (r.suggestedQty != null ? `order ${r.suggestedQty}` : r.stock != null ? `${r.stock} left` : '') })) };
  }
  if(k === 'stock'){
    const x = query.stock();
    return { supported: true, title: 'Stock on hand', text: `${numberText(x.pieces)} pieces across ${plural(x.products, 'product')}, worth ${inr(x.value)} at selling price${x.cost ? ` (${inr(x.cost)} at cost${x.costKnown ? '' : ', some costs missing'})` : ''}.`, rows: [{ label: 'Running low', value: plural(x.low, 'variant') }, { label: 'Sold out', value: plural(x.out, 'variant') }] };
  }
  if(k === 'purchaseOrders'){
    const x = query.purchaseOrders();
    return { supported: true, title: 'Purchase orders', text: x.open ? `${plural(x.open, 'purchase order')} still to be received, worth about ${inr(x.value)}.` : 'No purchase order is waiting to be received.', rows: x.open ? [{ label: 'Sent to suppliers', value: String(x.sent) }, { label: 'Drafts', value: String(x.drafts) }] : [] };
  }
  if(k === 'orders'){
    const x = query.orders();
    return { supported: true, title: 'Open orders', text: x.quotes || x.sales ? `${plural(x.sales, 'sales order')} to deliver or bill (${inr(x.salesValue)}) and ${plural(x.quotes, 'quotation')} waiting for an answer (${inr(x.quoteValue)}).` : 'No open quotations or sales orders.', rows: x.mobile ? [{ label: 'From the mobile store', value: String(x.mobile) }] : [] };
  }
  if(k === 'returns'){
    const x = query.returns(intent.period);
    return { supported: true, title: `Returns ${x.label}`, text: x.count ? `${plural(x.count, 'return')} worth ${inr(x.value)}.` : `No returns ${x.label}.`, rows: [] };
  }
  if(k === 'expenses'){
    const x = query.expenses(intent.period);
    return { supported: true, title: `Expenses ${x.label}`, text: x.total ? `${inr(x.total)} spent from the cash drawer.` : `No expenses recorded ${x.label}.`, rows: x.rows.map(r => ({ label: r.name, value: inr(r.amount) })) };
  }
  if(k === 'gst'){
    const x = query.gst(intent.period);
    return { supported: true, title: `GST ${x.label}`, text: x.gst ? `${inr(x.gst)} of GST on ${inr(x.taxable)} of net sales.` : `No GST on bills ${x.label}. Switch GST on in Settings → Bills & Documents if your bills should show it.`, rows: x.gst ? [{ label: 'CGST', value: inr(x.cgst) }, { label: 'SGST', value: inr(x.sgst) }, { label: 'IGST', value: inr(x.igst) }] : [] };
  }
  if(k === 'banks'){
    const x = query.banks();
    return { supported: true, title: 'Bank balances', text: x.rows.length ? `${inr(x.total)} across ${plural(x.rows.length, 'account')}, with UPI and card money counted in the account it lands in.` : 'No bank accounts yet: add them in Settings → Payments & Banks.', rows: x.rows.map(r => ({ label: r.name, value: inr(r.amount) })) };
  }
  if(k === 'cashInHand'){
    const x = query.cashInHand();
    return { supported: true, title: 'Cash in hand', text: `The drawer should hold ${inr(x.closing)} now.`, rows: [{ label: 'Opening', value: inr(x.opening) }, { label: 'In today', value: inr(x.in) }, { label: 'Out today', value: inr(x.out) }] };
  }
  return unavailable();
}
const periodLabel = p => ({ today: 'today', yesterday: 'yesterday', '7d': 'in the last 7 days', month: 'this month', lastmonth: 'last month', '30d': 'in the last 30 days' })[p] || 'recently';

/* tools: the tool host, or a function that gives it (fresh for each question) */
export function createBusinessAssistant({ query, provider = null, tools = null }){
  if(!query) throw new Error('Ask Hangtag needs a read-only query service.');
  const hostOf = () => typeof tools === 'function' ? tools() : tools;
  let previous = null;
  return Object.freeze({
    async ask(question){
      const intent = parseBusinessQuestion(question) || followUpIntent(question, previous);
      if(intent){
        if(!['greeting', 'thanks', 'help', 'tool'].includes(intent.kind)) previous = intent;
        const host = hostOf();
        if(intent.kind === 'tool') return Object.freeze({ ...toolAnswer(intent, host), intent: Object.freeze(intent), source: 'local' });
        const { dueRows, ...answer } = localAnswer(intent, query);
        return Object.freeze({ ...answer, actions: actionsFor(intent, host, { ...answer, dueRows }), intent: Object.freeze(intent), source: 'local' });
      }
      if(provider && typeof provider.available === 'function' && provider.available() && typeof provider.answerReadOnly === 'function'){
        const answer = await provider.answerReadOnly(clean(question), query);
        if(answer && answer.text) return Object.freeze({ supported: true, title: clean(answer.title) || 'Hangtag Agent', text: clean(answer.text), rows: Array.isArray(answer.rows) ? answer.rows : [],
          actions: Array.isArray(answer.actions) ? answer.actions : [], proposal: answer.proposal || null, toolsUsed: Array.isArray(answer.toolsUsed) ? answer.toolsUsed : [],
          refused: Array.isArray(answer.refused) ? answer.refused : [], source: 'provider' });
      }
      return Object.freeze({ ...unavailable(), source: 'unavailable' });
    },
  });
}
