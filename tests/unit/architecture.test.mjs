// Architecture rules (scripts/check-architecture.mjs, see ARCHITECTURE.md): zero rule violations and no import cycles.
// Also checks that every app internal the browser tests use still exists (scripts/test-api.mjs).
// Run: npm run test:unit
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info, null, 1) : ''));
}
const run = (script, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8' });

const r = run('check-architecture.mjs', '--report');
const out = r.stdout || '';
check('the architecture check runs', /\d+ modules · \d+ rule violations/.test(out), out.slice(0, 300) + r.stderr);
const violations = (out.split('\nRule violations:\n')[1] || '').split('\n\n')[0].split('\n').map((l) => l.trim()).filter(Boolean);
const cycles = [...out.matchAll(/^cycle \d+ \(\d+\): (.*)$/gm)].map((m) => m[1].split(', '));
const kind = (re) => violations.filter((v) => re.test(v));

check('features never import app/ or infrastructure/ (they use ports and the render bus)', !kind(/^features\/\S+ \(features\) must not import (app|infrastructure)\//).length, kind(/^features\//));
check('infrastructure never imports app/ or features/', !kind(/^infrastructure\/\S+ \(infrastructure\) must not import/).length, kind(/^infrastructure\//));
check('shared/ and domain/ import only what they may', !kind(/^(shared|domain)\/\S+ \((shared|domain)\) must not import/).length, kind(/^(shared|domain)\/\S+ \(/));
check('only infrastructure talks to Supabase or the network', !kind(/talks to Supabase/).length, kind(/talks to Supabase/));
check('the domain uses no browser APIs and no app state', !kind(/domain code uses/).length, kind(/domain code uses/));
check('browser storage only in infrastructure/storage', !kind(/uses browser storage directly/).length, kind(/uses browser storage directly/));
check('config.js and the test flag are read only by shared/config/app-config.js', !kind(/reads config\.js/).length, kind(/reads config\.js/));
check('logging only through shared/logging/logger.js', !kind(/calls console directly/).length, kind(/calls console directly/));
check('every import resolves', !kind(/imports missing file/).length, kind(/imports missing file/));
check('zero rule violations in total', violations.length === 0 && r.status === 0, violations);
check('no import cycles', cycles.length === 0, cycles);

const api = run('test-api.mjs');
check('every app internal the browser tests use still exists (tests/test-api.json)', api.status === 0, api.stdout + api.stderr);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
