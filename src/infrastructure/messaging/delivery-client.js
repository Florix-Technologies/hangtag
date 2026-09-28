// The "messageDelivery" port: sends a finished bill to its customer through the send-receipt Edge Function, which holds
// the email / WhatsApp / SMS provider keys, writes the message from the saved bill and takes the recipient from the
// bill's customer. Nothing here knows a provider; changing providers is a change to the function's secrets, not to the app.

/* cloud: the cloud gateway (sendReceipt, deliveryChannels, fetchDeliveries) */
export function createDeliveryClient({ cloud }){
  return {
    /* { email, whatsapp, sms }: which channels have a provider on the server; null when that can't be known (offline) */
    channels: () => cloud.deliveryChannels(),
    /* → { status: "sent", to, provider, id } once the provider accepted it; throws an AppError otherwise */
    async send({ channel, saleId }){
      const r = await cloud.sendReceipt({ channel, sale_id: saleId });
      return { status: "sent", to: r.recipient, provider: r.provider, id: r.provider_message_id };
    },
    /* The bill's messages as recorded by the server, newest first */
    history: saleId => cloud.fetchDeliveries(saleId),
  };
}
