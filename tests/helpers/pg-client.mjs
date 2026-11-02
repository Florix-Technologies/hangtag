// A small stand-in for supabase-js in Node, for Edge Function handlers under test (supabase/functions/*/handler.js):
// from(table) …, rpc(), auth.getUser() and auth.admin.getUserById(), sent through the PostgREST stand-in
// (tests/helpers/pg-rest.mjs) with this client's token — a user's session (row security on, as that user) or
// serviceToken() (the service role: row security off) — so constraints, triggers and row security are the real schema's.
// Only what the handlers use: select (with count / head), insert, update, upsert, delete; eq, neq, in, is, gte, lt; order,
// limit; maybeSingle, single; awaiting a query gives { data, error, count } as supabase-js does (errors are returned,
// never thrown; a missing function is PGRST202, as PostgREST says it).
//   const sr = pgClient(pg, { token: serviceToken() }), me = pgClient(pg, { token: pg.session(uid).access_token, headers });
export function pgClient(pg, { token = null, headers = {} } = {}) {
  async function send(method, path, { query = [], body, prefer = [] } = {}) {
    const url = new URL('https://project.supabase.co' + path);
    for (const [k, v] of query) url.searchParams.append(k, v);
    const h = { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(prefer.length ? { prefer: prefer.join(',') } : {}) };
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
    let res = null;
    const req = { url: () => url.toString(), method: () => method, headers: () => h, postData: () => (body === undefined ? null : JSON.stringify(body)),
      respond: (x) => { res = x; }, abort: () => { res = { status: 0, body: '' }; }, continue: () => { res = { status: 0, body: '' }; } };
    if (!(await pg.handle(req)) || !res) return { data: null, error: { code: 'TEST', message: 'not handled: ' + method + ' ' + path } };
    const text = typeof res.body === 'string' ? res.body : '';
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status >= 400 || res.status === 0) {
      const e = json && typeof json === 'object' ? json : {};
      return { data: null, error: { code: e.code === '42883' ? 'PGRST202' : String(e.code || res.status), message: e.message || e.msg || text, details: e.details || null, hint: e.hint || null } };
    }
    const range = (res.headers || {})['content-range'];
    return { data: json, error: null, count: range && range.includes('/') ? +range.split('/')[1] : null };
  }
  function from(table) {
    const q = { method: 'GET', query: [], body: undefined, prefer: [], one: null };
    const b = {
      select(cols = '*', opts = {}) {
        if (q.method === 'GET') {
          q.query.push(['select', cols]);
          if (opts.head) q.method = 'HEAD';
          if (opts.count) q.prefer.push('count=' + opts.count);
        } else {
          q.prefer.push('return=representation');
          if (cols && cols !== '*') q.query.push(['select', cols]);
        }
        return b;
      },
      insert(rows) { q.method = 'POST'; q.body = rows; return b; },
      upsert(rows, { onConflict, ignoreDuplicates = false } = {}) {
        q.method = 'POST'; q.body = rows; q.prefer.push(ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates');
        if (onConflict) q.query.push(['on_conflict', onConflict]);
        return b;
      },
      update(patch) { q.method = 'PATCH'; q.body = patch; return b; },
      delete() { q.method = 'DELETE'; return b; },
      eq(c, v) { q.query.push([c, 'eq.' + v]); return b; },
      neq(c, v) { q.query.push([c, 'neq.' + v]); return b; },
      gte(c, v) { q.query.push([c, 'gte.' + v]); return b; },
      lt(c, v) { q.query.push([c, 'lt.' + v]); return b; },
      in(c, vs) { q.query.push([c, 'in.(' + vs.map((x) => '"' + x + '"').join(',') + ')']); return b; },
      is(c, v) { q.query.push([c, 'is.' + (v === null ? 'null' : String(v))]); return b; },
      order(c, { ascending = true } = {}) { q.query.push(['order', c + (ascending ? '.asc' : '.desc')]); return b; },
      limit(n) { q.query.push(['limit', String(n)]); return b; },
      maybeSingle() { q.one = 'maybe'; return b; },
      single() { q.one = 'single'; return b; },
      then(resolve, reject) { return run().then(resolve, reject); },
    };
    async function run() {
      const r = await send(q.method, '/rest/v1/' + table, q);
      if (r.error) return r;
      const wrote = q.method !== 'GET' && q.method !== 'HEAD';
      if (q.one) {
        const rows = Array.isArray(r.data) ? r.data : r.data == null ? [] : [r.data];
        if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
        if (q.one === 'single' && !rows.length) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        return { data: rows[0] || null, error: null };
      }
      if (q.method === 'HEAD') return { data: null, error: null, count: r.count };
      return { data: wrote && !q.prefer.includes('return=representation') ? null : r.data, error: null, count: r.count };
    }
    return b;
  }
  return {
    from,
    rpc: (name, args = {}) => send('POST', '/rest/v1/rpc/' + name, { body: args }),
    auth: {
      getUser: async () => { const r = await send('GET', '/auth/v1/user'); return r.error ? { data: { user: null }, error: r.error } : { data: { user: r.data }, error: null }; },
      admin: { getUserById: async (id) => { const r = await send('GET', '/auth/v1/admin/users/' + id); return r.error ? { data: { user: null }, error: r.error } : { data: { user: r.data }, error: null }; } },
    },
  };
}
