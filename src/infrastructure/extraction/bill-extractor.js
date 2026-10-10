// The "documentExtractionService" port: sends a supplier bill to the extract-bill Edge Function (which holds the provider's
// API key) and returns its extraction. Photos are shrunk first; PDFs go as they are.
import { AppError, ERROR_CODES } from '../../shared/errors/app-error.js';
import { billFileType } from '../../domain/inventory/bill-import.js';

export const MAX_UPLOAD = 15 * 1024 * 1024;
export const isPdf = f => billFileType(f) === "application/pdf";
/* the pictures the reading service takes as they are (when this browser can't shrink one) */
const SENDABLE = ["image/jpeg", "image/png", "image/webp"];

/* cloud: the cloud gateway (extractBill); files: { downscaleImage, readAsBase64 } */
export function createBillExtractor({ cloud, files }){
  /* the picture to send: shrunk to a JPEG, or (a browser that can't decode it) the original when the service takes its type */
  async function picture(file, type){
    try{ return { blob: await files.downscaleImage(file, { maxPx: 2000, quality: 0.85 }), type: "image/jpeg" }; }
    catch(e){
      if(SENDABLE.includes(type)) return { blob: file, type };
      throw new AppError(ERROR_CODES.VALIDATION, type === "image/heic"
        ? "This browser can't open HEIC photos. Take the photo with the camera here, or save it as JPG and choose it again."
        : "That picture couldn't be opened. Take a photo of the bill, or choose a JPG, PNG or PDF.", { cause: e });
    }
  }
  return {
    /* file: a File from the camera, gallery or a PDF picker → the extraction ({ supplier, invoice, lines, warnings, … }) */
    async extract(file, { fileHash } = {}){
      const type = billFileType(file), pdf = type === "application/pdf";
      if(!pdf && !type.startsWith("image/")) throw new AppError(ERROR_CODES.VALIDATION, "Use a PDF, or a photo of the bill.");
      const send = pdf ? { blob: file, type } : await picture(file, type);
      if(send.blob.size > MAX_UPLOAD) throw new AppError(ERROR_CODES.VALIDATION, "The file is larger than 15 MB. Take a photo of the bill, or split the PDF.");
      const data = await files.readAsBase64(send.blob);
      const res = await cloud.extractBill({ file_name: file.name || "bill", mime_type: send.type, data, file_hash: fileHash || "" });
      if(!res || res.ok === false || !Array.isArray(res.lines)) throw new AppError(ERROR_CODES.UNKNOWN, (res && res.message) || "The bill couldn't be read. Try again, or enter the lines by hand.");
      return res;
    },
  };
}
