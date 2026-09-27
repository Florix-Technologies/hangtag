// Sale rules: pieces, payment method names, invoice numbers.
import { pad } from '../../shared/formatting/dates.js';

export const pcsOf=s=>s.items.reduce((a,i)=>a+i.q,0);
export const PAYN={cash:"Cash",upi:"UPI",card:"Card"};
/* e.g. INV-260925-001: prefix, bill date (yymmdd), running number that day */
export function formatInvoiceNo(prefix,t,seq){const d=new Date(t);return (prefix||"")+String(d.getFullYear()).slice(2)+pad(d.getMonth()+1)+pad(d.getDate())+"-"+String(seq).padStart(3,"0")}
