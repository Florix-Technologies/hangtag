// SendInvoice: send a finished bill to its customer by email, WhatsApp or SMS through the "messageDelivery" port.
// Only the bill and the channel go to the server: it writes the message from the saved bill and sends it to the
// customer's saved email / mobile. A send counts as sent only when the server says the provider accepted it; every
// other outcome is reported as not sent.
import { deliveryTarget } from '../../../domain/invoices/delivery.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { invoiceFor } from '../../receipts/services/receipt-model.js';
import { messageDelivery } from '../repositories/delivery-service.js';
import { ERROR_CODES, userMessage } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';

/* This session's sends and the server's records for a bill, newest first */
export const deliveriesOf=sid=>store.deliveries[sid]||[];
function note(sid,entry){ store.deliveries[sid]=[entry,...deliveriesOf(sid).filter(e=>e!==entry&&!(e.status==="sending"&&e.channel===entry.channel))]; return entry; }
const online=()=>!!store.sbClient&&store.sbStatus==="connected";

/* Which channels the server can send ({ email, whatsapp, sms }); asked once per session, null while unknown or offline */
export async function loadChannels(){
  if(store.channels||!online()) return store.channels;
  try{ store.channels=await messageDelivery().channels(); }catch(e){ logger.warn("Delivery channels:",e); store.channels=null; }
  return store.channels;
}
/* The server's record of what was sent from this bill (online only) */
export async function loadDeliveryHistory(sid){
  if(!online()) return deliveriesOf(sid);
  try{
    const rows=await messageDelivery().history(sid), mine=deliveriesOf(sid).filter(e=>e.status==="sending");
    store.deliveries[sid]=[...mine,...rows];
  }catch(e){ logger.warn("Delivery history:",e); }
  return deliveriesOf(sid);
}
/* → { ok: true, to } once sent; { error, code, field } otherwise (nothing is claimed as sent) */
export async function sendInvoice(sid,channel){
  const s=D().saleById[sid]; if(!s) return {error:"That bill isn't on this device."};
  const inv=invoiceFor(s), target=deliveryTarget(inv,channel);
  // refused before anything is sent: noted (so the bill shows why) and returned
  const refuse=(error,code,field)=>{note(sid,{channel,status:"refused",error,field,t:Date.now()});return {error,code,field}};
  if(target.error) return refuse(target.error,ERROR_CODES.VALIDATION,"contact");
  if(!online()) return refuse("You're offline. Sending needs the internet: try again when you're back online, or use Download or Share.",ERROR_CODES.NETWORK);
  if(store.sbOfflineQueue.some(q=>q.type==="sale"&&q.sale&&q.sale.id===sid)) return refuse("This bill is still uploading. Try again in a moment.",ERROR_CODES.NETWORK);
  // the server sends to the customer as saved in the cloud: a change to them still uploading must arrive first
  if(s.cust&&s.cust.id&&store.sbOfflineQueue.some(q=>q.type==="cust"&&q.id===s.cust.id)) return refuse("This customer's details are still uploading. Try again in a moment.",ERROR_CODES.NETWORK);
  const entry=note(sid,{channel,to:target.to,status:"sending",t:Date.now()});
  try{
    const r=await messageDelivery().send({channel,saleId:sid});
    Object.assign(entry,{status:"sent",to:r.to||target.to,provider:r.provider,providerId:r.id,t:Date.now()});
    return {ok:true,to:entry.to};
  }catch(e){
    const msg=userMessage(e,"The message wasn't sent. Try again.");
    Object.assign(entry,{status:e&&e.code===ERROR_CODES.NOT_CONFIGURED?"unavailable":"failed",error:msg,t:Date.now()});
    return {error:msg,code:e&&e.code};
  }
}

/* Asks the providers what happened to the bill's messages (email / SMS say "delivered"), then reloads the history */
export async function refreshDeliveryStatus(sid){
  if(!online()) return {error:"You're offline."};
  try{ await messageDelivery().refresh(sid); }catch(e){ logger.warn("Delivery status:",e); return {error:userMessage(e,"Couldn't check with the providers.")}; }
  await loadDeliveryHistory(sid);
  return {ok:true};
}
/* The bill's secure invoice link (unguessable, shows only this bill, 12 months) → { url } or { error } */
export async function invoiceLink(sid){
  if(!online()) return {error:"You're offline. Invoice links need the internet."};
  if(store.sbOfflineQueue.some(q=>q.type==="sale"&&q.sale&&q.sale.id===sid)) return {error:"This bill is still uploading. Try again in a moment."};
  try{ const r=await messageDelivery().link(sid); return r&&r.url?{url:r.url}:{error:"Invoice links aren't set up yet. The shop's owner can open Settings → Receipt once on this app to set the invoice page."}; }
  catch(e){ return {error:userMessage(e,"Couldn't make the link.")}; }
}
/* Stops every invoice link of the bill from working */
export async function revokeInvoiceLinks(sid){
  if(!online()) return {error:"You're offline."};
  try{ await messageDelivery().revokeLinks(sid); return {ok:true}; }
  catch(e){ return {error:userMessage(e,"Couldn't revoke the links.")}; }
}
