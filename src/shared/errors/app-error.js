// Application errors: a code the app can act on, a message a person can read, and the original error for the logs.

export const ERROR_CODES = Object.freeze({
  NETWORK: "NETWORK",                     // no connection / the request never arrived
  AUTH: "AUTH",                           // signed out or sign-in expired
  PERMISSION: "PERMISSION",               // row-level security refused it
  VALIDATION: "VALIDATION",               // a rule refused it (message written for people)
  CONFLICT: "CONFLICT",                   // already exists (unique SKU, barcode, number…)
  NOT_FOUND: "NOT_FOUND",                 // something it depends on is missing
  OUTDATED_DATABASE: "OUTDATED_DATABASE", // the database needs the latest schema.sql
  STORAGE_FULL: "STORAGE_FULL",           // this device's storage is full
  NOT_CONFIGURED: "NOT_CONFIGURED",       // a server feature isn't set up (e.g. reading bills needs an API key on the server)
  PRINTER: "PRINTER",                     // the receipt printer couldn't be reached or didn't confirm the print
  DELIVERY: "DELIVERY",                   // the email / WhatsApp / SMS service didn't accept the message
  UNKNOWN: "UNKNOWN",
});

export class AppError extends Error {
  constructor(code, message, { cause, details } = {}){
    super(message);
    this.name = "AppError";
    this.code = code;
    if(cause !== undefined) this.cause = cause;
    if(details !== undefined) this.details = details;
  }
}
export const isAppError = e => e instanceof AppError;
/* The message to show a person: an AppError's own message, otherwise the fallback (never raw technical text) */
export const userMessage = (e, fallback) => isAppError(e) ? e.message : fallback;
