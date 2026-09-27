// Low-stock threshold and stock level classification.

/* The shop's low-stock alert level (settings.lowStock), never below 0 */
export const lowStockThreshold=settings=>Math.max(0,Math.round(+settings.lowStock||0));
/* "out" (none left), "low" (at or below the threshold) or "ok" */
export const stockLevel=(n,threshold)=>n<=0?"out":n<=threshold?"low":"ok";
