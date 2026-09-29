// Low-stock threshold and stock level classification.

/* The low-stock alert level: the product's own (p.low, set by bulk import or the product) when it has one, else the
   shop's (settings.lowStock); never below 0 */
export const lowStockThreshold=(settings,p)=>Math.max(0,Math.round(+(p&&p.low!=null&&p.low!==""?p.low:(settings&&settings.lowStock))||0));
/* "out" (none left), "low" (at or below the threshold) or "ok" */
export const stockLevel=(n,threshold)=>n<=0?"out":n<=threshold?"low":"ok";
