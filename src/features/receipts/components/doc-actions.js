// What every A4 document can do: print (the browser's dialog, which also saves as PDF), download its PDF, share the PDF
// from this phone, and show a preview — in the shop's template (Settings → Bills & Documents → Templates).
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { toast } from '../../../shared/components/toast.js';
import { logger } from '../../../shared/logging/logger.js';
import { printDoc } from '../../../shared/ui/print-doc.js';
import { docPdfBytes } from '../../../shared/utils/pdf.js';
import { docSettingsOf } from '../../../domain/documents/doc-settings.js';
import { documentCSS, documentHTML } from './doc-render.js';

/* The shop's template and accent */
export const docOptions = () => { const D = docSettingsOf(store.settings); return { template: D.template, accent: D.accent }; };
const fileName = m => (String((m.title || "document") + " " + (m.number || "")).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document") + ".pdf";
export function printDocument(m){
  if(!m) return;
  printDoc(`${m.title} ${m.number || ""}`.trim(), documentCSS(), documentHTML(m, docOptions()));
}
export function documentPdf(m){ return { name: fileName(m), bytes: docPdfBytes(m, docOptions()) }; }
export async function downloadDocumentPdf(m){
  if(!m) return false;
  try{ const f = documentPdf(m); await use("files").saveFile(f.name, f.bytes, "application/pdf"); toast(`${m.title} PDF saved.`); return true; }
  catch(e){ logger.warn("PDF failed:", e); toast("Couldn't make the PDF. Try Print → Save as PDF."); return false; }
}
/* The PDF through this phone's share sheet (WhatsApp, email…); where sharing files isn't possible, it is downloaded */
export async function shareDocumentPdf(m, text){
  if(!m) return;
  const f = documentPdf(m), file = typeof File !== "undefined" ? new File([f.bytes], f.name, { type: "application/pdf" }) : null;
  try{
    if(file && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))){ await navigator.share({ title: `${m.title} ${m.number || ""}`.trim(), text: text || `${m.title} ${m.number || ""} from ${m.seller.name}`, files: [file] }); return; }
    await use("files").saveFile(f.name, f.bytes, "application/pdf"); toast("PDF downloaded: share it from your files.");
  }catch(e){ if(e && e.name === "AbortError") return; logger.warn("Share failed:", e); toast("Couldn't share it. Try Download PDF."); }
}
