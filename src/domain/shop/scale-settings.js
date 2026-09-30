// The weighing scale of this device (Settings → Hardware): how to talk to a scale on a cable. Kept per device, not per shop:
// each counter has its own scale. Pure.

export const BAUD_RATES=[1200,2400,4800,9600,19200,38400,57600,115200];
/* The units a scale may print a bare number in */
export const SCALE_UNITS=["kg","g","lb","l","ml"];
export const DEFAULT_SCALE={baud:9600,unit:"kg",request:"",auto:true};

/* Saved (or typed) settings made safe: { baud, unit (of a number printed without one), request (a command some scales need
   before they send the weight, e.g. "W"; printable characters, at most 8), auto (open the scale again when the app starts) } */
export function scaleSettingsOf(saved){
  const s=saved&&typeof saved==="object"?saved:{};
  return {baud:BAUD_RATES.includes(+s.baud)?+s.baud:DEFAULT_SCALE.baud,unit:SCALE_UNITS.includes(s.unit)?s.unit:DEFAULT_SCALE.unit,
    request:String(s.request==null?"":s.request).replace(/[^\x20-\x7e]/g,"").slice(0,8),auto:s.auto!==false&&s.auto!=="false"};
}
/* Settings as typed in the form → { scale } or { error, field } */
export function checkScaleSettings(input){
  const i=input||{};
  if(!BAUD_RATES.includes(+i.baud)) return {error:"Choose the baud rate set on the scale (often 9600).",field:"baud"};
  if(/[^\x20-\x7e]/.test(String(i.request||""))||String(i.request||"").length>8) return {error:"The command to ask for the weight is up to 8 plain characters (e.g. W or P), or empty.",field:"request"};
  return {scale:scaleSettingsOf(i)};
}
