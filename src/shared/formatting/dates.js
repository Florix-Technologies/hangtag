// Date keys and date/time labels (local time).

export const pad=n=>String(n).padStart(2,"0");
export const dk=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
export const dayKey=t=>dk(new Date(t));
export const parseDay=s=>{const a=String(s).split("-").map(Number);return new Date(a[0],a[1]-1,a[2])};
export const addDays=(s,n)=>{const d=parseDay(s);d.setDate(d.getDate()+n);return dk(d)};
export const daysBetween=(a,b)=>Math.round((parseDay(b)-parseDay(a))/864e5);
export const hhmm=t=>new Date(t).toLocaleTimeString("en-IN",{hour:"numeric",minute:"2-digit"});
export const hourLab=h=>((h%12)||12)+(h<12?"am":"pm");
export const dayLab=s=>parseDay(s).toLocaleDateString("en-IN",{day:"numeric",month:"short"});
export const dayLong=s=>parseDay(s).toLocaleDateString("en-IN",{weekday:"short",day:"numeric",month:"short"});
export function agoText(t){ const s = Math.round((Date.now()-t)/1000); if(s < 45) return "just now"; const m = Math.round(s/60); if(m < 60) return m+" min ago"; const h = Math.round(m/60); if(h < 24) return h+" h ago"; return Math.round(h/24)+" d ago"; }
export const dtLong=t=>new Date(t).toLocaleString("en-IN",{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"});
