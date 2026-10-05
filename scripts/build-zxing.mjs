// Builds src/infrastructure/scanner/vendor/zxing-decode.js: the barcode decoder the camera uses when the browser has no
// BarcodeDetector for a format (iPhones, desktop browsers, and GS1 DataBar everywhere). Reproducible from the
// @zxing/library devDependency with esbuild (also a devDependency); nothing is loaded from the network at run time.
//   npm run build:zxing
// Included readers: the 1D retail ones (EAN-13/8, UPC-A/E, Code 128, Code 39, ITF), GS1 DataBar (RSS-14) and DataBar
// Expanded (RSS Expanded), QR Code and Data Matrix (GS1 DataMatrix on medicines and food). Only the core decoding files
// are bundled (deep ESM imports), minified.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'node_modules', '@zxing', 'library');
const OUT = path.join(ROOT, 'src', 'infrastructure', 'scanner', 'vendor', 'zxing-decode.js');
const version = JSON.parse(fs.readFileSync(path.join(LIB, 'package.json'), 'utf8')).version;
const core = (p) => '@zxing/library/esm/core/' + p + '.js';

const ENTRY = `
import BarcodeFormat from '${core('BarcodeFormat')}';
import BinaryBitmap from '${core('BinaryBitmap')}';
import DecodeHintType from '${core('DecodeHintType')}';
import HybridBinarizer from '${core('common/HybridBinarizer')}';
import RGBLuminanceSource from '${core('RGBLuminanceSource')}';
import InvertedLuminanceSource from '${core('InvertedLuminanceSource')}';
import MultiFormatOneDReader from '${core('oned/MultiFormatOneDReader')}';
import QRCodeReader from '${core('qrcode/QRCodeReader')}';
import DataMatrixReader from '${core('datamatrix/DataMatrixReader')}';

const F = BarcodeFormat;
const ONE_D = [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.RSS_14, F.RSS_EXPANDED];
const HINTS = new Map([[DecodeHintType.POSSIBLE_FORMATS, ONE_D]]);
const HARD = new Map([...HINTS, [DecodeHintType.TRY_HARDER, true]]);
// ZXing's DataBar Expanded reader announces on the console that it "is not ready for production yet" (its authors' own
// caveat, kept in the app's documentation): the reader is used, the console line is not printed in the shop's app.
const quiet = console.log; console.log = () => {};
let oneD;
try { oneD = new MultiFormatOneDReader(HINTS); } finally { console.log = quiet; }
const qr = new QRCodeReader(), dm = new DataMatrixReader();
const NAMES = { [F.EAN_13]: 'ean_13', [F.EAN_8]: 'ean_8', [F.UPC_A]: 'upc_a', [F.UPC_E]: 'upc_e', [F.CODE_128]: 'code_128', [F.CODE_39]: 'code_39',
  [F.ITF]: 'itf', [F.RSS_14]: 'gs1_databar', [F.RSS_EXPANDED]: 'gs1_databar_expanded', [F.QR_CODE]: 'qr_code', [F.DATA_MATRIX]: 'data_matrix' };
function attempt(readers, bitmap, hints){
  for (const r of readers) {
    try { const res = r.decode(bitmap, hints); return { text: res.getText(), format: NAMES[res.getBarcodeFormat()] || 'unknown' }; }
    catch (e) { /* not this one */ }
    finally { if (typeof r.reset === 'function') r.reset(); }
  }
  return null;
}
/* Grey levels (one byte per pixel) → { text, format } or null. 1D first (the till's everyday codes, fastest), then QR, then
   Data Matrix; with tryHarder a more thorough 2D search and light-on-dark 2D codes. */
export function decodeLuminanceResult(lum, width, height, tryHarder) {
  const src = new RGBLuminanceSource(lum, width, height), bitmap = new BinaryBitmap(new HybridBinarizer(src));
  // 1D always with the quick search (its thorough search rescans the whole frame both ways: far too slow for a camera)
  const hit = attempt([oneD], bitmap, HINTS) || attempt([qr, dm], bitmap, tryHarder ? HARD : HINTS);
  if (hit || !tryHarder) return hit;
  return attempt([qr, dm], new BinaryBitmap(new HybridBinarizer(new InvertedLuminanceSource(src))), HARD);
}
export function decodeLuminance(lum, width, height, tryHarder) {
  const r = decodeLuminanceResult(lum, width, height, tryHarder);
  return r ? r.text : null;
}
export const FALLBACK_FORMATS = Object.freeze(Object.values(NAMES));
`;

const tmp = path.join(ROOT, 'node_modules', '.cache', 'hangtag-zxing');
fs.mkdirSync(tmp, { recursive: true });
const entry = path.join(tmp, 'entry.mjs');
fs.writeFileSync(entry, ENTRY);
const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', minify: true, write: false, platform: 'browser', target: ['es2019'],
  nodePaths: [path.join(ROOT, 'node_modules')], legalComments: 'none', logLevel: 'warning' });
const code = result.outputFiles[0].text;
const header = `// Barcode/QR decoding for browsers without BarcodeDetector (or without one for a format): a bundle of ZXing ("zebra
// crossing") for JavaScript, @zxing/library ${version} (https://github.com/zxing-js/library), Apache License 2.0.
// Readers: EAN-13/8, UPC-A/E, Code 128, Code 39, ITF, GS1 DataBar (RSS-14) and DataBar Expanded, QR Code, Data Matrix.
// Built by scripts/build-zxing.mjs (npm run build:zxing) with esbuild from the package's ESM files — do not edit by hand.
// Exports: decodeLuminance(lum, width, height, tryHarder) → text | null; decodeLuminanceResult(…) → { text, format } | null;
// FALLBACK_FORMATS (the format names it reads).
`;
const before = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
fs.writeFileSync(OUT, header + code);
console.log(`zxing-decode.js: ${(before / 1024).toFixed(1)} KB → ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB (@zxing/library ${version})`);
