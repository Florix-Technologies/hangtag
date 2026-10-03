// Deterministic, read-only answers for common business questions. An optional future provider may handle questions the
// local parser does not understand, but it receives only a read-only query surface and must expose answerReadOnly().
import { inr } from '../../../shared/formatting/money.js';

const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
const lower = value => clean(value).toLowerCase();

function askedPeriod(text){
  if(/\byesterday\b/.test(text)) return 'yesterday';
  if(/\b(this|current) month\b|\bmonthly\b/.test(text)) return 'month';
  if(/\b(last|past) 30 days?\b/.test(text)) return '30d';
  return 'today';
}

export function parseBusinessQuestion(question){
  const text = lower(question), period = askedPeriod(text);
  if(!text) return null;
  if(/\b(reorder|order more|buy more|restock)\b/.test(text)) return { kind: 'inventory', view: 'reorder', period };
  if(/\b(running low|low stock|stock low|almost out)\b/.test(text)) return { kind: 'inventory', view: 'low', period };
  if(/\b(dead stock|haven'?t sold|not sold|unsold|no sales recently)\b/.test(text)) return { kind: 'inventory', view: 'dead', period };
  if(/\b(slow moving|slow-moving|slow stock)\b/.test(text)) return { kind: 'inventory', view: 'slow', period };
  if(/\b(fastest|fast moving|fast-moving|top selling|best selling)\b/.test(text)) return { kind: 'products', metric: 'quantity', period: period === 'today' ? '30d' : period };
  if(/\b(most profit|profitable products?|profit by product)\b/.test(text)) return { kind: 'products', metric: 'profit', period: period === 'today' ? 'month' : period };
  if(/\b(outstanding|customer dues?|owed to me|receivables?)\b/.test(text)) return { kind: 'dues' };
  if(/\bcash\b/.test(text) && /\b(collect|receive|payment|sale|how much)\w*\b/.test(text)) return { kind: 'payment', method: 'cash', period };
  if(/\bupi\b/.test(text) && /\b(receive|collect|payment|sale|how much)\w*\b/.test(text)) return { kind: 'payment', method: 'upi', period };
  if(/\bprofit\b/.test(text)) return { kind: 'profit', period };
  if(/\b(sell|sold|sales|revenue|turnover)\b/.test(text)) return { kind: 'sales', period };
  return null;
}

const unavailable = () => ({
  supported: false,
  title: 'I could not answer that locally',
  text: 'Ask about sales, profit, cash or UPI received, customer dues, fast or slow stock, or what to reorder. An AI provider is not configured.',
  rows: [],
});

function localAnswer(intent, query){
  if(intent.kind === 'sales'){
    const x = query.sales(intent.period);
    return { supported: true, title: `Sales ${x.label}`, text: `${inr(x.total)} from ${x.bills} bill${x.bills === 1 ? '' : 's'}, after ${inr(x.returns)} of returns.`, rows: [] };
  }
  if(intent.kind === 'profit'){
    const x = query.profit(intent.period), coverage = Math.round(x.coverage * 100);
    return { supported: true, title: `Gross profit ${x.label}`, text: `${inr(x.grossProfit)} on the ${coverage}% of net sales with a saved cost.${x.complete ? '' : ' Add missing product costs for a complete figure.'}`, rows: [] };
  }
  if(intent.kind === 'payment'){
    const x = query.payments(intent.period), m = x.methods[intent.method] || { in: 0, refunds: 0, net: 0 };
    return { supported: true, title: `${intent.method === 'upi' ? 'UPI' : 'Cash'} ${x.label}`, text: `${inr(m.in)} received, ${inr(m.refunds)} refunded, ${inr(m.net)} net.`, rows: [] };
  }
  if(intent.kind === 'dues'){
    const x = query.dues();
    return { supported: true, title: 'Outstanding customer dues', text: `${inr(x.total)} across ${x.customers} customer${x.customers === 1 ? '' : 's'}.`, rows: x.rows.map(r => ({ label: r.name, value: inr(r.amount) })) };
  }
  if(intent.kind === 'products'){
    const rows = query.products(intent.period, intent.metric, 5);
    return { supported: true, title: intent.metric === 'profit' ? 'Products by gross profit' : 'Fastest-selling products', text: rows.length ? 'Based on completed bills and returns in the selected period.' : 'There are no completed sales in that period.', rows: rows.map(r => ({ label: r.name, value: intent.metric === 'profit' ? `${inr(r.profit)}${r.complete ? '' : ' (partial cost data)'}` : `${r.quantity} sold` })) };
  }
  if(intent.kind === 'inventory'){
    const rows = query.inventory(intent.view, 8);
    const names = { reorder: 'Suggested reorders', low: 'Stock running low', dead: 'Dead stock', slow: 'Slow-moving stock' };
    return { supported: true, title: names[intent.view] || 'Inventory intelligence', text: rows.length ? 'Deterministic recommendations from current stock and sales history. Nothing is ordered automatically.' : 'No products currently match.', rows: rows.map(r => ({ label: r.productName || r.name || 'Product', value: r.reason || (r.suggestedReorder != null ? `Reorder ${r.suggestedReorder}` : '') })) };
  }
  return unavailable();
}

export function createBusinessAssistant({ query, provider = null }){
  if(!query) throw new Error('Ask Hangtag needs a read-only query service.');
  return Object.freeze({
    async ask(question){
      const intent = parseBusinessQuestion(question);
      if(intent) return Object.freeze({ ...localAnswer(intent, query), intent: Object.freeze(intent), source: 'local' });
      if(provider && typeof provider.available === 'function' && provider.available() && typeof provider.answerReadOnly === 'function'){
        const answer = await provider.answerReadOnly(clean(question), query);
        if(answer && answer.text) return Object.freeze({ supported: true, title: clean(answer.title) || 'Ask Hangtag', text: clean(answer.text), rows: Array.isArray(answer.rows) ? answer.rows : [], source: 'provider' });
      }
      return Object.freeze({ ...unavailable(), source: 'unavailable' });
    },
  });
}
