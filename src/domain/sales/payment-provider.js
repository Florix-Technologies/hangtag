// Provider-neutral payment contract helpers. The app's trusted terminal state remains "verified": provider words such
// as paid/success/captured are normalized before a payment can settle a bill.
export const PROVIDER_PAYMENT_STATES = Object.freeze(['pending', 'verified', 'failed', 'expired', 'cancelled', 'unmatched']);

export function providerPaymentStatus(value){
  const status = String(value || '').toLowerCase();
  if(['paid', 'success', 'succeeded', 'captured', 'complete', 'completed', 'verified'].includes(status)) return 'verified';
  if(['created', 'processing', 'authorised', 'authorized', 'pending'].includes(status)) return 'pending';
  if(['cancelled', 'canceled'].includes(status)) return 'cancelled';
  if(status === 'expired') return 'expired';
  if(status === 'unmatched') return 'unmatched';
  return 'failed';
}

export function providerFee(value){
  if(value == null || value === '') return null;
  const fee = +value;
  return Number.isFinite(fee) && fee >= 0 ? Math.round(fee * 100) / 100 : null;
}

export function normalizeProviderConfig(config){
  const c = config || {}, upi = !!(c.upi || c.dynamicQr || c.methods && c.methods.upi && c.methods.upi.dynamicQr),
    cardLink = !!(c.cardLink || c.methods && c.methods.card && c.methods.card.paymentLink);
  const g = c.gateway && typeof c.gateway === 'object' ? c.gateway : {}, num = (v) => (Number.isFinite(+v) && +v > 0 ? +v : null);
  // the gateway's set-up as the server says it: never a secret (the key id masked, the webhook address only for who manages settings)
  const gateway = Object.freeze({ available: !!g.available, connected: !!g.connected, ...(g.connected ? { provider: g.provider || 'razorpay', mode: g.mode === 'live' ? 'live' : 'test',
    keyId: String(g.keyId || ''), checkedAt: num(g.checkedAt), lastEventAt: num(g.lastEventAt), ...(g.webhookUrl ? { webhookUrl: String(g.webhookUrl), events: Array.isArray(g.events) ? g.events.map(String) : [] } : {}) } : {}) });
  return Object.freeze({ provider: c.provider || null, upi, cardLink, gateway, methods: Object.freeze({
    upi: Object.freeze({ createPayment: upi, dynamicQr: upi }),
    card: Object.freeze({ createPayment: cardLink, paymentLink: cardLink }),
  }) });
}

export function normalizeProviderIntent(value){
  const r = value || {}, fee = providerFee(r.providerFee == null ? (r.fee == null ? r.mdr : r.fee) : r.providerFee);
  return {
    id: r.id, method: r.method, kind: r.kind, status: providerPaymentStatus(r.status), amount: +r.amount,
    paidAmount: r.paidAmount == null ? null : +r.paidAmount, reference: r.reference || '', paymentId: r.paymentId || null,
    qrUrl: r.qrUrl || null, linkUrl: r.linkUrl || null, expiresAt: r.expiresAt || null, saleId: r.saleId || null,
    resolution: r.resolution || null, ...(fee == null ? {} : { providerFee: fee }), t: r.t || r.createdAt || Date.now(),
  };
}
