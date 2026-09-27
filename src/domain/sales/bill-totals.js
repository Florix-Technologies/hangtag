// Bill totals with discount and GST (settings: { taxOn, taxRate, taxIncl }).

/* Totals for a list of lines ({ q, price }), a discount in rupees, and the shop's GST settings */
export function computeBillTotals(lines,discount,settings){
  const sub=lines.reduce((a,c)=>a+c.q*c.price,0),d=Math.min(Math.max(0,discount||0),sub),base=sub-d;
  let tax=0,total=base;const rate=settings.taxOn?Math.max(0,+settings.taxRate||0):0;
  if(rate){if(settings.taxIncl)tax=Math.round(base*rate/(100+rate));else{tax=Math.round(base*rate/100);total=base+tax}}
  return {sub,disc:d,tax,total,rate,incl:!!settings.taxIncl};
}
