// CSV text from rows of values (Excel-friendly: quoted when needed, a BOM added by the caller when saving).
export const csvCell=v=>{v=v==null?"":String(v);return /[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
export const csvText=rows=>rows.map(r=>r.map(csvCell).join(",")).join("\n");
