// Amounts in words, Indian style (thousand, lakh, crore), as printed on invoices: "Rupees Two Thousand Ninety Eight Only".

const ONES=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen",
  "Sixteen","Seventeen","Eighteen","Nineteen"];
const TENS=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
const two=n=>n<20?ONES[n]:TENS[Math.floor(n/10)]+(n%10?" "+ONES[n%10]:"");
const three=n=>{const h=Math.floor(n/100),r=n%100;return [h?ONES[h]+" Hundred":"",r?two(r):""].filter(Boolean).join(" ")};

/* A whole number in words ("Zero" for 0) */
export function numberInWords(n){
  n=Math.floor(Math.abs(+n||0));
  if(!n) return "Zero";
  const crore=Math.floor(n/1e7), lakh=Math.floor(n/1e5)%100, thousand=Math.floor(n/1e3)%100, rest=n%1000;
  return [crore?numberInWords(crore)+" Crore":"",lakh?two(lakh)+" Lakh":"",thousand?two(thousand)+" Thousand":"",rest?three(rest):""].filter(Boolean).join(" ");
}
/* Rupees and paise in words: 1048.5 → "Rupees One Thousand Forty Eight and Fifty Paise Only" */
export function amountInWords(rupees){
  const p=Math.round(Math.abs(+rupees||0)*100), r=Math.floor(p/100), ps=p%100;
  return "Rupees "+numberInWords(r)+(ps?" and "+two(ps)+" Paise":"")+" Only";
}
