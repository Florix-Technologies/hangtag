// Sending a bill to the customer by email, WhatsApp or SMS: who it can go to, and when it can't be sent. The address
// always comes from the bill's customer (the customer list), never typed in at send time. Pure.
import { isValidInvoice } from './invoice.js';
import { validEmail } from '../../shared/validation/email.js';

export const CHANNELS=["email","whatsapp","sms"];
export const CHANNEL_LABELS={email:"Email",whatsapp:"WhatsApp",sms:"SMS"};

/* An Indian mobile number as +91XXXXXXXXXX (10 digits starting 6-9, with or without +91 / 0), or "" */
export function mobileE164(phone){
  let d=String(phone||"").replace(/\D/g,"");
  if(d.length===12&&d.startsWith("91")) d=d.slice(2); else if(d.length===11&&d.startsWith("0")) d=d.slice(1);
  return /^[6-9]\d{9}$/.test(d)?"+91"+d:"";
}
/* Where a bill would go on a channel: { to } or { error } (a reason written for the shop) */
export function deliveryTarget(inv,channel){
  if(!CHANNELS.includes(channel)) return {error:"Choose email, WhatsApp or SMS."};
  if(!isValidInvoice(inv)) return {error:"A cancelled bill can't be sent."};
  if(!inv.buyer) return {error:"This is a walk-in bill. Add a customer to a bill to send it to them."};
  if(channel==="email"){
    const e=String(inv.buyer.email||"").trim();
    return e&&validEmail(e)?{to:e}:{error:`${inv.buyer.name} has no email address. Add one in Customers to email the bill.`};
  }
  const m=mobileE164(inv.buyer.mobile);
  return m?{to:m}:{error:`${inv.buyer.name} has no mobile number${inv.buyer.mobile?" that can get messages":""} in Customers. Add one there to send by ${CHANNEL_LABELS[channel]}.`};
}
