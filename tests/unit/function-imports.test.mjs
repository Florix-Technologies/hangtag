// The Edge Functions' packages are pinned to exact versions (a deploy never picks up a release nobody tested), and
// supabase-js is the version the app itself loads (index.html, with its integrity hash).
// Run: node tests/unit/function-imports.test.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };
const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|js)$/.test(f) ? [p] : []; });
const files = walk(path.join(root, 'supabase', 'functions'));
const imports = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/["'](npm:|https:\/\/esm\.sh\/|jsr:)(@?[^"'@]+(?:\/[^"'@]+)?)@?([^"'/]*)/g)]
  .map((m) => ({ file: path.relative(root, f), spec: m[1] + m[2], version: m[3] })));
const loose = imports.filter((i) => !/^\d+\.\d+\.\d+$/.test(i.version));
check(`every package an Edge Function imports is pinned to an exact version (${imports.length} imports)`, imports.length > 0 && loose.length === 0, loose);
const app = (readFileSync(path.join(root, 'index.html'), 'utf8').match(/@supabase\/supabase-js@(\d+\.\d+\.\d+)/) || [])[1];
const sb = imports.filter((i) => i.spec === 'npm:@supabase/supabase-js');
check(`supabase-js in the functions is the app's own version (${app})`, !!app && sb.length > 0 && sb.every((i) => i.version === app), sb.filter((i) => i.version !== app));
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
