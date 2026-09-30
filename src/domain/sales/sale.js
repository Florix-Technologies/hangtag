// Sale rules: pieces and document numbers. (Payment methods and their names: domain/sales/payments.js.)
import { pad } from '../../shared/formatting/dates.js';
import { isMeasured, sumQty } from '../catalog/units.js';

/* Items on a bill: pieces for counted units; a measured line (2.5 kg, 1.2 m) counts as one item */
export const pcsOf=s=>sumQty(s.items.map(i=>isMeasured(i.u)?1:i.q));
const ymd=t=>{const d=new Date(t);return String(d.getFullYear()).slice(2)+pad(d.getMonth()+1)+pad(d.getDate())};

/* A device's code in its document numbers: 3 characters 0-9 A-Z made from the device id (the same device, the same code) */
export function deviceCode(dev){
  let h=2166136261;
  for(const ch of String(dev||"")){ h^=ch.charCodeAt(0); h=Math.imul(h,16777619)>>>0; }
  return (h%46656).toString(36).toUpperCase().padStart(3,"0");
}
/* e.g. INV-260929-K3F001: prefix, date (yymmdd), this device's code and its running number that day, so two devices never
   make the same number, even offline. Without a device (bills saved before, shown with a number): INV-260929-001 */
export function formatInvoiceNo(prefix,t,seq,dev){return (prefix||"")+ymd(t)+"-"+(dev?deviceCode(dev):"")+String(seq).padStart(3,"0")}
/* A return's credit note number, e.g. CN-260929-K3F001: its own series, dated like a bill */
export const formatCreditNoteNo=(t,seq,dev)=>formatInvoiceNo("CN-",t,seq,dev);
/* The next running number of this device's series on the day of t. docs: the documents of that kind this device knows
   ({ no, t, dev }). It is 1 + the larger of: this device's documents that day, and the highest number already in the series
   (the same date and device code, whoever made it) — so a number is never given twice, even after a reinstall with the same
   code or a document arriving from another device. */
export function nextDocSeq(docs,t,dev){
  const day=ymd(t), re=new RegExp(day+"-"+deviceCode(dev)+"(\\d{3,})$");
  let mine=0, top=0;
  (docs||[]).forEach(d=>{ if(!d) return; const m=re.exec(String(d.no||"")); if(m) top=Math.max(top,+m[1]); if(d.dev===dev&&ymd(d.t)===day) mine++; });
  return Math.max(mine,top)+1;
}
/* The next number for a document made on this device now: bills (the shop's prefix), credit notes ("CN-"), and quotations,
   sales orders and kitchen tickets ("QT-", "SO-", "KOT-") */
export const nextDocNo=(prefix,docs,t,dev)=>formatInvoiceNo(prefix,t,nextDocSeq(docs,t,dev),dev);
/* A device-scoped number split into its series (prefix, date and device code) and running number, or null for other
   numbers: "INV-260929-K3F012" → { series: "INV-260929-K3F", n: 12 } */
export function splitDeviceNo(no){
  const m=/^(.*\d{6}-[0-9A-Z]{3})(\d{3,})$/.exec(String(no||""));
  return m?{series:m[1],n:+m[2]}:null;
}
