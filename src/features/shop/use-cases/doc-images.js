// The authorised signature and the company stamp printed on A4 documents (Settings → Bills & Documents → Templates):
// a picture shrunk to a small size (white behind any transparency), kept on this device and uploaded (hangtag_meta
// "doc_signature" / "doc_stamp", private to the shop), like the receipt logo (use-cases/receipt-logo.js). Whether each is
// printed is a document setting (docSignImg / docStampImg, domain/documents/doc-settings.js).
import { store } from '../../../shared/state/store.js';
import { enqueue } from '../../sync/services/outbox.js';
import { use } from '../../../shared/di/services.js';
import { saveDocImages } from '../../../shared/state/persistence.js';
import { DOC_IMAGE_KINDS, docImagesOf } from '../../../domain/documents/doc-settings.js';
import { can, notAllowedText } from '../services/access.js';

export const MAX_DOC_IMAGE_CHARS = 200000;
const what = kind => (DOC_IMAGE_KINDS[kind] || "picture").toLowerCase();
/* kind: "signature" | "stamp"; file: a picture from the file picker → { ok } or { error } */
export async function setDocImage(kind, file){
  if(!DOC_IMAGE_KINDS[kind]) return { error: "Choose the signature or the stamp." };
  if(!can("manage_settings")) return { error: notAllowedText("change the " + what(kind)) };
  if(!file || !/^image\/(png|jpeg|webp)$/i.test(file.type || "")) return { error: `Choose a PNG or JPG picture of the ${what(kind)}.` };
  if(file.size > 10 * 1024 * 1024) return { error: "That picture is larger than 10 MB. Choose a smaller one." };
  let url;
  try{
    const files = use("files"), blob = await files.downscaleImage(file, { maxPx: kind === "stamp" ? 300 : 420, quality: .9 });
    url = "data:image/jpeg;base64," + await files.readAsBase64(blob);
  }catch{ return { error: "Couldn't read that picture. Try a PNG or JPG." }; }
  if(url.length > MAX_DOC_IMAGE_CHARS) return { error: `That picture is too detailed to print. Try a plainer ${what(kind)} on white.` };
  store.docImages = Object.assign(docImagesOf(store.docImages), { [kind]: url }); saveDocImages(); enqueue({ type: "docimg", kind });
  return { ok: true };
}
export function removeDocImage(kind){
  if(!DOC_IMAGE_KINDS[kind]) return { error: "Choose the signature or the stamp." };
  if(!can("manage_settings")) return { error: notAllowedText("change the " + what(kind)) };
  store.docImages = Object.assign(docImagesOf(store.docImages), { [kind]: "" }); saveDocImages(); enqueue({ type: "docimg", kind });
  return { ok: true };
}
