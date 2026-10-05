// The "barcodeScanner" port: the phone's camera (rear camera preferred) reading barcodes, QR and Data Matrix codes. Uses the
// browser's own BarcodeDetector where it has one (Android Chrome) for the formats it supports; the bundled ZXing decoder
// (vendor/zxing-decode.js, built by scripts/build-zxing.mjs, loaded only when needed) reads everything else: all formats
// on browsers without a detector (iPhone, desktop), and alongside a detector the ones it lacks — GS1 DataBar always (no
// browser detector has it), Data Matrix where the detector doesn't. Reports each code it reads as text (a GS1 code with
// its GS separators); what a code means is decided by the app (domain/catalog/gs1.js, features/sales).
import { AppError, ERROR_CODES as C } from '../../shared/errors/app-error.js';

// data_matrix: GS1 DataMatrix on medicines and food
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code", "data_matrix"];
const FRAME_MS = 120;   // time between two reads of the picture
const HARD_EVERY = 5;   // the fallback alone: a slower, more thorough search (rotated, small, light-on-dark 2D) every 5th frame
const MIXED_EVERY = 4;  // alongside the browser's detector: the fallback for the formats it lacks, every 4th frame

/* A camera error from the browser → an AppError with a plain message; details.kind: "denied" | "unavailable" | "busy" | "failed" */
export function cameraError(e){
  const n = e && e.name, make = (code, kind, msg) => new AppError(code, msg, { cause: e, details: { kind } });
  if(n === "NotAllowedError" || n === "SecurityError" || n === "PermissionDeniedError")
    return make(C.PERMISSION, "denied", "Camera permission was denied. Allow the camera for this site in the browser settings, then try again.");
  if(n === "NotFoundError" || n === "OverconstrainedError" || n === "DevicesNotFoundError")
    return make(C.NOT_CONFIGURED, "unavailable", "No camera was found on this device.");
  if(n === "NotReadableError" || n === "TrackStartError" || n === "AbortError")
    return make(C.UNKNOWN, "busy", "The camera is being used by another app. Close it and try again.");
  return make(C.UNKNOWN, "failed", "The camera couldn't start. Try again.");
}

/* The bundled decoder on the video's picture: (video, tryHarder) → text | null */
async function fallbackReader(win){
  const { decodeLuminance } = await import("./vendor/zxing-decode.js");
  const canvas = win.document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
  return (video, tryHarder) => {
    // the middle of the picture (where the frame is drawn), at most 800 px wide, as grey levels
    const vw = video.videoWidth, vh = video.videoHeight, cw = Math.round(vw * 0.9), ch = Math.round(vh * 0.6);
    const k = Math.min(1, 800 / cw), w = Math.max(1, Math.round(cw * k)), h = Math.max(1, Math.round(ch * k));
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, lum = new Uint8ClampedArray(w * h);
    for(let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    return decodeLuminance(lum, w, h, !!tryHarder);
  };
}
/* How to read codes from the video: the browser's BarcodeDetector for the formats it supports, the bundled decoder for the
   rest (all of them without a detector). { native, fallback: the formats left to the bundled decoder, read(video) } */
async function makeReader(win){
  let detect = null, supported = [];
  if(win.BarcodeDetector){
    try{
      supported = await win.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter(f => supported.includes(f));
      if(formats.length){ const d = new win.BarcodeDetector({ formats }); detect = async video => { const r = await d.detect(video); return r.length ? r[0].rawValue : null; }; }
    }catch{ detect = null; }
  }
  if(!detect){
    const read = await fallbackReader(win);
    let n = 0;
    return { native: false, fallback: ["all"], read: async video => read(video, ++n % HARD_EVERY === 0) };
  }
  const left = ["gs1_databar", "gs1_databar_expanded", ...(supported.includes("data_matrix") ? [] : ["data_matrix"])];
  let fb = null, n = 0;
  return { native: true, fallback: left, read: async video => {
    const t = await detect(video);
    if(t || ++n % MIXED_EVERY) return t;
    try{ if(!fb) fb = await fallbackReader(win); return fb(video, false); }catch{ return null; }   // never stops the browser's own reading
  } };
}

/* win: the browser window (tests pass a stand-in) */
export function createCameraScanner({ win = globalThis } = {}){
  let stream = null, timer = 0, run = 0;
  const available = () => !!(win.navigator && win.navigator.mediaDevices && typeof win.navigator.mediaDevices.getUserMedia === "function");
  const stop = () => {
    run++; win.clearTimeout(timer);
    if(stream){ stream.getTracks().forEach(t => t.stop()); stream = null; }
  };
  return {
    available,
    /* Opens the camera into `video` and calls onCode(text) for every code read (many times while one stays in view).
       Resolves once the picture shows ({ native }), or throws an AppError from cameraError(). */
    async start(video, { onCode, onError } = {}){
      stop();
      const me = ++run;
      if(!available()) throw new AppError(C.NOT_CONFIGURED, win.isSecureContext === false ? "The camera only works when the app is opened over https." : "This browser can't use a camera.", { details: { kind: "unavailable" } });
      let s;
      try{ s = await win.navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
      catch(e){ throw cameraError(e); }
      if(me !== run){ s.getTracks().forEach(t => t.stop()); return { native: false, cancelled: true }; }   // closed while asking
      stream = s;
      video.setAttribute("playsinline", ""); video.muted = true; video.srcObject = s;
      try{ await video.play(); }catch{ /* autoplay rules: the stream still shows once allowed */ }
      const reader = await makeReader(win);
      const tick = async () => {
        if(me !== run) return;
        try{
          if(video.readyState >= 2 && video.videoWidth){ const text = await reader.read(video); if(text && me === run) onCode(text); }
        }catch(e){ if(onError) onError(e); }
        if(me === run) timer = win.setTimeout(tick, FRAME_MS);
      };
      tick();
      return { native: reader.native, fallback: reader.fallback };
    },
    stop,
  };
}
