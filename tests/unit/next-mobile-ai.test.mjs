// Next-generation phone workflows: deterministic assistant/product drafts, optional voice and provider-neutral payments.
import { parseProductDescription, validateAssistedProductDraft } from '../../src/domain/catalog/product-draft-assistant.js';
import { mobileLandingModule, mobileModulesFor, orderMobileActions } from '../../src/domain/shop/mobile-workflow.js';
import { normalizeProviderConfig, normalizeProviderIntent, providerFee, providerPaymentStatus } from '../../src/domain/sales/payment-provider.js';
import { settlePayments } from '../../src/domain/sales/payments.js';
import { createBrowserSpeech } from '../../src/infrastructure/browser/browser-speech.js';
import { createPaymentGatewayClient } from '../../src/infrastructure/payments/payment-gateway-client.js';
import { intentReply, nextIntent, qrView } from '../../supabase/functions/payment-gateway/core.js';
import { createBusinessAssistant, parseBusinessQuestion } from '../../src/features/assistant/services/business-assistant.js';
import { createReadOnlyBusinessQuery, periodRangeFor } from '../../src/features/assistant/services/business-query.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if(ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : '')); };

// A product description becomes a review-only draft, never a saved product.
{
  const result = parseProductDescription('Create Samsung A56, 256GB, ₹42,999, 512GB ₹47,999, GST 18%');
  const d = result.draft;
  check('product description: name, storage variants, prices and GST become a review-required local draft', d && d.name === 'Samsung A56' && d.optionName === 'Storage' && d.gst === 18 && d.reviewRequired && d.source === 'local'
    && JSON.stringify(d.variants.map(v => [v.label, v.price])) === JSON.stringify([['256GB', 42999], ['512GB', 47999]]), result);
  check('product draft validation refuses missing prices and duplicate variants', !!parseProductDescription('Create Samsung A56 GST 18%').error
    && !!validateAssistedProductDraft({ name: 'Phone', variants: [{ label: 'Black', price: 10 }, { label: 'black', price: 12 }] }).error);
  check('the draft data is immutable and contains no persistence action', Object.isFrozen(d) && Object.isFrozen(d.variants) && !Object.keys(d).some(k => /save|create|write|delete/i.test(k)));
}

// Role-specific phone relevance still honours a permission the owner explicitly added.
{
  const modules = [
    { id: 'home', order: 1, perms: ['view_products'] }, { id: 'sell', order: 2, perms: ['create_sale'] },
    { id: 'stock', order: 3, perms: ['view_products', 'manage_inventory'] }, { id: 'report', order: 4, perms: ['view_reports'] },
    { id: 'customers', order: 5, perms: ['create_sale'] }, { id: 'settings', order: 6, perms: [] },
  ];
  const cashier = mobileModulesFor('cashier', modules, ['view_products', 'create_sale']).map(x => x.id);
  const custom = mobileModulesFor('cashier', modules, ['view_products', 'create_sale', 'view_reports']).map(x => x.id);
  const owner = mobileModulesFor('owner', [...modules, { id: 'extension', order: 7, perms: [] }], []).map(x => x.id);
  check('cashier phone hides irrelevant default stock/report modules', JSON.stringify(cashier) === JSON.stringify(['sell', 'customers', 'home', 'settings']), cashier);
  check('a custom report permission surfaces Reports without weakening permission checks', custom.includes('report') && !cashier.includes('report'), custom);
  check('owner phone keeps future modules after the known workflow instead of ranking them first', owner.at(-1) === 'extension', owner);
  check('a role switch moves a phone off a newly hidden current tab', mobileLandingModule('cashier', modules, ['view_products', 'create_sale'], 'stock') === 'sell');
  check('role home actions are ordered and unknown actions are omitted', JSON.stringify(orderMobileActions('server', [{ id: 'orders' }, { id: 'sale' }, { id: 'tables' }]).map(x => x.id)) === JSON.stringify(['tables', 'orders']));
}

// Voice is an optional browser adapter and has a typed-search fallback when absent.
{
  const none = createBrowserSpeech({ scope: {} });
  let unavailable = false; try{ await none.listen(); }catch(error){ unavailable = /not available/i.test(error.message); }
  check('voice fallback: unsupported browsers report unavailable and can keep typed search', !none.available() && unavailable && !none.canSpeak());
  class Recognition {
    start(){ this.onresult({ results: [[{ transcript: 'Samsung 256 black' }]] }); }
    abort(){}
  }
  const voice = createBrowserSpeech({ scope: { SpeechRecognition: Recognition } });
  check('voice adapter returns the device transcript for the existing search input', voice.available() && await voice.listen() === 'Samsung 256 black');
}

