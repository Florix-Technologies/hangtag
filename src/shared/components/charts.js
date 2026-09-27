// Column chart and table markup.
import { esc } from '../dom.js';
import { f2 } from '../formatting/money.js';

export function niceStep(raw){const p=Math.pow(10,Math.floor(Math.log10(raw))),f=raw/p;return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p}
export function niceScale(max,n,int){if(max<=0)return{top:int?1:100,step:int?1:25};let step=niceStep(max/n);if(int)step=Math.max(1,Math.ceil(step));return{top:Math.ceil(max/step-1e-9)*step,step}}
export function colChart(host,rows,o){
  const W=Math.max(260,Math.floor(host.clientWidth||600)),H=o.h||230,m={t:26,r:6,b:26,l:o.int?28:48};
  const pw=W-m.l-m.r,ph=H-m.t-m.b,max=Math.max(0,...rows.map(r=>r.v)),sc=niceScale(max,4,o.int);
  const y=v=>m.t+ph-(sc.top?Math.max(0,v)/sc.top*ph:0),n=rows.length,band=pw/n,bw=Math.max(4,Math.min(24,band*.62)),every=Math.max(1,Math.ceil((o.labelW||30)/band));
  let s=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${esc(o.aria||"")}">`;
  for(let i=0,v=0;v<=sc.top+1e-9&&i<12;i++,v=i*sc.step){const yy=Math.round(y(v))+.5;s+=`<line class="${v===0?"bl":"gl"}" x1="${m.l}" x2="${W-m.r}" y1="${yy}" y2="${yy}"/><text class="ax" x="${m.l-8}" y="${yy+3.5}" text-anchor="end">${esc(o.axis(v))}</text>`}
  let pk=0;rows.forEach((r,i)=>{if(r.v>rows[pk].v)pk=i});
  rows.forEach((r,i)=>{
    const cx=m.l+band*i+band/2,x=cx-bw/2,y0=y(0);let y1=y(r.v);if(r.v>0&&y0-y1<2)y1=y0-2;
    const rr=Math.min(4,y0-y1,bw/2);
    s+=`<g class="col">`;
    if(r.v>0)s+=`<path class="bar" d="M${f2(x)} ${f2(y0)}V${f2(y1+rr)}Q${f2(x)} ${f2(y1)} ${f2(x+rr)} ${f2(y1)}H${f2(x+bw-rr)}Q${f2(x+bw)} ${f2(y1)} ${f2(x+bw)} ${f2(y1+rr)}V${f2(y0)}Z"/>`;
    s+=`<rect class="hit" x="${f2(m.l+band*i)}" y="${m.t}" width="${f2(band)}" height="${f2(ph)}"${r.v>0?' tabindex="0"':""} data-tipv="${esc(r.tv)}" data-tipl="${esc(r.tl||"")}" data-tipm="${esc(r.tm||"")}" aria-label="${esc((r.tl?r.tl+": ":"")+r.tv)}"/></g>`;
    if(i%every===0)s+=`<text class="ax" x="${f2(cx)}" y="${H-8}" text-anchor="middle">${esc(r.short)}</text>`;
  });
  if(max>0){const px=m.l+band*pk+band/2,anc=pk===0&&n>1?"start":pk===n-1&&n>1?"end":"middle",lx=anc==="start"?px-bw/2:anc==="end"?px+bw/2:px;s+=`<text class="pk" x="${f2(lx)}" y="${f2(y(rows[pk].v)-8)}" text-anchor="${anc}">${esc(o.peak(rows[pk].v))}</text>`}
  host.innerHTML=s+`</svg>`;
}
export function tableHTML(hd,rows){return `<div class="tw"><table class="tbl"><thead><tr>${hd.map(x=>`<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(x=>`<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`}
