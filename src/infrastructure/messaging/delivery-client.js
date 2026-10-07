// The "messageDelivery" port: sends a finished bill to its customer through the send-receipt Edge Function, which holds
// the email / WhatsApp / SMS provider keys, writes the message from the saved bill and takes the recipient from the
// bill's customer. Nothing here knows a provider; changing providers is a change to the function's secrets, not to the app.

/* cloud: the cloud gateway (sendReceipt, deliveryChannels, fetchDeliveries) */
export function createDeliveryClient({ cloud }){
  return {
    /* { email, whatsapp, sms }: which channels have a provider on the server; null when that can't be known (offline) */
    channels: () => cloud.deliveryChannels(),
    /* → { status: "sent", to, provider, id } once the provider accepted it; throws an AppError otherwise */
    async send({ channel, saleId, auto }){
      const r = await cloud.sendReceipt({ channel, sale_id: saleId, ...(auto ? { auto: true } : {}) });
      return { status: r.status === "delivered" ? "delivered" : "sent", to: r.recipient, provider: r.provider, id: r.provider_message_id, again: !!r.already };
    },
    /* Asks the providers whether the bill's messages arrived (email / SMS); the history then shows "delivered" */
    refresh: saleId => cloud.deliveryRefresh(saleId),
    /* The bill's secure invoice link { url, token, expiresAt } */
    link: saleId => cloud.invoiceLink(saleId),
    revokeLinks: saleId => cloud.revokeInvoiceLinks(saleId),
    /* The bill's messages as recorded by the server, newest first */
    history: saleId => cloud.fetchDeliveries(saleId),
    recent: since => cloud.fetchRecentDeliveries(since),
    /* A quotation by email or WhatsApp; requestId (one press of Send) makes a retry get the first answer, never a second
       message → { status, to, provider, id, again } once the provider accepted it; throws an AppError otherwise */
    async sendQuote({ channel, orderId, requestId }){
      const r = await cloud.sendReceipt({ channel, order_id: orderId, request_id: requestId });
      return { status: r.status === "delivered" ? "delivered" : "sent", to: r.recipient, provider: r.provider, id: r.provider_message_id, again: !!r.already };
    },
    /* A quotation's messages as recorded by the server, newest first */
    quoteHistory: orderId => cloud.fetchOrderDeliveries(orderId),
  };
}
