// Turns Supabase / Postgres / network errors into AppErrors with plain messages (the original stays as `cause`).
import { AppError, ERROR_CODES as C } from '../../shared/errors/app-error.js';

const NETWORK = /failed to fetch|networkerror|network request failed|load failed|fetch failed|timed? ?out|econn|enotfound/i;
const AUTH = /jwt|token (has )?expired|not authenticated|invalid claim|refresh token/i;
const OUTDATED = /PGRST20[25]|42P01|42703|42883|does not exist|schema cache/i;

export function toAppError(e){
  if(e instanceof AppError) return e;
  const code = String((e && (e.code || e.status)) || ""), msg = String((e && e.message) || e || "");
  const make = (c, text) => new AppError(c, text, { cause: e, details: { code } });
  if(NETWORK.test(msg)) return make(C.NETWORK, "No internet connection. It will try again.");
  // the shop's plan has ended (schema.sql section 3t): kept and sent again after renewal, never a refusal to review
  if(code === "HT402" || /HANGTAG_SUBSCRIPTION_INACTIVE/.test(msg)) return make(C.SUBSCRIPTION, "This shop's Hangtag plan has ended. Renew it in Plans & Billing; your changes are kept until then.");
  if(code === "42501" || /row-level security|permission denied/i.test(msg)) return make(C.PERMISSION, "This account isn't allowed to change that.");
  // hangtag_doc_no_check: another bill (credit note) of the shop already has this number; the message says which
  if(code === "23505" && /^(Bill|Credit note) number .+ is already used/.test(msg)) return new AppError(C.CONFLICT, msg, { cause: e, details: { code, kind: "number" } });
  if(code === "23505" || /duplicate key/i.test(msg)) return make(C.CONFLICT, "Something with the same SKU, barcode or number is already saved.");
  // hangtag_save_order: the order was changed on another device since this one saw it (its message says which)
  if(code === "40001") return make(C.CONFLICT, msg || "This was changed on another device.");
  if(code === "PGRST301" || code === "401" || AUTH.test(msg)) return make(C.AUTH, "Your sign-in has expired. Sign in again.");
  // hangtag_import_stock: this bill (same file, or same supplier + invoice number) was added before
  if(/HANGTAG_DUPLICATE_(FILE|INVOICE)/.test(msg)){
    let prev = null; try{ prev = JSON.parse(e.details || "null"); }catch{ prev = null; }
    return new AppError(C.CONFLICT, "This bill may already have been imported.", { cause: e, details: { code, kind: /FILE/.test(msg) ? "file" : "invoice", previous: prev } });
  }
  if(OUTDATED.test(code + " " + msg)) return make(C.OUTDATED_DATABASE, "The database needs the latest update (schema.sql).");
  // Rules in schema.sql raise messages written for people (e.g. "Can't return 1 piece(s): 2 bought, 2 already returned")
  if(code === "23514" || code === "P0001") return make(C.VALIDATION, msg);
  if(code === "23503") return make(C.NOT_FOUND, "Something this change depends on isn't in the cloud yet. It will try again.");
  return make(C.UNKNOWN, "The cloud couldn't complete this request. It will try again.");
}
