// Billing and stock settings rules.

/* input: { lowStock, taxOn, taxRate, taxIncl, prefix, paper, footer } as read from the form.
   Returns { error } or { patch } (the settings values to save). */
export function checkBillingSettings(input){
  const low=Math.round(+input.lowStock),rate=+input.taxRate;
  if(isNaN(low)||low<0)return {error:"Low-stock alert must be 0 or more."};
  if(input.taxOn&&(isNaN(rate)||rate<0||rate>40))return {error:"Enter a GST rate between 0 and 40."};
  const prefix=String(input.prefix||"").trim();if(prefix&&!/^[A-Za-z0-9/_-]{1,10}$/.test(prefix))return {error:"Bill number prefix can use letters, numbers, - / _ only."};
  return {patch:{lowStock:low,prefix,taxOn:!!input.taxOn,taxRate:isNaN(rate)?0:Math.round(rate*100)/100,taxIncl:!!input.taxIncl,paper:input.paper==="a4"?"a4":"80mm",footer:String(input.footer||"").trim()}};
}
