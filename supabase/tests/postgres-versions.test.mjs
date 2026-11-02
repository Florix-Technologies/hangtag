// The database suites run on the default PGlite (PostgreSQL 18, a version ahead of the live project) and, through
// npm run test:db:pg17, on pglite-pg17 (PostgreSQL 17, the live Supabase project's major version), so that SQL only 18 has
// can't pass every suite and then fail on the live database. This keeps that second run honest: pglite-pg17 must be the live
// project's major version, which `supabase link` writes to supabase/.temp/postgres-version (git-ignored: checked when this
// checkout is linked), and the engine a run uses must not be older than the live project.
// When Supabase upgrades the live project, this fails and says what to move.
// Run: node supabase/tests/postgres-versions.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { PGlite as PGlite17 } from 'pglite-pg17';
import fs from 'fs';

const LIVE_MAJOR = 17;   // the live project's PostgreSQL (Supabase dashboard: Project Settings, Infrastructure)
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const major = async (Engine) => {
  const db = new Engine();
  try { return Math.floor((await db.query("select current_setting('server_version_num')::int as n")).rows[0].n / 10000); }
  finally { await db.close(); }
};

const pg17 = await major(PGlite17), used = await major(PGlite);
check(`pglite-pg17 is PostgreSQL ${LIVE_MAJOR}, the live project's major version (it is ${pg17})`, pg17 === LIVE_MAJOR, pg17);
check(`the engine this run uses (PostgreSQL ${used}) is not older than the live project`, used >= LIVE_MAJOR, used);

const linked = new URL('../.temp/postgres-version', import.meta.url);
if (fs.existsSync(linked)) {
  const live = fs.readFileSync(linked, 'utf8').trim(), liveMajor = parseInt(live, 10);
  check(`the linked project runs PostgreSQL ${live}: major ${LIVE_MAJOR}` + (liveMajor === LIVE_MAJOR ? ''
    : ` - it moved to ${liveMajor}: point pglite-pg17 (package.json) at a PGlite build of PostgreSQL ${liveMajor} and set LIVE_MAJOR`), liveMajor === LIVE_MAJOR, live);
} else console.log('(not linked to a Supabase project: the live version file is absent, so only the packages were checked)');

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
