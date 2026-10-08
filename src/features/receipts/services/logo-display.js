// The logo every bill and document carries (Settings → Bills & Documents → Logo): the shop's picture, or none when the shop
// switched it off, and where it sits on each output — the A4 documents' header, the receipt (80 mm on screen, the image,
// the thermal print). "Auto" keeps each output's own place (left on an A4 header, centred on a receipt).
import { store } from '../../../shared/state/store.js';
import { logoDisplayOf, logoPlace } from '../../../domain/documents/doc-settings.js';

/* The picture to print now ("" when there is none, or the shop hid it) */
export const documentLogo = () => logoDisplayOf(store.settings).show ? (store.logo || "") : "";
/* Where it goes on an output: "a4" or "receipt" → "left" | "center" | "right" */
export const documentLogoPlace = (output) => logoPlace(logoDisplayOf(store.settings), output);
