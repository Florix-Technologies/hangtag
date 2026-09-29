// Stock count: the pieces counted on the shelf are typed next to what the records say (system quantity); each difference
// becomes one ADJUST stock record with the note "Stock count: <reason>" (the database logs every adjustment in the audit
// log). Stock is never overwritten: the adjustment is the difference, worked out again at the moment of saving, so a sale
// made while counting is not lost. Pure.

export const COUNT_REASONS=["Physical count correction","Damaged","Lost or stolen","Expired","Found extra","Other"];
const r3=n=>Math.round(n*1000)/1000;

/* rows: [{ vid, pid, system, dec? }] (system: stock on hand now; dec: decimals the count may have, 0 = whole pieces)
   typed: { vid: what was typed } (empty = not counted) → { error, vid } for the first bad number, or
   { lines: [{ vid, pid, system, physical, diff }] (counted rows), changed (those with a difference), counted, up, down } */
export function countDiffs(rows,typed){
  const lines=[];
  for(const r of rows||[]){
    const raw=typed&&typed[r.vid]; if(raw==null||String(raw).trim()==="") continue;
    const v=Number(String(raw).trim().replace(/,/g,"")), dec=Math.max(0,Math.min(3,Math.round(+r.dec||0)));
    if(!Number.isFinite(v)||v<0) return {error:"A counted quantity can't be negative or empty text.",vid:r.vid};
    if(Math.abs(v*10**dec-Math.round(v*10**dec))>1e-6) return {error:dec?`Use at most ${dec} decimal places.`:"Count whole pieces.",vid:r.vid};
    if(v>10000000) return {error:"That count is too large.",vid:r.vid};
    const system=r3(+r.system||0), physical=r3(v);
    lines.push({vid:r.vid,pid:r.pid,system,physical,diff:r3(physical-system)});
  }
  const changed=lines.filter(l=>l.diff!==0);
  return {lines,changed,counted:lines.length,up:r3(changed.filter(l=>l.diff>0).reduce((a,l)=>a+l.diff,0)),down:r3(changed.filter(l=>l.diff<0).reduce((a,l)=>a-l.diff,0))};
}
/* The note of a count's adjustments */
export const countNote=(reason,note)=>["Stock count: "+String(reason||"").trim(),String(note||"").trim().replace(/\s+/g," ")].filter(s=>s&&s!=="Stock count: ").join(" · ").slice(0,200);
/* changed: from countDiffs, with system worked out again now (currentStock(vid)) · → { error } or { moves } */
export function countMoves(changed,{reason,note,now,dev,newId,currentStock}){
  const why=String(reason||"").trim();
  if(!why) return {error:"Choose the reason for the differences."};
  if(why.length>80) return {error:"The reason can be at most 80 characters."};
  if(String(note||"").trim().length>120) return {error:"The note can be at most 120 characters."};
  const moves=[];
  for(const l of changed||[]){
    const sys=currentStock?r3(+currentStock(l.vid)||0):l.system, q=r3(l.physical-sys);
    if(q) moves.push({id:newId(),v:l.vid,p:l.pid,type:"ADJUST",q,cost:null,note:countNote(why,note),t:now,dev});
  }
  if(!moves.length) return {error:"Nothing to change: every count matches the records."};
  return {moves};
}
