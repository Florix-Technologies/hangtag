// Money arithmetic in paise (whole numbers), so sums never drift. Bills store rupees with at most 2 decimals.

/* rupees → paise (nearest paisa) */
export const toPaise=r=>Math.round((+r||0)*100);
/* paise → rupees */
export const toRupees=p=>p/100;
/* rupees rounded to the paisa */
export const round2=r=>toRupees(toPaise(r));
/* q × price in paise, exactly (q up to 3 decimals: 0.335 kg × ₹43 = 1441 paise), rounded half up to the paisa */
export const linePaise=(q,price)=>Math.round(Math.round((+q||0)*1000)*toPaise(price)/1000);
/* a sum of paise */
export const sumP=list=>list.reduce((a,b)=>a+b,0);
/* true when a typed amount has more than 2 decimal places */
export const tooPrecise=v=>Math.abs(v*100-Math.round(v*100))>1e-6;
