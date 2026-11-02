// Amounts in words, as printed on invoices, in the shop's currency and numbering (shared/formatting/regions.js):
// India "Rupees Two Thousand Ninety Eight Only" (thousand, lakh, crore); elsewhere "Dirhams … and … Fils Only" with
// thousand, million, billion.
import { moneyRegion } from '../../shared/formatting/money.js';

const ONES=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen",
  "Sixteen","Seventeen","Eighteen","Nineteen"];
const TENS=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
const two=n=>n<20?ONES[n]:TENS[Math.floor(n/10)]+(n%10?" "+ONES[n%10]:"");
const three=n=>{const h=Math.floor(n/100),r=n%100;return [h?ONES[h]+" Hundred":"",r?two(r):""].filter(Boolean).join(" ")};

/* A whole number in words ("Zero" for 0); compact "international": thousand, million, billion */
export function numberInWords(n,compact="indian"){
  n=Math.floor(Math.abs(+n||0));
  if(!n) return "Zero";
  if(compact==="international"){
    const parts=[[1e9,"Billion"],[1e6,"Million"],[1e3,"Thousand"]], out=[];
    for(const [v,w] of parts){ const k=Math.floor(n/v); if(k){ out.push(three(k)+" "+w); n%=v; } }
    if(n) out.push(three(n));
    return out.join(" ");
  }
  const crore=Math.floor(n/1e7), lakh=Math.floor(n/1e5)%100, thousand=Math.floor(n/1e3)%100, rest=n%1000;
  return [crore?numberInWords(crore)+" Crore":"",lakh?two(lakh)+" Lakh":"",thousand?two(thousand)+" Thousand":"",rest?three(rest):""].filter(Boolean).join(" ");
}
/* An amount in words: 1048.5 → "Rupees One Thousand Forty Eight and Fifty Paise Only" (India) */
export function amountInWords(amount,region=moneyRegion()){
  const W=(region&&region.words)||{major:"Rupees",minor:"Paise"}, compact=(region&&region.compact)||"indian";
  const p=Math.round(Math.abs(+amount||0)*100), r=Math.floor(p/100), ps=p%100;
  return W.major+" "+numberInWords(r,compact)+(ps?" and "+two(ps)+" "+W.minor:"")+" Only";
}
