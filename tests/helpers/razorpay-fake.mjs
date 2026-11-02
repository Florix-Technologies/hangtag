// A scripted Razorpay for tests of the payment-gateway and payment-webhook functions (and the app through them): accounts
// by key id, each seeing only its own QR codes, payment links, payments and refunds, as Razorpay keeps merchants apart.
// fetch(url, init) answers the Razorpay API calls the functions make (401 for keys it doesn't know); payQr(id, paise?)
// is the customer paying a QR; calls lists every call with the key id that made it. A refund takes a moment, so two at
// once both reach it. MOCKED: it proves Hangtag's side; Razorpay's own sandbox is a separate, manual step.
export function razorpayFake() {
  const keys = new Map(), qrs = new Map(), links = new Map(), payments = new Map(), refunds = [], calls = [];
  let n = 0;
  const nid = (p) => p + '_T' + String(++n).padStart(9, '0');
  async function fetch(url, init = {}) {
    const u = new URL(url), m = (init.method || 'GET').toUpperCase(), auth = String((init.headers || {}).Authorization || '');
    const [kid, ksec] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
    const body = init.body ? JSON.parse(init.body) : null, p = u.pathname.replace(/^\/v1/, '');
    calls.push({ m, p: p + u.search, kid });
    const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    const mine = (x) => x && x.kid === kid;
    if (!keys.has(kid) || keys.get(kid) !== ksec) return reply(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
    let g;
    if (m === 'POST' && p === '/payments/qr_codes') {
      const q = { id: nid('qr'), kid, entity: 'qr_code', status: 'active', close_by: body.close_by, payment_amount: body.payment_amount, payments_amount_received: 0, image_url: 'https://rzp.test/' + n + '.png', notes: body.notes };
      qrs.set(q.id, q); return reply(200, q);
    }
    if ((g = /^\/payments\/qr_codes\/([^/]+)$/.exec(p)) && m === 'GET') return mine(qrs.get(g[1])) ? reply(200, qrs.get(g[1])) : reply(400, { error: { description: 'The id provided does not exist' } });
    if ((g = /^\/payments\/qr_codes\/([^/]+)\/payments$/.exec(p))) return mine(qrs.get(g[1])) ? reply(200, { items: [...payments.values()].filter((x) => x.qr === g[1]) }) : reply(400, { error: { description: 'The id provided does not exist' } });
    if ((g = /^\/payments\/qr_codes\/([^/]+)\/close$/.exec(p)) && m === 'POST') { const q = qrs.get(g[1]); if (!mine(q)) return reply(400, {}); if (q.status === 'active') { q.status = 'closed'; q.close_reason = 'on_demand'; } return reply(200, q); }
    if (m === 'POST' && p === '/payment_links') { const l = { id: nid('plink'), kid, status: 'created', amount: body.amount, amount_paid: 0, expire_by: body.expire_by, short_url: 'https://rzp.test/l' + n, payments: [] }; links.set(l.id, l); return reply(200, l); }
    if ((g = /^\/payment_links\/([^/]+)$/.exec(p)) && m === 'GET') return mine(links.get(g[1])) ? reply(200, links.get(g[1])) : reply(400, {});
    if ((g = /^\/payment_links\/([^/]+)\/cancel$/.exec(p)) && m === 'POST') { const l = links.get(g[1]); if (!mine(l)) return reply(400, {}); if (l.status === 'created') l.status = 'cancelled'; return reply(200, l); }
    if (m === 'GET' && p === '/payments') return reply(200, { items: [...payments.values()].filter(mine) });
    if ((g = /^\/payments\/([^/]+)\/refund$/.exec(p)) && m === 'POST') {
      const pay = payments.get(g[1]);
      if (!mine(pay)) return reply(400, { error: { description: 'The id provided does not exist' } });
      const done = refunds.filter((r) => r.payment_id === pay.id).reduce((a, r) => a + r.amount, 0);
      if (done + body.amount > pay.amount) return reply(400, { error: { description: 'The total refund amount is greater than the refund payment amount' } });
      await new Promise((r) => setTimeout(r, 15));   // a provider call takes time: two at once both reach here
      const rf = { id: nid('rfnd'), entity: 'refund', payment_id: pay.id, amount: body.amount, status: 'pending', kid, notes: body.notes };
      refunds.push(rf); return reply(200, rf);
    }
    return reply(404, { error: { description: 'no route ' + p } });
  }
  /* the customer pays a QR (paise; default its own amount) */
  const payQr = (qrId, amount) => {
    const q = qrs.get(qrId), pay = { id: nid('pay'), kid: q.kid, qr: qrId, entity: 'payment', amount: amount ?? q.payment_amount, status: 'captured', method: 'upi', fee: 0, acquirer_data: { rrn: String(400000000000 + n) } };
    payments.set(pay.id, pay); q.payments_amount_received += pay.amount; q.status = 'closed'; q.close_reason = 'paid'; return pay;
  };
  return { keys, qrs, links, payments, refunds, calls, fetch, payQr };
}
