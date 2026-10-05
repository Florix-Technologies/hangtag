// Colour values: palette, validation, contrast, colour-name swatches.

export const COLORS=["#1B1E24","#ECEAE3","#1F4E8C","#7A1F2B","#2F5D46","#C9A227","#8E8A83","#D96C8A","#5B3A8C","#C2622D","#6FA8C9","#A3B18A"];
export const okColor=c=>/^#[0-9a-f]{6}$/i.test(String(c||""))?c:"#8E8A83";
const rgbOf=hex=>{const h=okColor(hex).slice(1);return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16))};
const hexOf=a=>"#"+a.map(v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,"0")).join("");
/* The colour mixed with white (amount 0..1 of white): a soft background. tint("#1D5BBF", .88) → a pale blue */
export const tint=(hex,amount)=>hexOf(rgbOf(hex).map(v=>v+(255-v)*amount));
/* The colour mixed with black (amount 0..1 of black): an ink that reads on its tint */
export const shade=(hex,amount)=>hexOf(rgbOf(hex).map(v=>v*(1-amount)));
export function isLight(hex){const h=okColor(hex).slice(1);const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);return (r*299+g*587+b*114)/1000>150}
/* colour names shown as small swatches */

export const SWATCH={black:"#1B1E24",white:"#F4F2EC",offwhite:"#EFEBDF",cream:"#EDE3CC",ivory:"#F1ECDC",beige:"#D9C7A7",grey:"#8E8A83",gray:"#8E8A83",charcoal:"#3C3F45",navy:"#1F2F57",blue:"#2A5DB0",skyblue:"#8CC3EA",red:"#B22A2A",maroon:"#6E1F2A",wine:"#6B1D2E",pink:"#E59BB3",green:"#2F6B45",olive:"#6B6B35",khaki:"#B5A26E",yellow:"#E8C53A",mustard:"#C9A227",orange:"#E0762B",brown:"#6B4A33",tan:"#B08661",purple:"#5B3A8C",lavender:"#B7A5D8",teal:"#1F7A7A",mint:"#A8DDC4",gold:"#C9A227",silver:"#C0C4CC"};
export const swatchOf=c=>SWATCH[String(c||"").toLowerCase().replace(/[^a-z]/g,"")]||"#C9CCD6";
