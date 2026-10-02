// Printing a small document (QR cards, a quotation) through the browser's print dialog, from a hidden frame: the app's
// own page stays as it is. css: the document's styles · body: its markup.
import { logger } from '../logging/logger.js';
import { toast } from '../components/toast.js';

export function printDoc(title, css, body){
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true"); f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(f);
  const doc = f.contentWindow.document;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${String(title || "").replace(/[<&]/g, "")}</title><style>${css || ""}</style></head><body>${body}</body></html>`);
  doc.close();
  setTimeout(() => {
    try{ f.contentWindow.focus(); f.contentWindow.print(); }
    catch(e){ logger.error("Print failed:", e); toast("Couldn't open printing. Try Download instead."); }
    setTimeout(() => f.remove(), 60000);
  }, 250);
}
