// Money and number formatting, in the shop's currency (regions.js; India by default: ₹ and en-IN grouping).
// The app's region sets it (configureMoney); the names stay inr / inrx / inrShort, which every screen already uses.
import { REGIONS, compactParts } from './regions.js';

let R = REGIONS.IN;
/* The region money is written for ({ symbol, locale, minor, compact }) */
export function configureMoney(region){ R = region && region.symbol ? region : REGIONS.IN; }
export const currencySymbol = () => R.symbol;
export const inr=n=>R.symbol+Math.round(n||0).toLocaleString(R.locale);
/* To the paisa when there are paise (₹1,048.95), whole rupees otherwise (₹1,049) — for discounts, GST and round off */
export function inrx(n){const p=Math.round((n||0)*100),v=Math.abs(p)/100;return (p<0?"−":"")+R.symbol+v.toLocaleString(R.locale,{minimumFractionDigits:p%100?2:0,maximumFractionDigits:2})}
export const r1=x=>{const v=Math.round(x*10)/10;return v%1===0?v.toFixed(0):v.toFixed(1)};
export function inrShort(n){n=Math.round(n||0);return R.symbol+compactParts(n,R)}
export const f2=v=>Math.round(v*10)/10;
