// GS1 DataMatrix (and the rest) without depending on the browser's own BarcodeDetector: the bundled ZXing decoder
// (src/infrastructure/scanner/vendor/zxing-decode.js, built by scripts/build-zxing.mjs) reads a GS1 DataMatrix printed by
// a real encoder (@zxing/library's DataMatrixWriter with the GS1 format: FNC1 first, GS between variable fields) — also
// rotated and light-on-dark — and the app's GS1 parser gets the GTIN, batch, expiry, serial and weight from what it reads.
// The everyday 1D path stays fast. The camera scanner uses the browser's detector for what it supports and the fallback
// for what it lacks (Data Matrix where missing, GS1 DataBar always). 1D and QR decoding: tests/unit/scan.test.mjs.
// GS1 DataBar: the readers are bundled, but @zxing/library 0.23 has no DataBar writer and no fixture image is generated
// here (see the report at the end of this file); its RSS Expanded reader is marked experimental by ZXing itself.
// Run: node tests/unit/zxing-fallback.test.mjs
import zxing from '@zxing/library';
import { FALLBACK_FORMATS, decodeLuminance, decodeLuminanceResult } from '../../src/infrastructure/scanner/vendor/zxing-decode.js';
import { createCameraScanner } from '../../src/infrastructure/scanner/camera-scanner.js';
import { parseGs1 } from '../../src/domain/catalog/gs1.js';
import fs from 'node:fs';

const { DataMatrixWriter, EncodeHintType, BarcodeFormat } = zxing;
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };
const GS = '\u001d';

/* A Data Matrix symbol as grey levels: module scale, quiet zone, optional 90° turn and light-on-dark */
function dmLum(text, { scale = 6, quiet = 4, rotate = false, invert = false, gs1 = true } = {}) {
  const m = new DataMatrixWriter().encode(text, BarcodeFormat.DATA_MATRIX, 0, 0, new Map([[EncodeHintType.GS1_FORMAT, gs1]]));
  const n = m.getWidth(), mh = m.getHeight(), W = (n + 2 * quiet) * scale, H = (mh + 2 * quiet) * scale;
  const dark = invert ? 235 : 20, light = invert ? 20 : 235, lum = new Uint8ClampedArray(W * H).fill(light);
  for (let y = 0; y < mh; y++) for (let x = 0; x < n; x++) if (m.get(x, y)) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      let px = (x + quiet) * scale + dx, py = (y + quiet) * scale + dy;
      if (rotate) [px, py] = [W - 1 - py, px];   // a square symbol: W === H
      lum[py * W + px] = dark;
    }
  }
  return { lum, w: W, h: H };
}

console.log('=== GS1 DataMatrix through the fallback decoder ===');
{
  const text = '0109501101530003' + '17261231' + '10ABC123' + GS + '21SN42';
  const d = dmLum(text), r = decodeLuminanceResult(d.lum, d.w, d.h, false);
  check('a GS1 DataMatrix is read as Data Matrix, with its GS separators', r && r.format === 'data_matrix' && r.text === text, r);
  const g = parseGs1(r && r.text);
  check('…and parsed: GTIN, batch, expiry, serial', g && g.gtin === '09501101530003' && g.batch === 'ABC123' && g.expiry === '2026-12-31' && g.serial === 'SN42', g);
  const rot = dmLum(text, { rotate: true }), rr = decodeLuminance(rot.lum, rot.w, rot.h, false);
  check('turned 90° (held sideways): still read', rr === text, rr);
  const inv = dmLum(text, { invert: true });
  check('light-on-dark (printed on a dark box): read on the thorough pass (tryHarder)', decodeLuminance(inv.lum, inv.w, inv.h, true) === text);
  const small = dmLum(text, { scale: 3 }), rs = decodeLuminance(small.lum, small.w, small.h, false);
  check('small (3 px per module): read', rs === text, rs);
  const weighed = '0102000123456782' + '3103001250' + '15270131';   // net weight 1.250 kg, best before 31 Jan 2027
  const wd = dmLum(weighed), wr = decodeLuminance(wd.lum, wd.w, wd.h, false), wg = parseGs1(wr);
  check('weighed goods: GTIN, net weight (AI 3103: 1.250 kg) and best-before come through', wr === weighed && wg && wg.gtin === '02000123456782' && wg.netWeightKg === 1.25 && wg.bestBefore === '2027-01-31', { wr, wg });
  const plain = dmLum('PART-77/A', { gs1: false });
  check('a plain (non-GS1) Data Matrix reads as its text and is not taken for GS1', decodeLuminance(plain.lum, plain.w, plain.h, false) === 'PART-77/A' && parseGs1('PART-77/A') === null);
}

