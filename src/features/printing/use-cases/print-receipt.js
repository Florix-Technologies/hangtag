// PrintReceipt: print a bill on this device's receipt printer.
//   bill → invoice (features/receipts) → thermal lines (domain/receipts/thermal.js) → "receiptPrinter" port (Epson adapter)
// With no thermal printer set up, the browser's print dialog opens instead (it can't report whether paper came out).
import { checkPrinterSettings } from '../../../domain/shop/printer-settings.js';
import { thermalReceipt } from '../../../domain/receipts/thermal.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { invoiceFor } from '../../receipts/services/receipt-model.js';
import { printSale } from '../../receipts/services/receipt-output.js';
import { use } from '../../../shared/di/services.js';
import { userMessage } from '../../../shared/errors/app-error.js';
import { savePrinter } from '../../../shared/state/persistence.js';

/* → { ok: true, via: "epson", confirmed: true } when the printer confirmed; { ok: true, via: "browser" } when the dialog
   opened; { error, retry } when it didn't print. browser: true skips the thermal printer. */
export async function printReceipt(sid,{browser}={}){
  const s=D().saleById[sid]; if(!s) return {error:"That bill isn't on this device."};
  const cfg=store.printer;
  if(browser||!cfg||cfg.kind!=="epson"){ printSale(sid); return {ok:true,via:"browser"}; }
  try{
    await use("receiptPrinter").print(thermalReceipt(invoiceFor(s),{cols:cfg.cols}),cfg);
    return {ok:true,via:"epson",confirmed:true};
  }catch(e){ return {error:userMessage(e,"The receipt didn't print."),retry:true}; }
}
/* Save this device's printer: input { kind, host, https, devid, cols } → { ok } or { error, field } */
export function savePrinterSettings(input){
  const r=checkPrinterSettings(input); if(r.error) return r;
  store.printer=r.printer; savePrinter();
  return {ok:true};
}
/* A short test receipt on the printer as typed (not saved) → { ok } or { error } */
export async function testPrinter(input){
  const r=checkPrinterSettings(Object.assign({},input,{kind:"epson"})); if(r.error) return r;
  try{ await use("receiptPrinter").test(r.printer); return {ok:true}; }
  catch(e){ return {error:userMessage(e,"The test print didn't work.")}; }
}
