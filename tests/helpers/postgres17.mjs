// Runs the database suites on PostgreSQL 17, the live Supabase project's major version (17.6 on 2026-10-11), instead of the
// PostgreSQL 18 of the default PGlite: syntax or behaviour that only 18 has would pass every suite and then fail on the live
// database. Every import of @electric-sql/pglite resolves to the pglite-pg17 package (PGlite 0.4.6 = PostgreSQL 17.5).
//   node --import ./tests/helpers/postgres17.mjs tests/run.mjs supabase/tests      (npm run test:db:pg17)
// tests/run.mjs passes its Node flags to each file it runs, so the whole folder runs on 17. postgres-versions.test.mjs
// checks that this build is still the live project's major version.
import { registerHooks } from 'node:module';

const NAME = '@electric-sql/pglite';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === NAME || specifier.startsWith(NAME + '/')) return next('pglite-pg17' + specifier.slice(NAME.length), context);
    return next(specifier, context);
  },
});
