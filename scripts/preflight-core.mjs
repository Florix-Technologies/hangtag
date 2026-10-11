// Release preflight, the part without I/O: the files each Edge Function is deployed with, the settings its code reads, and
// what a project lacks against supabase/functions/deploy.json. scripts/preflight-live.mjs gathers a project's facts
// (read-only) and prints assess()'s rows; tests/unit/release-preflight.test.mjs covers both halves.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/* every project has these (Supabase sets them) */
export const PROJECT_DEFAULTS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL'];

const CODE = /\.(ts|js|mjs)$/;
const walk = (dir) => readdirSync(dir).sort().flatMap((f) => {
  const p = path.join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : (CODE.test(f) ? [p] : []);
});

/* the deployable functions: every folder of supabase/functions except _shared */
export const functionNames = (fnRoot) => readdirSync(fnRoot).filter((f) => !f.startsWith('_') && statSync(path.join(fnRoot, f)).isDirectory()).sort();

/* a function's own files (its folder) */
export const ownFiles = (fnRoot, name) => walk(path.join(fnRoot, name));

/* the files a deploy bundles: its folder plus every relative import, followed (../_shared/plan-gate.js, ../agent/core.js) */
export function functionFiles(fnRoot, name) {
  const seen = new Set(), todo = ownFiles(fnRoot, name);
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const [, spec] of readFileSync(f, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(f), spec);
      if (existsSync(target) && !seen.has(target)) todo.push(target);
    }
  }
  return [...seen].sort();
}

/* the settings a source reads: Deno.env.get("X"), and X read from Deno.env.toObject() as env.X, env["X"] or e("X") */
const READS = /Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]+)['"]|\b(?:env|e|cfg)\s*\.\s*([A-Z][A-Z0-9_]{2,})\b|\b(?:env|e)\s*\[\s*['"]([A-Z][A-Z0-9_]+)['"]|\b(?:e|env|get|need|opt)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;
export function settingsRead(text) {
  const out = new Set();
  for (const m of text.matchAll(READS)) out.add(m[1] || m[2] || m[3] || m[4]);
  return [...out].sort();
}

/* a time as text or as epoch milliseconds (the Supabase CLI's functions list gives updated_at as a number) */
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
const day = (t) => (Number.isFinite(ms(t)) ? new Date(ms(t)).toISOString().slice(0, 10) : '?');

/* the names deploy.json gives a function, in any role */
export const declared = (entry = {}) => new Set([...(entry.required || []), ...(entry.optional || []), ...(entry.anyOf || []).flat()]);

/* What each function of a project needs.
   deployed: the project's functions [{ slug, version, updated_at, verify_jwt, status }]; secrets: the names set on it;
   changedAt: { name: ISO time of the last commit touching the files it is deployed with }.
   → [{ name, deployed: { version, at, day, jwt } | null, changedAt, problems: [text] }], in name order */
export function assess({ manifest, deployed, secrets, changedAt = {} }) {
  const have = new Set([...secrets, ...PROJECT_DEFAULTS]);
  const live = new Map(deployed.map((d) => [d.slug, d]));
  return Object.keys(manifest).filter((k) => !k.startsWith('$')).sort().map((name) => {
    const want = manifest[name], d = live.get(name), at = changedAt[name] || null, problems = [];
    const missing = (want.required || []).filter((s) => !have.has(s));
    if (missing.length) problems.push(`missing secret${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
    if (want.anyOf && !want.anyOf.some((group) => group.every((s) => have.has(s))))
      problems.push(`no provider set up: one of ${want.anyOf.map((group) => group.join(' + ')).join(' | ')}`);
    if (!d) problems.push('not deployed');
    else {
      if (d.status && d.status !== 'ACTIVE') problems.push(`status ${d.status}`);
      if (typeof want.jwt === 'boolean' && d.verify_jwt !== want.jwt)
        problems.push(want.jwt ? 'deployed without JWT verification (deploy it without --no-verify-jwt)' : 'deployed with JWT verification (deploy it with --no-verify-jwt)');
      if (at && ms(at) > ms(d.updated_at))
        problems.push(`code changed ${day(at)}, after the deployed version of ${day(d.updated_at)}: redeploy`);
    }
    return { name, deployed: d ? { version: d.version, at: d.updated_at, day: day(d.updated_at), jwt: d.verify_jwt } : null, changedAt: at, problems };
  });
}
