// Rupee and number formatting.

export const inr=n=>"₹"+Math.round(n||0).toLocaleString("en-IN");
/* To the paisa when there are paise (₹1,048.95), whole rupees otherwise (₹1,049) — for discounts, GST and round off */
export function inrx(n){const p=Math.round((n||0)*100),v=Math.abs(p)/100;return (p<0?"−":"")+"₹"+v.toLocaleString("en-IN",{minimumFractionDigits:p%100?2:0,maximumFractionDigits:2})}
export const r1=x=>{const v=Math.round(x*10)/10;return v%1===0?v.toFixed(0):v.toFixed(1)};
export function inrShort(n){n=Math.round(n||0);const a=Math.abs(n);if(a>=1e7)return "₹"+r1(n/1e7)+"Cr";if(a>=1e5)return "₹"+r1(n/1e5)+"L";if(a>=1e3)return "₹"+r1(n/1e3)+"k";return "₹"+n}
export const f2=v=>Math.round(v*10)/10;
