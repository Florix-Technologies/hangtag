// Billing and stock settings rules.
import { checkVpa } from '../sales/upi.js';

/* input: { lowStock, taxOn, taxRate, taxIncl, prefix, paper, footer } as read from the form.
   Returns { error } or { patch } (the settings values to save). */
export function checkBillingSettings(input){
  const low=Math.round(+input.lowStock),rate=+input.taxRate;
  if(isNaN(low)||low<0)return {error:"Low-stock alert must be 0 or more."};
  if(input.taxOn&&(isNaN(rate)||rate<0||rate>40))return {error:"Enter a GST rate between 0 and 40."};
  const prefix=String(input.prefix||"").trim();if(prefix&&!/^[A-Za-z0-9/_-]{1,10}$/.test(prefix))return {error:"Bill number prefix can use letters, numbers, - / _ only."};
  return {patch:{lowStock:low,prefix,taxOn:!!input.taxOn,taxRate:isNaN(rate)?0:Math.round(rate*100)/100,taxIncl:!!input.taxIncl,paper:input.paper==="a4"?"a4":"80mm",footer:String(input.footer||"").trim()}};
}

/* input: { upiId, payExpiry, whatsapp, sms, email } as read from the form; ready: which channels the server can send
   ({ whatsapp, sms, email } or null when unknown). A channel can't be turned on while the server can't send it. */
export function checkPaymentSettings(input,ready){
  const v=checkVpa(input.upiId); if(v) return {error:v.error};
  const exp=Math.round(+input.payExpiry);
  if(!Number.isFinite(exp)||exp<2||exp>30) return {error:"A QR can stay open from 2 to 30 minutes."};
  const autoSend={};
  for(const c of ["whatsapp","sms","email"]){
    autoSend[c]=!!input[c];
    if(autoSend[c]&&ready&&ready[c]===false) return {error:`${c==="sms"?"SMS":c==="email"?"Email":"WhatsApp"} isn't set up on the server yet, so it can't be turned on.`};
  }
  return {patch:{upiId:String(input.upiId||"").trim(),payExpiry:exp,autoSend}};
}
/* input: { expiryDays, sellExpired } — days of warning before a batch expires (0-365), and whether expired stock may be sold */
export function checkExpirySettings(input){
  const d=+String(input.expiryDays==null?"":input.expiryDays).trim();
  if(String(input.expiryDays==null?"":input.expiryDays).trim()===""||!Number.isInteger(d)||d<0||d>365) return {error:"Warn from 0 to 365 days before expiry (a whole number)."};
  return {patch:{expiryDays:d,sellExpired:!!input.sellExpired}};
}
/* input: { b2clLimit } — the invoice value above which an inter-state B2C invoice is "B2C large" */
export function checkGstSettings(input){
  const n=+input.b2clLimit;
  if(!Number.isFinite(n)||n<0||n>100000000) return {error:"Enter the B2C large limit in rupees."};
  return {patch:{b2clLimit:Math.round(n)}};
}
/* input: { quoteTitle, quotePrefix, quoteFooter, quoteTerms, quoteSignature, quoteGst } — the quotation document's template */
export function checkQuotationSettings(input){
  const one=(v,max)=>String(v==null?"":v).replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max);
  const many=(v,max)=>String(v==null?"":v).replace(/\r\n?/g,"\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g," ").trim();
  const title=one(input.quoteTitle,40)||"QUOTATION", prefix=one(input.quotePrefix,10);
  if(prefix&&!/^[A-Za-z0-9/_-]{1,10}$/.test(prefix)) return {error:"The quotation number prefix can use letters, numbers, - / _ only (up to 10)."};
  if(/\b(tax\s+)?invoice\b/i.test(title)) return {error:"A quotation's title can't say invoice: it isn't a bill."};
  const footer=many(input.quoteFooter), terms=many(input.quoteTerms), sign=many(input.quoteSignature);
  if(footer.length>300) return {error:"The quotation footer can be at most 300 characters."};
  if(terms.length>2000) return {error:"Terms & conditions can be at most 2,000 characters."};
  if(sign.length>200) return {error:"The signature line can be at most 200 characters."};
  return {patch:{quoteTitle:title,quotePrefix:prefix,quoteFooter:footer,quoteTerms:terms,quoteSignature:sign,quoteGst:input.quoteGst!==false&&input.quoteGst!=="false"}};
}
/* The address of the app's own receipt page (https, or http on this computer for testing; …/receipt.html, nothing after
   it) → that address, or "" (invoice links then need RECEIPT_URL on the server) */
export function receiptPageUrl(href){
  try{
    const u=new URL("receipt.html",String(href||""));
    const local=u.hostname==="localhost"||u.hostname==="127.0.0.1";
    return (u.protocol==="https:"||(u.protocol==="http:"&&local))&&!u.username&&!u.password?u.origin+u.pathname:"";
  }catch{ return ""; }
}
