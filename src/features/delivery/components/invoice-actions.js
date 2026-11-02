// Download and Share of a bill's invoice: the bill's one invoice PDF (use-cases/canonical-invoice.js), the same file its
// email attaches, WhatsApp carries and the SMS links to. Before it is registered (offline, or sending not set up) this
// phone's copy goes: the same document, made from the same saved bill.
import { use } from '../../../shared/di/services.js';
import { toast } from '../../../shared/components/toast.js';
import { logger } from '../../../shared/logging/logger.js';
import { ensureInvoice, invoicePdfFile, localInvoicePdf, registeredInvoice } from '../use-cases/canonical-invoice.js';

const open = url => { const w = window.open(url, "_blank", "noopener"); if(!w) location.href = url; };
export async function downloadInvoice(sid){
  const f = await invoicePdfFile(sid);
  if(!f){ toast("That bill isn't on this device."); return false; }
  if(f.url){ open(f.url); toast("The invoice PDF is downloading."); return true; }
  try{ await use("files").saveFile(f.name, f.bytes, "application/pdf"); toast("Invoice PDF saved."); return true; }
  catch(e){ logger.warn("Invoice PDF:", e); toast("Couldn't save the PDF. Try Print → Save as PDF."); return false; }
}
/* Through this phone's share sheet, right in the tap (a share started after waiting on the network is refused), unless
   the bill's registered invoice is another phone's copy: then that file is downloaded instead */
export async function shareInvoice(sid){
  const mine = localInvoicePdf(sid); if(!mine){ toast("That bill isn't on this device."); return; }
  const reg = registeredInvoice(sid);
  if(reg){ let same = false; try{ same = await use("files").sha256Hex(new Blob([mine.bytes])) === reg.sha256; }catch{ same = false; } if(!same) return void downloadInvoice(sid); }
  else ensureInvoice(sid);   // registered in the background: this copy becomes the bill's invoice (or the first one stays)
  const name = reg && reg.filename || mine.name, file = typeof File !== "undefined" ? new File([mine.bytes], name, { type: "application/pdf" }) : null;
  try{
    if(file && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))){ await navigator.share({ title: name, files: [file] }); return; }
  }catch(e){ if(e && e.name === "AbortError") return; logger.warn("Share failed:", e); }
  await downloadInvoice(sid);
}
