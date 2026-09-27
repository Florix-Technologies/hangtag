// Size ordering.

export const SZ=["XXS","XS","S","M","L","XL","XXL","2XL","XXXL","3XL","4XL","5XL"];
export function szRank(s){const i=SZ.indexOf(String(s).toUpperCase());if(i>-1)return i;const n=parseFloat(s);return isNaN(n)?1000:100+n}
