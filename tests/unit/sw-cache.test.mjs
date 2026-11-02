// The service worker's cache name is the same on every checkout of a commit. Git checks text files out with CRLF on
// Windows (core.autocrlf) and LF on Linux, macOS and Vercel's build machines, and editors save either. While the build
// hashed the raw bytes, a fresh clone said "sw.js is out of date" with nothing changed (scripts/sw-cache.mjs).
// Run: npm run test:unit
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheVersion, shellFiles, sortFiles, toUrl } from '../../scripts/sw-cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}

// The same files as git would check them out: text with LF (Linux, macOS) or CRLF (a fresh Windows clone); pictures
// (a NUL byte, git's own test for binary) exactly as they are.
const files = shellFiles(ROOT);
const disk = new Map(files.map((f) => [f, readFileSync(f)]));
const binary = (b) => b.subarray(0, 8000).includes(0);
const bytes = (b, from, to) => Buffer.from(b.toString('latin1').replace(from, to), 'latin1');
const lf = (b) => (binary(b) ? b : bytes(b, /\r\n/g, '\n'));
const crlf = (b) => (binary(b) ? b : bytes(lf(b), /\n/g, '\r\n'));
const as = (convert) => (f) => convert(disk.get(f));

const recorded = /const CACHE = "hangtag-([0-9a-f]{10})"/.exec(readFileSync(path.join(ROOT, 'sw.js'), 'utf8'))[1];
const here = cacheVersion(ROOT, files, as((b) => b));
const unix = cacheVersion(ROOT, files, as(lf));
const windows = cacheVersion(ROOT, files, as(crlf));
const texts = files.filter((f) => !binary(disk.get(f)));
check('the LF and CRLF checkouts really differ byte for byte (the check below means something)',
  texts.filter((f) => !lf(disk.get(f)).equals(crlf(disk.get(f)))).length > 100, texts.length);
check('a Linux / macOS / Vercel checkout (LF) computes the cache name sw.js carries', unix === recorded, { unix, recorded });
check('a fresh Windows checkout (CRLF) computes the cache name sw.js carries', windows === recorded, { windows, recorded });
check('this working tree computes it too', here === recorded, { here, recorded });

// Normalising line endings must not hide real changes
const page = files.find((f) => f.endsWith('index.html'));
check('a real change to a file still changes the cache name', cacheVersion(ROOT, files, (f) => (f === page ? Buffer.concat([disk.get(f), Buffer.from('<!-- -->')]) : disk.get(f))) !== here);
const png = files.find((f) => f.endsWith('.png'));
check('a picture is hashed byte for byte (the CRLF in a PNG\'s signature is data, not a line ending)',
  binary(disk.get(png)) && disk.get(png).includes('\r\n') && cacheVersion(ROOT, files, (f) => (f === png ? bytes(disk.get(f), /\r\n/g, '\n') : disk.get(f))) !== here, png);

// The order is part of the hash and of sw.js: by URL, not by the system's path (Windows' "\" sorts after digits and
// capitals, "/" before them, so "src/ui/" and "src/ui2/" would swap places between Windows and Linux)
const order = sortFiles(ROOT, ['src/uiB.css', 'src/ui2/b.js', 'src/ui/a.js'].map((r) => path.join(ROOT, ...r.split('/')))).map((p) => toUrl(ROOT, p));
check('files are ordered by URL on every system', JSON.stringify(order) === JSON.stringify(['./src/ui/a.js', './src/ui2/b.js', './src/uiB.css']), order);
const urls = files.map((f) => toUrl(ROOT, f)).filter((u) => u.startsWith('./src/'));
check('the app\'s modules and stylesheets are listed in URL order', urls.every((u, i) => i === 0 || urls[i - 1] < u), urls.length);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
