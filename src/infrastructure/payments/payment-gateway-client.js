// The "paymentGateway" port: verified UPI and card payments through the payment-gateway Edge Function, which holds the
// provider keys (Razorpay) and alone decides that a payment is "verified". Nothing here knows the provider.

const toIntent = r => ({ id:r.id, method:r.method, kind:r.kind, status:r.status, amount:+r.amount, paidAmount:r.paidAmount==null?null:+r.paidAmount,
  reference:r.reference||"", paymentId:r.paymentId||null, qrUrl:r.qrUrl||null, linkUrl:r.linkUrl||null, expiresAt:r.expiresAt||null,
  saleId:r.saleId||null, resolution:r.resolution||null, t:r.createdAt||Date.now() });

/* cloud: the cloud gateway (paymentIntent) */
export function createPaymentGatewayClient({ cloud }){
  return {
    /* { provider, upi, cardLink }: what can be taken through the provider (all false when it isn't set up) */
    async config(){
      const r = await cloud.paymentIntent({ action:"config" });
      return { provider:r.provider||null, upi:!!r.upi, cardLink:!!r.cardLink };
    },
    /* A single-use UPI QR (method "upi") or a card payment link ("card") for exactly `amount` → the intent ("pending") */
    create: ({ method, amount, saleId, note, expiryMin }) => cloud.paymentIntent({ action:"create", method, amount, sale_id:saleId, note, expiry_min:expiryMin }).then(toIntent),
    /* What the provider says now (pending / verified / expired / failed / cancelled / unmatched) */
    status: id => cloud.paymentIntent({ action:"status", id }).then(toIntent),
    /* Closes the QR / link. If the money arrived first, the answer says "verified" instead. */
    cancel: id => cloud.paymentIntent({ action:"cancel", id }).then(toIntent),
    /* Matches a UPI payment checked by hand (its bill must be uploaded) with the provider's payments → { status: "verified"|"not_found", paymentId, intentId } */
    verify: ({ saleId, reference }) => cloud.paymentIntent({ action:"verify", sale_id:saleId, reference }),
    /* Sends a return's refund back onto its bill's verified payment (once; the return must be uploaded) → { refundId } */
    refundReturn: returnId => cloud.paymentIntent({ action:"refund_return", return_id:returnId }).then(r => ({ refundId:r.refundId, already:!!r.already })),
    /* Money the provider received that isn't on any bill */
    unmatched: () => cloud.paymentIntent({ action:"unmatched" }).then(r => (r.items || []).map(toIntent)),
    /* resolution: "refund" (refunds it through the provider), "refunded" (paid back another way) or "allocated" */
    resolve: ({ id, resolution, note }) => cloud.paymentIntent({ action:"resolve", id, resolution, note }).then(toIntent),
  };
}
