// The shop logo on receipts and invoices: the picture shrunk to a small size, kept on this device and uploaded
// (hangtag_meta, key "logo", private to the shop).
import { store } from '../../../shared/state/store.js';
import { enqueue } from '../../sync/services/outbox.js';
import { use } from '../../../shared/di/services.js';
import { saveLogo, saveSettings } from '../../../shared/state/persistence.js';
import { checkLogoDisplay } from '../../../domain/documents/doc-settings.js';
import { can, notAllowedText } from '../services/access.js';

export const MAX_LOGO_CHARS=300000;
/* The logo printed or not, and where (input: { show, align }) → { ok } or { error } */
export function setLogoDisplay(input){
  if(!can("manage_settings")) return {error:notAllowedText("change how the logo prints")};
  const r=checkLogoDisplay(input); if(r.error) return r;
  store.settings=Object.assign({},store.settings,r.patch); saveSettings(); enqueue({type:"settings"});
  return {ok:true};
}
/* file: a picture from the file picker → { ok } or { error } */
export async function setReceiptLogo(file){
  if(!can("manage_settings")) return {error:notAllowedText("change the receipt logo")};
  if(!file||!/^image\/(png|jpeg|webp|gif)$/i.test(file.type||"")) return {error:"Choose a PNG or JPG picture for the logo."};
  if(file.size>10*1024*1024) return {error:"That picture is larger than 10 MB. Choose a smaller one."};
  let url;
  try{
    const files=use("files"), blob=await files.downscaleImage(file,{maxPx:360,quality:.88});
    url="data:image/jpeg;base64,"+await files.readAsBase64(blob);
  }catch{ return {error:"Couldn't read that picture. Try a PNG or JPG."}; }
  if(url.length>MAX_LOGO_CHARS) return {error:"That picture is too detailed to print. Try a simpler logo."};
  store.logo=url; saveLogo(); enqueue({type:"logo"});
  return {ok:true};
}
export function removeReceiptLogo(){ if(!can("manage_settings")) return {error:notAllowedText("change the receipt logo")}; store.logo=""; saveLogo(); enqueue({type:"logo"}); return {ok:true}; }
