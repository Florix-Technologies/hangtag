// UploadProductImage: a phone photo or gallery picture becomes the small square product photo.
import { use } from '../../../shared/di/services.js';

/* A 320-pixel square JPEG data URL of the photo's centre (saved with the product) */
export const photoFromFile = file => use("files").fileToThumb(file, 320);
