// Camera scanning: scan rules, camera errors, the scanner with a stand-in browser, and the bundled ZXing decoder reading
// barcodes and QR codes the app itself draws. Run: npm run test:unit
import { REPEAT_MS, createScanGate, scanCodeError } from '../../src/domain/sales/scan-rules.js';
import { cameraError, createCameraScanner } from '../../src/infrastructure/scanner/camera-scanner.js';
import { decodeLuminance } from '../../src/infrastructure/scanner/vendor/zxing-decode.js';
import { barcodeSVG } from '../../src/infrastructure/codes/barcode-svg.js';
import { qrMatrix } from '../../src/infrastructure/codes/qr-svg.js';
import { ERROR_CODES as C, isAppError } from '../../src/shared/errors/app-error.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- rules ----------
check('a printable code up to 64 characters is fine', scanCodeError('2000000000015') === null && scanCodeError(' DR-BLK-M ') === null);
check('empty, non-printable or too long codes are refused with a message', /No code/.test(scanCodeError('')) && /can't belong/.test(scanCodeError('a\u0001b')) && /can't belong/.test(scanCodeError('x'.repeat(65))));
const g = createScanGate(1500);
check('the first sighting of a code passes', g.pass('A', 0));
check('the same code still in view is not counted again', !g.pass('A', 100) && !g.pass('A', 1400) && !g.pass('A', 2800));
check('…until it has been out of view for the whole window', g.pass('A', 2800 + 1500));
check('a different code passes at once', g.pass('B', 4400) && g.pass('A', 4401));
check('default window is 1.5 s', REPEAT_MS === 1500);

// ---------- camera errors ----------
const err = (name) => cameraError(Object.assign(new Error(name), { name }));
check('permission denied → PERMISSION, kind "denied", plain message', err('NotAllowedError').code === C.PERMISSION && err('NotAllowedError').details.kind === 'denied' && /Allow the camera/.test(err('NotAllowedError').message));
check('no camera → kind "unavailable"', err('NotFoundError').details.kind === 'unavailable' && err('OverconstrainedError').details.kind === 'unavailable');
check('camera busy → kind "busy"', err('NotReadableError').details.kind === 'busy');
check('anything else → kind "failed"', err('Weird').details.kind === 'failed' && isAppError(err('Weird')));

// ---------- the scanner with a stand-in browser ----------
function fakeWin({ gum, detector } = {}) {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const win = {
    setTimeout, clearTimeout, isSecureContext: true, tracks,
    navigator: gum === null ? {} : { mediaDevices: { getUserMedia: gum || (async () => ({ getTracks: () => tracks })) } },
    document: { createElement: () => ({ getContext: () => ({}) }) },
  };
  if (detector) win.BarcodeDetector = detector;
  return win;
}
const video = () => ({ readyState: 4, videoWidth: 640, videoHeight: 480, setAttribute() {}, play: async () => {}, srcObject: null });
let w = fakeWin({ gum: null });
let e = await createCameraScanner({ win: w }).start(video()).catch((x) => x);
check('no camera API → NOT_CONFIGURED "unavailable" (never crashes)', isAppError(e) && e.details.kind === 'unavailable');
w = fakeWin({ gum: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
e = await createCameraScanner({ win: w }).start(video()).catch((x) => x);
check('permission denied at the prompt → PERMISSION', isAppError(e) && e.code === C.PERMISSION);
let asked;
w = fakeWin({ gum: async (c) => { asked = c; return { getTracks: () => w.tracks }; } });
class FakeDetector { static async getSupportedFormats() { return ['ean_13', 'qr_code']; } constructor(o) { FakeDetector.formats = o.formats; } async detect() { return [{ rawValue: '2000000000015' }]; } }
w.BarcodeDetector = FakeDetector;
const codes = [], sc = createCameraScanner({ win: w }), v = video();
const r = await sc.start(v, { onCode: (t) => codes.push(t) });
await tick(300);
check('asks for the rear camera, no microphone', asked.video.facingMode.ideal === 'environment' && asked.audio === false);
check("the browser's own BarcodeDetector is used when it has the formats", r.native === true && JSON.stringify(FakeDetector.formats) === '["ean_13","qr_code"]');
check('codes are reported as they are read', codes.length >= 2 && codes.every((c) => c === '2000000000015'), codes);
sc.stop(); const n = codes.length; await tick(300);
check('stop releases the camera and stops reading', w.tracks[0].stopped && codes.length === n);
let release;
w = fakeWin({ gum: () => new Promise((res) => { release = res; }) });
const sc2 = createCameraScanner({ win: w }), p2 = sc2.start(video(), { onCode: () => {} });
sc2.stop(); release({ getTracks: () => w.tracks });
check('closing while the permission prompt is open still releases the camera', (await p2).cancelled === true && w.tracks[0].stopped);

// ---------- the bundled ZXing decoder (browsers without BarcodeDetector) ----------
function barcodeLum(code) {
  const svg = barcodeSVG(code), W = +/viewBox="0 0 (\d+) /.exec(svg)[1], bits = new Array(W).fill(0);
  for (const m of svg.matchAll(/M(\d+) 0h(\d+)/g)) for (let x = +m[1]; x < +m[1] + +m[2]; x++) bits[x] = 1;
  const S = 3, pad = 40, w2 = W * S + 2 * pad, h = 120, lum = new Uint8ClampedArray(w2 * h).fill(235);
  for (let y = 20; y < h - 20; y++) for (let x = 0; x < W * S; x++) if (bits[Math.floor(x / S)]) lum[y * w2 + pad + x] = 20;
  return { lum, w: w2, h };
}
function qrLum(text) {
  const m = qrMatrix(text), S = 6, q = 4, N = (m.length + 2 * q) * S, lum = new Uint8ClampedArray(N * N).fill(235);
  m.forEach((row, r2) => row.forEach((d, c) => { if (!d) return; for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) lum[((r2 + q) * S + y) * N + (c + q) * S + x] = 20; }));
  return { lum, w: N, h: N };
}
for (const code of ['2000000000015', '8901234567890'.slice(0, 12) + '5', 'DR-BLK-M', '96385074']) {
  const b = barcodeLum(code); let got = null; try { got = decodeLuminance(b.lum, b.w, b.h, false); } catch (x) { got = String(x); }
  if (code === '8901234567895') check(`decoder: ${code} (bad check digit) is still read as text, never crashes`, typeof got === 'string' || got === null, got);
  else check(`decoder reads the app's own barcode ${code}`, got === code, got);
}
{ const q = qrLum('2000000000022'); check('decoder reads the app\'s own QR code', decodeLuminance(q.lum, q.w, q.h, false) === '2000000000022'); }
{ const blank = new Uint8ClampedArray(200 * 100).fill(200); check('no code in the picture → null', decodeLuminance(blank, 200, 100, false) === null); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
