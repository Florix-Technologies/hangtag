// Rupee and number formatting.

export const inr=n=>"₹"+Math.round(n||0).toLocaleString("en-IN");
export const r1=x=>{const v=Math.round(x*10)/10;return v%1===0?v.toFixed(0):v.toFixed(1)};
export function inrShort(n){n=Math.round(n||0);const a=Math.abs(n);if(a>=1e7)return "₹"+r1(n/1e7)+"Cr";if(a>=1e5)return "₹"+r1(n/1e5)+"L";if(a>=1e3)return "₹"+r1(n/1e3)+"k";return "₹"+n}
export const f2=v=>Math.round(v*10)/10;
