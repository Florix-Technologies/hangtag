// The "documentExtractionService" port: sends a supplier bill to the extract-bill Edge Function (which holds the provider's
// API key) and returns its extraction. Photos are shrunk first; PDFs go as they are.
import { AppError, ERROR_CODES } from '../../shared/errors/app-error.js';

export const MAX_UPLOAD = 15 * 1024 * 1024;
export const isPdf = f => /pdf/i.test((f && f.type) || "") || /\.pdf$/i.test((f && f.name) || "");

/* cloud: the cloud gateway (extractBill); files: { downscaleImage, readAsBase64 } */
export function createBillExtractor({ cloud, files }){
  return {
    /* file: a File from the camera, gallery or a PDF picker → the extraction ({ supplier, invoice, lines, warnings, … }) */
    async extract(file, { fileHash } = {}){
      const pdf = isPdf(file);
      if(!pdf && !/^image\//i.test(file.type || "")) throw new AppError(ERROR_CODES.VALIDATION, "Use a PDF, or a photo of the bill.");
      const blob = pdf ? file : await files.downscaleImage(file, { maxPx: 2000, quality: 0.85 });
      if(blob.size > MAX_UPLOAD) throw new AppError(ERROR_CODES.VALIDATION, "The file is larger than 15 MB. Take a photo of the bill, or split the PDF.");
      const data = await files.readAsBase64(blob);
      const res = await cloud.extractBill({ file_name: file.name || "bill", mime_type: pdf ? "application/pdf" : "image/jpeg", data, file_hash: fileHash || "" });
      if(!res || res.ok === false || !Array.isArray(res.lines)) throw new AppError(ERROR_CODES.UNKNOWN, (res && res.message) || "The bill couldn't be read. Try again, or enter the lines by hand.");
      return res;
    },
  };
}
