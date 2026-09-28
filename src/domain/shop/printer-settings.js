// The receipt printer of this device: the browser's print dialog (any printer), or an Epson thermal printer on the shop's
// network (its ePOS-Print service). Kept per device, not per shop: each till has its own printer.

export const DEFAULT_PRINTER={kind:"browser",host:"",https:true,devid:"local_printer",cols:48};
export const PRINTER_KINDS=["browser","epson"];

/* input: { kind, host, https, devid, cols } as typed → { printer } or { error, field } */
export function checkPrinterSettings(input){
  const i=input||{}, kind=PRINTER_KINDS.includes(i.kind)?i.kind:"browser";
  const host=String(i.host||"").trim().replace(/^https?:\/\//i,"").replace(/\/+$/,"");
  const devid=String(i.devid==null?DEFAULT_PRINTER.devid:i.devid).trim()||DEFAULT_PRINTER.devid;
  const cols=[48,42,32].includes(+i.cols)?+i.cols:48;
  if(kind==="epson"){
    if(!host) return {error:"Enter the printer's IP address (printed on its status sheet), e.g. 192.168.1.50.",field:"host"};
    if(!/^([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(:\d{1,5})?$/.test(host)||host.length>80) return {error:"That doesn't look like a printer address. Use an IP address such as 192.168.1.50.",field:"host"};
    if(!/^[A-Za-z0-9_]{1,30}$/.test(devid)) return {error:"The printer's device ID uses letters, digits and _ only (usually local_printer).",field:"devid"};
  }
  return {printer:{kind,host,https:i.https!==false&&i.https!=="false",devid,cols}};
}
/* The printer settings saved on this device, made safe to use */
export const printerOf=saved=>Object.assign({},DEFAULT_PRINTER,saved&&typeof saved==="object"?saved:{});
