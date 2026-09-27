// Barcodes and QR codes: check digits, in-store code generation, symbol choice, and a round trip — every SVG we draw is
// rasterised and read back by independent decoders (ZXing for EAN/UPC/Code 128, jsQR for QR).
// Run: npm run test:unit
import zxing from '@zxing/library';
import jsQR from 'jsqr';
import { cleanCode, codeError, ean13CheckDigit, generateEan13, isValidEan13, isValidEan8, isValidUpcA, symbologyFor } from '../../src/domain/catalog/barcode.js';
import { barcodeSVG, code128Values } from '../../src/infrastructure/codes/barcode-svg.js';
import { qrMatrix, qrSVG } from '../../src/infrastructure/codes/qr-svg.js';
import { isAppError } from '../../src/shared/errors/app-error.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ---------- check digits and validation ----------
check('EAN-13 check digit of a real code (4006381333931)', String(ean13CheckDigit('400638133393')) === '1' && isValidEan13('4006381333931'));
check('a wrong EAN-13 check digit is invalid', !isValidEan13('4006381333932'));
check('UPC-A (036000291452) and EAN-8 (96385074) validate', isValidUpcA('036000291452') && isValidEan8('96385074') && !isValidEan8('96385075'));
check('symbol choice: EAN-13 / UPC-A / EAN-8 / anything else Code 128',
  symbologyFor('4006381333931') === 'ean13' && symbologyFor('036000291452') === 'upca' && symbologyFor('96385074') === 'ean8'
  && symbologyFor('DR-BLK-M') === 'code128' && symbologyFor('4006381333932') === 'code128');
check('no symbol for empty, non-printable or too long codes', symbologyFor('') === null && symbologyFor('aé') === null && symbologyFor('x'.repeat(65)) === null);
check('codeError: a typo in the last EAN digit is caught, with the right digit', /should be 1/.test(codeError('4006381333932') || ''));
check('codeError: free text and empty are fine', codeError('DR-BLK-M') === null && codeError('') === null && codeError('  ') === null);
check('cleanCode trims and caps at 64', cleanCode('  AB  ') === 'AB' && cleanCode('x'.repeat(80)).length === 64);

// ---------- generation ----------
let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const g1 = generateEan13([], rand);
check('a generated code is a valid in-store EAN-13 (prefix 20)', /^20\d{11}$/.test(g1) && isValidEan13(g1), g1);
seed = 7; const g2 = generateEan13(new Set([g1]), rand);
check('generation never reuses a code already taken', g2 !== g1 && isValidEan13(g2), [g1, g2]);
const zeros = () => 0, taken = new Set();
for (let i = 0; i < 50; i++) taken.add(generateEan13(taken, zeros));
check('generation always finishes, even when random picks keep colliding (50 unique codes)', taken.size === 50 && [...taken].every(isValidEan13));

// ---------- barcodes: draw → rasterise → decode ----------
const { MultiFormatOneDReader, RGBLuminanceSource, BinaryBitmap, HybridBinarizer, DecodeHintType, BarcodeFormat } = zxing;
function barsFromSvg(svg) {
  const W = +/viewBox="0 0 (\d+) /.exec(svg)[1];
  const bits = new Array(W).fill(0);
  for (const m of svg.matchAll(/M(\d+) 0h(\d+)/g)) for (let x = +m[1]; x < +m[1] + +m[2]; x++) bits[x] = 1;
  return bits;
}
function decode1D(svg) {
  const bits = barsFromSvg(svg), S = 3, w = bits.length * S, h = 40, lum = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum[y * w + x] = bits[Math.floor(x / S)] ? 0 : 255;
  const hints = new Map([[DecodeHintType.TRY_HARDER, true], [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.CODE_128]]]);
  const r = new MultiFormatOneDReader(hints).decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, w, h))), hints);
  return { text: r.getText(), format: BarcodeFormat[r.getBarcodeFormat()] };
}
const cases = [
  ['4006381333931', 'EAN_13'], [g1, 'EAN_13'], ['96385074', 'EAN_8'], ['036000291452', 'UPC_A'],
  ['DR-BLK-M', 'CODE_128'], ['1234567890', 'CODE_128'], ['SKU 42/a', 'CODE_128'], ['AB1234567890CD', 'CODE_128'],
];
for (const [code, format] of cases) {
  let got; try { got = decode1D(barcodeSVG(code)); } catch (e) { got = { error: String(e) }; }
  // ZXing reports a UPC-A as EAN-13 with a leading 0 unless asked otherwise
  const ok = got.text === code ? got.format === format : format === 'UPC_A' && got.text === '0' + code;
  check(`barcode ${code} decodes back as ${format}`, ok, got);
}
check('Code 128 packs even digit runs in code set C (10 digits → start C + 5 values + check + stop)', code128Values('1234567890').length === 8 && code128Values('1234567890')[0] === 105);
const svg = barcodeSVG('4006381333931');
check('barcode SVG is vector and print-crisp, sized in mm', /^<svg[^>]+width="[\d.]+mm"[^>]+shape-rendering="crispEdges"/.test(svg) && /<text/.test(svg));
check('barcode without digits when text:false', !/<text/.test(barcodeSVG('4006381333931', { text: false })));
const bad = throws(() => barcodeSVG(''));
check('no code → a plain AppError, not a crash', isAppError(bad) && /no code/.test(bad.message));

// ---------- QR: draw → rasterise → decode ----------
function decodeQR(svgText) {
  const W = +/viewBox="0 0 (\d+) /.exec(svgText)[1], S = 6, w = W * S, data = new Uint8ClampedArray(w * w * 4).fill(255);
  for (const m of svgText.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
    const x0 = +m[1], y0 = +m[2], len = +m[3];
    for (let y = y0 * S; y < (y0 + 1) * S; y++) for (let x = x0 * S; x < (x0 + len) * S; x++) { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  }
  const r = jsQR(data, w, w);
  return r && r.data;
}
for (const text of [g1, 'DR-BLK-M', 'https://example.com/p?id=42&v=Black%20M', 'Kurta – Maroon / XL ₹1,299']) {
  check(`QR "${text}" decodes back exactly`, decodeQR(qrSVG(text)) === text, decodeQR(qrSVG(text)));
}
check('QR has the standard 4-module quiet zone and a square matrix', (() => { const m = qrMatrix('A'); return m.length === 21 && m.every((r) => r.length === 21) && /viewBox="0 0 29 29"/.test(qrSVG('A')); })());
check('QR SVG size in the given unit', /width="30mm" height="30mm"/.test(qrSVG('A', { size: 30 })) && /width="1in"/.test(qrSVG('A', { size: 1, unit: 'in' })));
check('QR of empty text → a plain AppError', isAppError(throws(() => qrSVG(''))));
check('QR text is escaped in the SVG label', !/<script/.test(qrSVG('<script>')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
