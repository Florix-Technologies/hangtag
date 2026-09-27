// QR codes as SVG (vector, for printing stickers), using the vendored qrcode-generator library (MIT).
import qrcode from './vendor/qrcode-generator.js';
import { AppError, ERROR_CODES } from '../../shared/errors/app-error.js';

const fmt = n => String(+n.toFixed(3));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* The module matrix of text as rows of booleans (true = dark), smallest QR version that fits. ecc: "L" | "M" | "Q" | "H" */
export function qrMatrix(text, ecc = "M"){
  text = String(text ?? "");
  if(!text) throw new AppError(ERROR_CODES.VALIDATION, "There's no code to print.");
  if(!["L", "M", "Q", "H"].includes(ecc)) throw new RangeError(`qrMatrix: unknown error correction ${ecc}`);
  const qr = qrcode(0, ecc);
  qr.addData(unescape(encodeURIComponent(text)), "Byte");   // UTF-8 bytes, so any text round-trips
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/**
 * A QR code for text as an SVG string. opts (all optional):
 *   unit "mm" (default) | "cm" | "in" | "pt" | "px";  size: total width/height incl. margins (default 20 mm)
 *   margin: light modules around the symbol (default 4, the standard quiet zone);  ecc: "M" (default) | "L" | "Q" | "H"
 *   color (default "#000"), background (default "#fff", null for none)
 */
export function qrSVG(text, opts = {}){
  const m = qrMatrix(text, opts.ecc ?? "M"), n = m.length;
  const margin = opts.margin ?? 4, W = n + 2 * margin, unit = opts.unit ?? "mm", size = +(opts.size ?? 20);
  if(!(size > 0) || !(margin >= 0)) throw new RangeError("qrSVG: size must be positive and margin 0 or more");
  let d = "";
  m.forEach((row, r) => {
    for(let c = 0; c < n; c++){
      if(!row[c]) continue;
      let e = c; while(e + 1 < n && row[e + 1]) e++;          // one horizontal run per path segment
      d += `M${c + margin} ${r + margin}h${e - c + 1}v1h${-(e - c + 1)}z`;
      c = e;
    }
  });
  const bg = opts.background === null ? "" : `<rect width="${W}" height="${W}" fill="${esc(opts.background ?? "#fff")}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(size)}${unit}" height="${fmt(size)}${unit}" viewBox="0 0 ${W} ${W}" shape-rendering="crispEdges" role="img" aria-label="QR code ${esc(text)}">` +
    `${bg}<path fill="${esc(opts.color ?? "#000")}" d="${d}"/></svg>`;
}