// Provider-neutral contract: aliases are normalized and fees exist only when the provider supplies them.
{
  check('provider states normalize paid/success to trusted verified and preserve terminal failures', providerPaymentStatus('success') === 'verified' && providerPaymentStatus('processing') === 'pending' && providerPaymentStatus('expired') === 'expired');
  const cfg = normalizeProviderConfig({ provider: 'future-provider', methods: { upi: { dynamicQr: true }, card: { paymentLink: false } } });
  check('provider capabilities describe dynamic QR without assuming a vendor', cfg.provider === 'future-provider' && cfg.upi && !cfg.cardLink && cfg.methods.upi.dynamicQr);
  const intent = normalizeProviderIntent({ id: 'i1', method: 'upi', status: 'captured', amount: 500, paymentId: 'p1', fee: 4.72 });
  let result = settlePayments(500, [{ method: 'upi', amount: 500, via: 'qr', intent }]);
  check('a provider-supplied fee is recorded on the verified payment', result.ok && result.payments[0].providerFee === 4.72, result);
  result = settlePayments(500, [{ method: 'upi', amount: 500, via: 'qr', intent: { ...intent, providerFee: undefined } }]);
  check('no provider fee is invented when none was supplied', result.ok && !('providerFee' in result.payments[0]) && providerFee(-1) === null, result);
  const calls = [], client = createPaymentGatewayClient({ cloud: { paymentIntent: async body => { calls.push(body); return body.action === 'config' ? { provider: null, upi: false, cardLink: false } : { id: 'i2', method: body.method || 'upi', status: 'pending', amount: body.amount || 100 }; } } });
  await client.createDynamicQr({ amount: 100, saleId: 's1', expiryMin: 5 }); await client.getStatus('i2');
  check('payment provider exposes create dynamic QR and get status operations', calls[0].action === 'create' && calls[0].method === 'upi' && calls[1].action === 'status');
  const view = qrView({ id: 'qr1', status: 'active' }, [{ id: 'p1', status: 'captured', method: 'upi', amount: 50000, fee: 472 }]);
  const patch = nextIntent({ status: 'pending', method: 'upi', amount: 500 }, view);
  const reply = intentReply({ id: 'i1', method: 'upi', kind: 'qr', status: 'verified', amount: 500, reference: 'qr1', provider_fee: '4.72' });
  check('provider fee flows from a trusted provider response in paise to the intent and app view in rupees', patch.provider_fee === 4.72 && reply.providerFee === 4.72, { view, patch, reply });
}

// Ask Hangtag understands common questions locally and the query surface has no mutation methods.
{
  check('assistant intent parser recognises profit, UPI, dues and reorder questions', parseBusinessQuestion('What was my profit yesterday?').kind === 'profit'
    && parseBusinessQuestion('How much UPI did I receive?').kind === 'payment'
    && parseBusinessQuestion('Outstanding customer dues').kind === 'dues'
    && parseBusinessQuestion('What should I reorder?').view === 'reorder'
    && parseBusinessQuestion('Show slow-moving stock').view === 'slow');
  const query = Object.freeze({
    sales: () => ({ label: 'today', total: 1250, bills: 2, returns: 50 }),
    profit: () => ({ label: 'yesterday', grossProfit: 400, coverage: .8, complete: false }),
    payments: () => ({ label: 'today', methods: { upi: { in: 700, refunds: 0, net: 700 } } }),
    products: () => [{ name: 'Cable', quantity: 9, profit: 200, complete: true }],
    dues: () => ({ total: 300, customers: 1, rows: [{ name: 'Riya', amount: 300 }] }),
    inventory: () => [{ productName: 'Cable', reason: 'High velocity + low stock' }],
    describe: () => ['sales', 'profit', 'payments', 'products', 'dues', 'inventory'],
  });
  const assistant = createBusinessAssistant({ query }), answer = await assistant.ask('How much did I sell today?'), unsupported = await assistant.ask('Write a poem');
  check('assistant answers supported questions from deterministic queries', answer.source === 'local' && /₹1,250/.test(answer.text), answer);
  check('no provider: unsupported questions say what can be asked (never an AI error)', unsupported.source === 'unavailable' && /sales/.test(unsupported.text) && /Try/.test(unsupported.text) && unsupported.rows.length > 0, unsupported);
  const hi = await assistant.ask('hi'), morning = await assistant.ask('Good morning'), help = await assistant.ask('what can you do?');
  check('greetings and help are answered locally, never "could not answer"', hi.source === 'local' && /I can help/.test(hi.text) && morning.source === 'local' && help.source === 'local' && help.rows.length >= 5
    && ![hi, morning, help].some((a) => /could not answer/i.test(a.title + a.text)), { hi, help });
  const rev = await assistant.ask('today revenue'), y = await assistant.ask('and yesterday?');
  check('loose phrasing ("today revenue") and a follow-up for another period ("and yesterday?")', rev.intent.kind === 'sales' && y.intent.kind === 'sales' && y.intent.period === 'yesterday', { rev: rev.intent, y: y.intent });
  check('card, all payments, supplier dues, bank balances, expenses, GST, purchase orders, returns, stock value are understood', parseBusinessQuestion('card payments yesterday').method === 'card'
    && parseBusinessQuestion('how did customers pay today').kind === 'payments' && parseBusinessQuestion('what do I owe suppliers').kind === 'supplierDues'
    && parseBusinessQuestion('bank balance').kind === 'banks' && parseBusinessQuestion('expenses this week').period === '7d' && parseBusinessQuestion('gst this month').kind === 'gst'
    && parseBusinessQuestion('purchase orders to receive').kind === 'purchaseOrders' && parseBusinessQuestion('returns today').kind === 'returns' && parseBusinessQuestion('stock value').kind === 'stock');
  const realSurface = createReadOnlyBusinessQuery();
  check('assistant query surface is frozen and read-only by construction', Object.isFrozen(realSurface) && realSurface.describe().every(k => typeof realSurface[k] === 'function')
    && !Object.keys(realSurface).some(k => /save|create|update|delete|checkout|stockin|record/i.test(k)), Object.keys(realSurface));
  check('query periods are deterministic', periodRangeFor('yesterday', new Date(2026, 9, 3).getTime()).from === '2026-10-02' && periodRangeFor('month', new Date(2026, 9, 3).getTime()).from === '2026-10-01');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
