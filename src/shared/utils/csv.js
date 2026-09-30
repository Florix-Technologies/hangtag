// CSV text from rows of values (Excel-friendly: quoted when needed, a BOM added by the caller when saving).
export const csvCell=v=>{v=v==null?"":String(v);return /[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
export const csvText=rows=>rows.map(r=>r.map(csvCell).join(",")).join("\n");
/* Rows of text from CSV (a file saved by Excel, Sheets or LibreOffice): quoted cells with commas, quotes ("") and line
   breaks, \n or \r\n line ends, a leading BOM; a ";" or tab separator when the first line has more of those than commas.
   Blank lines are dropped. */
export function parseCsv(text){
  const s=String(text==null?"":text).replace(/^\uFEFF/,""), first=s.split(/\r?\n/,1)[0]||"";
  const count=c=>first.split(c).length-1, sep=count(";")>count(",")&&count(";")>=count("\t")?";":count("\t")>count(",")?"\t":",";
  const rows=[]; let row=[], cell="", q=false;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(q){ if(c==='"'){ if(s[i+1]==='"'){cell+='"';i++} else q=false } else cell+=c; continue; }
    if(c==='"'&&cell==="") q=true;
    else if(c===sep){ row.push(cell); cell=""; }
    else if(c==="\n"||c==="\r"){ if(c==="\r"&&s[i+1]==="\n") i++; row.push(cell); rows.push(row); row=[]; cell=""; }
    else cell+=c;
  }
  if(cell!==""||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(v=>String(v).trim()!==""));
}