console.log('=== what the bundle reads, and speed ===');
{
  check('the fallback reads EAN/UPC, Code 128/39, ITF, QR, Data Matrix and GS1 DataBar (incl. Expanded)',
    ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix', 'gs1_databar', 'gs1_databar_expanded'].every((f) => FALLBACK_FORMATS.includes(f)), FALLBACK_FORMATS);
  const W = 800, H = 480, blank = new Uint8ClampedArray(W * H).fill(200);
  for (let i = 0; i < 3; i++) decodeLuminance(blank, W, H, false);   // warm up
  let t0 = performance.now(); for (let i = 0; i < 10; i++) decodeLuminance(blank, W, H, false); const fast = (performance.now() - t0) / 10;
  t0 = performance.now(); for (let i = 0; i < 5; i++) decodeLuminance(blank, W, H, true); const hard = (performance.now() - t0) / 5;
  console.log(`  an empty 800×480 frame: ${fast.toFixed(1)} ms per read (every frame), ${hard.toFixed(1)} ms with tryHarder (every 5th)`);
  check('an empty camera frame costs well under the 120 ms between frames', fast < 120, fast);
  check('…and the thorough pass (every 5th frame) stays under 250 ms', hard < 250, hard);
  const bundle = fs.statSync(new URL('../../src/infrastructure/scanner/vendor/zxing-decode.js', import.meta.url)).size;
  check('the bundle stays lean (under 260 KB; loaded only when a fallback is needed)', bundle < 260 * 1024, bundle);
  check('no network code in the bundle (no fetch / import())', !/\bfetch\(|import\(/.test(fs.readFileSync(new URL('../../src/infrastructure/scanner/vendor/zxing-decode.js', import.meta.url), 'utf8')));
}

console.log('=== the camera scanner: native and fallback paths ===');
{
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const DM = '0109501101530003' + '10LOT9' + GS + '21X1';
  const frame = dmLum(DM, { scale: 4 });
  // a stand-in canvas that "draws" the test frame (the scanner turns it into grey levels)
  const canvas = () => ({ width: 0, height: 0, getContext: () => ({
    drawImage() {},
    getImageData: (x, y, w, h) => { const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const yy = Math.floor(i / w), xx = i % w;
      const v = yy < frame.h && xx < frame.w ? frame.lum[yy * frame.w + xx] : 235; data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; } return { data }; } }) });
  const win = (Detector) => ({ setTimeout, clearTimeout, isSecureContext: true, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    document: { createElement: canvas }, ...(Detector ? { BarcodeDetector: Detector } : {}) });
  const video = () => ({ readyState: 4, videoWidth: frame.w / 0.9 | 0, videoHeight: frame.h / 0.6 | 0, setAttribute() {}, play: async () => {}, srcObject: null });
  // 1. a browser whose detector reads Data Matrix: its own reading is used (its GS1 text reaches the parser as it is)
  class WithDM { static async getSupportedFormats() { return ['ean_13', 'qr_code', 'data_matrix']; } async detect() { return [{ rawValue: DM }]; } }
  let got = [], sc = createCameraScanner({ win: win(WithDM) });
  let r = await sc.start(video(), { onCode: (t) => got.push(t) }); await tick(400); sc.stop();
  check('native path: the browser reads the GS1 DataMatrix itself; only DataBar is left to the fallback', r.native === true && got[0] === DM && JSON.stringify(r.fallback) === '["gs1_databar","gs1_databar_expanded"]', { r, got: got.slice(0, 2) });
  check('…and the GS1 parser reads what the browser gave', parseGs1(got[0]).batch === 'LOT9' && parseGs1(got[0]).serial === 'X1');
  // 2. a detector without Data Matrix (e.g. 1D only): the fallback reads the Data Matrix alongside it
  class OneDOnly { static async getSupportedFormats() { return ['ean_13', 'code_128']; } async detect() { return []; } }
  got = []; sc = createCameraScanner({ win: win(OneDOnly) });
  r = await sc.start(video(), { onCode: (t) => got.push(t) }); await tick(1500); sc.stop();
  check('mixed path: a detector without Data Matrix → the fallback reads it (every few frames)', r.native === true && r.fallback.includes('data_matrix') && got.includes(DM), { r, got: got.slice(0, 2) });
  // 3. no detector at all (iPhone Safari, desktop Firefox): the fallback reads everything
  got = []; sc = createCameraScanner({ win: win(null) });
  r = await sc.start(video(), { onCode: (t) => got.push(t) }); await tick(600); sc.stop();
  check('fallback path: no detector → the bundled decoder reads the GS1 DataMatrix', r.native === false && got[0] === DM, { r, got: got.slice(0, 2) });
}

// GS1 DataBar fixtures: @zxing/library 0.23 ships RSS14Reader / RSSExpandedReader but no DataBar writer, and no other
// encoder is a dependency of this project; drawing DataBar by hand needs the full GS1 DataBar encoding (widths from the
// combinatorial "element widths" algorithm, checksum, finder patterns) — a second barcode library in itself. So DataBar
// decoding is included in the bundle and listed above, but not proven here with a generated image.
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
