// CSV text from rows of values (Excel-friendly: quoted when needed, a BOM added by the caller when saving).
export const csvCell=v=>{v=v==null?"":String(v);return /[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
export const csvText=rows=>rows.map(r=>r.map(csvCell).join(",")).join("\n");
/* Rows of text from CSV (a file saved by Excel, Sheets or LibreOffice): quoted cells with commas, quotes ("") and line
   breaks, \n or \r\n line ends, a leading BOM; a ";" or tab separator when the first line that isn't a note (# \u2026) has more
   of those than commas. Blank lines are dropped, or kept as empty rows with keepBlank (row numbers then match the sheet). */
export function parseCsv(text,{keepBlank=false}={}){
  const s=String(text==null?"":text).replace(/^\uFEFF/,""), lines=s.split(/\r?\n/,50);
  const first=lines.find(l=>l.trim()!==""&&!/^\s*"?\s*#/.test(l))||lines[0]||"";
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
  if(keepBlank){ while(rows.length&&!rows[rows.length-1].some(v=>String(v).trim()!=="")) rows.pop(); return rows; }
  return rows.filter(r=>r.some(v=>String(v).trim()!==""));
}
/* A CSV file's bytes as text: UTF-8, or (Excel's plain "CSV" on Windows saves in the system's code page) Windows-1252 */
export function decodeCsvBytes(bytes){
  try{ return new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
  catch{ return new TextDecoder("windows-1252").decode(bytes); }
}
