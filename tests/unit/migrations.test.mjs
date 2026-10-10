// The migrations stay in step with supabase/schema.sql: each live-app migration says it needs schema.sql first (so the
// separate Phase 1 foundation suite, which runs the stand-alone migrations on an empty database, leaves it out), and each
// one that is "exactly section N of supabase/schema.sql" is exactly that section — a fix made in one is made in the other.
// Run: node tests/unit/migrations.test.mjs
import { readFileSync, readdirSync } from 'node:fs';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const dir = new URL('../../supabase/migrations/', import.meta.url);
const lf = (s) => s.replace(/\r\n/g, '\n');
const SCHEMA = lf(readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8'));
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const RULE = '-- ==============================================================================\n';

// live-app migrations after the Phase 1 foundation build on schema.sql
const live = files.filter((f) => /^\d{14}_hangtag_/.test(f) && f.slice(0, 14) > '20260925180000');
const unmarked = live.filter((f) => !/^-- Requires: supabase\/schema\.sql/m.test(readFileSync(new URL(f, dir), 'utf8')));
check(`every live-app migration since the Phase 1 foundation declares "-- Requires: supabase/schema.sql" (${live.length})`, live.length >= 7 && unmarked.length === 0, unmarked);

// "exactly section N": the migration's section is byte for byte the schema's (a section starts after a rule line of
// = or -, and ends where the next numbered section's rule starts). A migration that says it also carries "the row
// security rules section 5 gives these tables" may add those after the section — and nothing else.
const SECTION_START = (id) => new RegExp(`-- (?:={78}|-{78})\\n-- ${id}\\. `);
const NEXT_SECTION = /\n-- (?:={78}|-{78})\n-- \d+[a-z]*\. /;
const sectionOf = (text, id) => {
  const m = SECTION_START(id).exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length), next = rest.search(NEXT_SECTION);
  return (text.slice(m.index, m.index + m[0].length) + (next < 0 ? rest : rest.slice(0, next + 1))).replace(/\s+$/, '');
};
for (const f of files) {
  const text = lf(readFileSync(new URL(f, dir), 'utf8')), m = /[Ee]xactly section (\d+[a-z]*) of (?:supabase\/)?schema\.sql( plus the row security)?/.exec(text);
  if (!m) continue;
  const mine = sectionOf(text, m[1]), theirs = sectionOf(SCHEMA, m[1]);
  const extra = mine && theirs && mine.startsWith(theirs) ? mine.slice(theirs.length) : null;
  const ok = !!mine && !!theirs && (mine === theirs || (!!m[2] && extra !== null && /^\s*\n(?:-- -{78}\n)?-- Row security/.test(extra)));
  const at = mine && theirs && !ok ? [...mine].findIndex((c, i) => c !== theirs[i]) : -1;
  check(`${f} is exactly section ${m[1]} of schema.sql${m[2] ? ' (plus its row security from section 5)' : ''}`, ok,
    at < 0 ? { found_in_migration: !!mine, found_in_schema: !!theirs } : { migration: mine.slice(Math.max(0, at - 80), at + 120), schema: theirs.slice(Math.max(0, at - 80), at + 120) });
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
