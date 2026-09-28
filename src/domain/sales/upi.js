// The shop's own UPI ID (VPA) and the "upi://pay" link a static QR carries, with the amount filled in. Paying to it is
// checked by hand (the payment is "unverified"): only the payment provider can confirm a UPI payment. Pure.

/* name@bank: 2-256 letters, digits, "." "_" "-" before the @, a bank handle after it */
export const validVpa=v=>/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(String(v||"").trim());
export function checkVpa(v){
  const s=String(v==null?"":v).trim();
  if(!s) return null;
  return validVpa(s)?null:{error:"Enter the UPI ID as name@bank, e.g. myshop@okaxis."};
}
/* upi://pay?pa=…&pn=…&am=…&cu=INR&tn=… — or "" without a valid UPI ID or a positive amount */
export function upiPayUri({vpa,name,amount,note}){
  const a=+amount;
  if(!validVpa(vpa)||!(a>0)) return "";
  const q=[["pa",String(vpa).trim()],["pn",String(name||"Shop").slice(0,40)],["am",a.toFixed(2)],["cu","INR"],["tn",String(note||"").slice(0,60)]]
    .filter(([,v])=>v!=="").map(([k,v])=>k+"="+encodeURIComponent(v)).join("&");
  return "upi://pay?"+q;
}
