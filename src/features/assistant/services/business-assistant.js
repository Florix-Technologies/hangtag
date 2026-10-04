// Ask Hangtag: deterministic, read-only answers from the shop's own data — no AI service needed. It understands greetings
// and "help", sales, profit, payments (cash, UPI, card), customer and supplier dues, stock and its value, low / dead / slow
// / fast stock and what to reorder, purchase orders, orders, returns, expenses, GST, bank balances and cash in hand, in
// loose everyday phrasing, for today, yesterday, this week, this month, last month or the last 30 days. A question that
// only names another period ("and yesterday?") asks the previous question again for that period. An optional provider
// (server-side only, never a key in this app) may answer what the local parser doesn't, through answerReadOnly().
import { inr } from '../../../shared/formatting/money.js';

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
  if(has(text, /^(hi+|hello+|hey+|hiya|namaste|namaskar|good (morning|afternoon|evening|day)|morning|evening|yo|hola)\b/) && text.split(' ').length <= 5) return { kind: 'greeting' };
  if(has(text, /^(thanks|thank you|thx|ty|ok thanks|great thanks|cool|nice)\b/)) return { kind: 'thanks' };
  if(has(text, /\bhelp\b|what can you do|what can i ask|how (do|does) (this|it) work|what do you know|commands|^menu$|options/)) return { kind: 'help' };
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
];
const SUGGEST = 'Try “How much did I sell today?”, “What should I reorder?” or “Who owes me money?”.';
const unavailable = () => ({
  supported: false,
  title: "I can't answer that from your shop's data yet",
  text: 'I can help with sales, profit, payments, customer and supplier dues, stock and reordering, orders, expenses, GST and bank balances. ' + SUGGEST,
  rows: HELP_ROWS,
});

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
    return { supported: true, title: 'Customers who owe you', text: x.total ? `${inr(x.total)} across ${plural(x.customers, 'customer')}.` : 'No customer owes the shop anything right now.', rows: x.rows.slice(0, 8).map(r => ({ label: r.name, value: inr(r.amount) })) };
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
    return { supported: true, title: 'Stock on hand', text: `${x.pieces.toLocaleString('en-IN')} pieces across ${plural(x.products, 'product')}, worth ${inr(x.value)} at selling price${x.cost ? ` (${inr(x.cost)} at cost${x.costKnown ? '' : ', some costs missing'})` : ''}.`, rows: [{ label: 'Running low', value: plural(x.low, 'variant') }, { label: 'Sold out', value: plural(x.out, 'variant') }] };
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
    return { supported: true, title: `GST ${x.label}`, text: x.gst ? `${inr(x.gst)} of GST on ${inr(x.taxable)} of net sales.` : `No GST on bills ${x.label}. Switch GST on in Settings → Billing & Documents if your bills should show it.`, rows: x.gst ? [{ label: 'CGST', value: inr(x.cgst) }, { label: 'SGST', value: inr(x.sgst) }, { label: 'IGST', value: inr(x.igst) }] : [] };
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

export function createBusinessAssistant({ query, provider = null }){
  if(!query) throw new Error('Ask Hangtag needs a read-only query service.');
  let previous = null;
  return Object.freeze({
    async ask(question){
      const intent = parseBusinessQuestion(question) || followUpIntent(question, previous);
      if(intent){
        if(!['greeting', 'thanks', 'help'].includes(intent.kind)) previous = intent;
        return Object.freeze({ ...localAnswer(intent, query), intent: Object.freeze(intent), source: 'local' });
      }
      if(provider && typeof provider.available === 'function' && provider.available() && typeof provider.answerReadOnly === 'function'){
        const answer = await provider.answerReadOnly(clean(question), query);
        if(answer && answer.text) return Object.freeze({ supported: true, title: clean(answer.title) || 'Ask Hangtag', text: clean(answer.text), rows: Array.isArray(answer.rows) ? answer.rows : [], source: 'provider' });
      }
      return Object.freeze({ ...unavailable(), source: 'unavailable' });
    },
  });
}
