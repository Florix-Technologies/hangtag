// The "inventoryImportService" port: a confirmed supplier bill is saved in the cloud in ONE step (RPC hangtag_import_stock:
// new products, new variants, stock-in moves and the import record, all or nothing), then applied on this device.
// Unlike other changes it is not queued: the database must accept the whole bill first, so a failure leaves no partial stock.
import { applyPlan } from '../../domain/inventory/bill-import.js';
import { toRpcArgs } from '../supabase/mappers.js';
import { AppError, ERROR_CODES } from '../../shared/errors/app-error.js';

/* store: the state store · cloud: the cloud gateway · persist: { saveCatalog, saveMoves } · outbox: { flush } · invalidate: ledger refresh */
export function createLocalFirstStockImport({ store, cloud, persist, outbox, invalidate }){
  return {
    /* Earlier imports of the same file or invoice number */
    findDuplicates: ({ fileHash, invoiceNo }) => cloud.findImports({ fileHash, invoiceNo }),
    /* plan: from planImport(); meta: bill details for the import record (+ allowDuplicate). Throws an AppError (CONFLICT with
       details.kind "file"|"invoice" for a likely repeat); on success the catalog and moves on this device match the cloud. */
    async commit(plan, meta){
      if(plan.errors && plan.errors.length) throw new AppError(ERROR_CODES.VALIDATION, "Fix the lines marked in red first.");
      if(!plan.moves.length) throw new AppError(ERROR_CODES.VALIDATION, "There's nothing to add.");
      // products this bill adds stock to must already be in the cloud
      await outbox.flush();
      if(store.sbOfflineQueue.length) throw new AppError(ERROR_CODES.VALIDATION, "Some changes are still waiting to upload. Check the internet connection, wait for “Synced”, then try again.");
      const products = (store.catalog && Array.isArray(store.catalog.products)) ? store.catalog.products : [];
      const res = await cloud.importStock(toRpcArgs(plan, meta, products.length));
      // one synchronous step on this device. "already_imported" (a retry of a bill the cloud already has) changes nothing
      // here: the caller downloads the cloud's copy instead, which may differ from this plan.
      if(res && res.status === "imported"){
        store.catalog = { ...(store.catalog || {}), version: 3, products: applyPlan(products, plan) };
        plan.moves.forEach(m => { store.moves[m.id] = m; });
        persist.saveCatalog(); persist.saveMoves(); invalidate();
      }
      return res;
    },
  };
}
