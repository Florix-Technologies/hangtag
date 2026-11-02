// Stock count: the pieces counted on the shelf are typed next to what the records say (system quantity); each difference
// becomes one ADJUST stock record with the note "Stock count: <reason>" (the database logs every adjustment in the audit
// log). Stock is never overwritten: the adjustment is exactly the difference that was reviewed. If the records of a counted
// variant changed after the review (a sale, a return, stock in), nothing is saved and the count is reviewed again with the
// new numbers — so a sale made while counting is never lost nor counted twice. Pure.

export const COUNT_REASONS=["Physical count correction","Damaged","Lost or stolen","Expired","Found extra","Other"];
const r3=n=>Math.round(n*1000)/1000;

/* rows: [{ vid, pid, system, dec?, key?, b? }] (system: stock on hand now; dec: decimals the count may have, 0 = whole pieces;
   a batch of a product tracked by batch is a row of its own: b its batch number, key "vid|batch")
   typed: { key (or vid): what was typed } (empty = not counted) → { error, vid } for the first bad number, or
   { lines: [{ vid, pid, system, physical, diff, key?, b? }] (counted rows), changed (those with a difference), counted, up, down } */
export function countDiffs(rows,typed){
  const lines=[];
  for(const r of rows||[]){
    const k=r.key||r.vid, raw=typed&&typed[k]; if(raw==null||String(raw).trim()==="") continue;
    const v=Number(String(raw).trim().replace(/,/g,"")), dec=Math.max(0,Math.min(3,Math.round(+r.dec||0)));
    if(!Number.isFinite(v)||v<0) return {error:"A counted quantity can't be negative or empty text.",vid:k};
    if(Math.abs(v*10**dec-Math.round(v*10**dec))>1e-6) return {error:dec?`Use at most ${dec} decimal places.`:"Count whole pieces.",vid:k};
    if(v>10000000) return {error:"That count is too large.",vid:k};
    const system=r3(+r.system||0), physical=r3(v);
    lines.push(Object.assign({vid:r.vid,pid:r.pid,system,physical,diff:r3(physical-system)},r.b?{key:k,b:r.b}:{}));
  }
  const changed=lines.filter(l=>l.diff!==0);
  return {lines,changed,counted:lines.length,up:r3(changed.filter(l=>l.diff>0).reduce((a,l)=>a+l.diff,0)),down:r3(changed.filter(l=>l.diff<0).reduce((a,l)=>a-l.diff,0))};
}
/* The note of a count's adjustments */
export const countNote=(reason,note)=>["Stock count: "+String(reason||"").trim(),String(note||"").trim().replace(/\s+/g," ")].filter(s=>s&&s!=="Stock count: ").join(" · ").slice(0,200);
/* changed: from countDiffs (the reviewed differences) · currentStock(vid, b): the records now (of the batch, for a batch row)
   → { error, moved? (variants whose records changed since the review) } or { moves } */
export function countMoves(changed,{reason,note,now,dev,newId,currentStock}){
  const why=String(reason||"").trim();
  if(!why) return {error:"Choose the reason for the differences."};
  if(why.length>80) return {error:"The reason can be at most 80 characters."};
  if(String(note||"").trim().length>120) return {error:"The note can be at most 120 characters."};
  const moved=currentStock?(changed||[]).filter(l=>r3(+currentStock(l.vid,l.b)||0)!==l.system).map(l=>l.key||l.vid):[];
  if(moved.length) return {error:`The stock of ${moved.length===1?"a counted item":moved.length+" counted items"} changed while you were counting (a sale, return or stock in). Check the counts again: the system numbers are up to date now.`,moved};
  const moves=[];
  for(const l of changed||[]) if(l.diff) moves.push({id:newId(),v:l.vid,p:l.pid,type:"ADJUST",q:l.diff,cost:null,note:countNote(why,note),t:now,dev,...(l.b?{b:l.b}:{})});
  if(!moves.length) return {error:"Nothing to change: every count matches the records."};
  return {moves};
}
