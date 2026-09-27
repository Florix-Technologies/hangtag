// Supabase query helpers: error handling, paging, chunked upserts (for the gateway).
import { toAppError } from './errors.js';

/* supabase-js returns {error} instead of throwing — turn it into a throw (an AppError) so callers can queue a retry */
export const sbOk=r=>{if(r&&r.error)throw toAppError(r.error);return r};
/* Supabase returns at most 1000 rows per request, so page through the whole table */
export async function sbFetchAll(client,table,orders){
  const out=[],N=1000;
  for(let from=0;;from+=N){
    let q=client.from(table).select('*');
    orders.forEach(o=>{q=q.order(o,{ascending:true})});
    const {data}=sbOk(await q.range(from,from+N-1));
    out.push(...(data||[]));
    if(!data||data.length<N)break;
  }
  return out;
}
export async function upsertChunks(client, table, rows, opts){
  for(let i=0;i<rows.length;i+=500) sbOk(await client.from(table).upsert(rows.slice(i,i+500), opts));
}
