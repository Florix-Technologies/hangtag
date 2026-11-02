// vercel.json's redirects as Vercel applies them, for the tests that serve the site themselves: a rule's "has" host
// condition (a regular expression for the whole host name) and its source, a path-to-regexp pattern, which Vercel matches
// against the path without the query and without regard to case, with an optional trailing "/". Only the shape vercel.json
// uses is understood ("/:name(regex)"); any other is refused, so a new kind of rule fails the tests instead of being
// matched wrongly. The query passes through to the destination, as Vercel documents for redirects.
const SOURCE = /^\/:([A-Za-z]\w*)\((.+)\)$/;

function compile(rule) {
  const m = SOURCE.exec(rule.source);
  if (!m) throw new Error(`vercel.json redirect source not understood by tests/helpers/vercel-routes.mjs: ${rule.source}`);
  const [, name, pattern] = m;
  const hosts = (rule.has || []).map((h) => {
    if (h.type !== 'host') throw new Error(`vercel.json redirect condition not understood: ${JSON.stringify(h)}`);
    return new RegExp(`^(?:${h.value})$`, 'i');
  });
  if ((rule.missing || []).length) throw new Error('vercel.json "missing" conditions are not understood');
  return { re: new RegExp(`^\\/(?:(${pattern}))[\\/#\\?]?$`, 'i'), name, hosts, rule };
}

/* vercel.json's headers for a path, as Vercel applies them: every rule whose source matches — a literal path, or the
   "/:name(regex)" shape above — later rules over earlier ones for the same header. Any other shape is refused. */
export function headersFor(vercel, pathname) {
  const out = {};
  for (const rule of vercel.headers || []) {
    const m = SOURCE.exec(rule.source);
    const re = m ? new RegExp(`^\\/(?:(${m[2]}))[\\/#\\?]?$`, 'i')
      : /^\/[\w./-]*$/.test(rule.source) ? new RegExp(`^${rule.source.replace(/\./g, '\\.')}$`, 'i') : null;
    if (!re) throw new Error(`vercel.json header source not understood by tests/helpers/vercel-routes.mjs: ${rule.source}`);
    if (re.test(pathname)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

/* where Vercel would send a request for host + path (with its query), or null when no redirect applies */
export function redirectFor(vercel, host, pathAndQuery) {
  const u = new URL('http://x' + pathAndQuery);   // not new URL(path, base): "//elsewhere/" must stay a path
  for (const c of (vercel.redirects || []).map(compile)) {
    if (!c.hosts.every((h) => h.test(host))) continue;
    const m = c.re.exec(u.pathname);
    if (!m) continue;
    const to = new URL(c.rule.destination.replace(':' + c.name, m[1] || ''));
    if (u.search && !to.search) to.search = u.search;
    const status = c.rule.statusCode || (c.rule.permanent ? 308 : 307);
    return { status, location: to.href };
  }
  return null;
}
