// Port contracts: what features and shared code need from outside, by name. app/container.js provides the implementations
// through ./services.js (provide/use); unit tests provide fakes with the same shape (override).
// Documentation only: nothing here runs.

/**
 * "storage": this device's key/value storage. Implementation: infrastructure/storage/local-storage.js (LS, over localStorage).
 * Values are JSON-encoded under the given key; the raw methods read and write the stored strings as they are.
 * Reach it through shared/state/persistence.js (`storage` and the state-slice savers), not directly.
 * @typedef {Object} StoragePort
 * @property {(key: string, fallback?: any) => any} get          The stored value, or `fallback` when missing or unreadable. Never throws.
 * @property {(key: string, value: any) => boolean} set          Store `value` as JSON. Returns false when refused (storage full or blocked). Never throws.
 * @property {(key: string) => (string|null)} getRaw             The stored string, or null when missing. Throws when storage is blocked.
 * @property {(key: string, value: string) => void} setRaw       Store a string as it is. Throws when storage is full or blocked.
 * @property {(key: string) => void} remove                      Remove a key. Throws when storage is blocked.
 */

/**
 * "files": files in and out of the browser. Implementation: infrastructure/browser/files.js.
 * @typedef {Object} FilesPort
 * @property {(name: string, data: (Blob|string), type: string) => Promise<boolean>} saveFile
 *   Download `data` as a file called `name`. Resolves false when that failed (the user has been told with a toast).
 * @property {(file: File, size: number) => Promise<string>} fileToThumb
 *   A square JPEG data URL of the photo's centre, `size` pixels wide. Rejects when the file isn't a readable image.
 */

/**
 * "renderer": the app shell's rendering. Implementation: app/navigation.js (provided by installNavigation() at start-up).
 * Reach it through shared/ui/render.js (renderAll, setTab), so features never import app/.
 * @typedef {Object} RendererPort
 * @property {() => void} renderAll        Redraw the open page, the tab bar, the sync pill and any open sheet.
 * @property {(tab: string) => void} setTab  Switch to "sell" | "stock" | "report" | "products" (saved in prefs), then redraw.
 */

/**
 * "session": leave or enter the app after sign-in. Implementation: features/auth/services/session.js (signOut, enterApp),
 * provided by app/container.js. Reach it through shared/ui/session-actions.js (requestSignOut, requestEnterApp), so the
 * account menu and shop setup don't import the sign-in module (that would be an import cycle).
 * @typedef {Object} SessionPort
 * @property {() => Promise<void>} signOut                  Sign out on this device (local data is kept per account).
 * @property {(firstTime: boolean) => Promise<void>} enterApp  Show the app after sign-in and shop setup, then connect and sync.
 */

/**
 * "cloud": every Supabase call the app makes. Implementation: infrastructure/supabase/cloud-gateway.js
 * (createCloudGateway({ getClient, url, key, storageKey })), provided by app/container.js. The client is read on every call.
 * Upload and download methods throw an AppError (shared/errors/app-error.js) made by infrastructure/supabase/errors.js;
 * auth and profile methods return supabase-js results ({ data, error }) as they are.
 * @typedef {Object} CloudPort
 * @property {() => any} createClient                        A new supabase-js client with this app's settings.
 * @property {Object} auth                                   getSession, onAuthStateChange, signInWithOAuth, signInWithPassword, signUp,
 *   resend, resetPasswordForEmail, updateUser, verifyOtp, signOut (supabase-js auth), and settings() (the project's enabled providers).
 * @property {(email: string) => Promise<any>} signInMethods  Which sign-in methods an email address has (RPC hangtag_sign_in_methods).
 * @property {() => Promise<{error: (AppError|null)}>} checkSchema  OUTDATED_DATABASE when schema.sql has not been run.
 * @property {(handlers: Object, onStatus: Function) => any} subscribe  Live updates per table (sale, saleLine, catalog, image, move,
 *   returns, customers, settings); returns the channel for removeChannel().
 * @property {Object} records                                Row → app record converters for live updates (toSale, toSaleLine, toMove).
 * @property {Function} saveSale  Also: setSaleVoid, saveProduct(p, index), deleteVariants, deleteProduct, saveImage, saveMove,
 *   saveReturn, saveCustomer, saveSettings, saveAllSales. Used by the outbox (features/sync/services/outbox.js) only.
 * @property {Function} fetchProducts  Also: fetchVariants, fetchImages, fetchMoves, fetchReturns, fetchCustomers, fetchSettings,
 *   fetchSales, fetchSaleLineRows. Used by downloads (features/sync/services/pull.js).
 * @property {Function} getProfile  Also: createProfile, updateProfile, saveProfile (the hangtag_profiles row of the signed-in user).
 */

/**
 * "productRepository": products and their photos. Implementation: infrastructure/repositories/local-first-product-repository.js
 * (local state + this device's storage first, then queued for upload), provided by app/container.js.
 * Reach it through features/products/repositories/product-repository.js.
 * @typedef {Object} ProductRepositoryPort
 * @property {() => Object[]} list                            All products (archived ones too).
 * @property {(id: string) => (Object|undefined)} get
 * @property {(change: {product: Object, isNew: boolean, renamed: boolean, newMoves: Object[], deletedVariantIds: string[],
 *   image?: string}) => void} save                          A new or edited product, its opening-stock moves, variants removed for good,
 *   and its photo (a data URL, "" to remove it, undefined to leave it).
 * @property {(id: string, on: boolean) => (Object|null)} setArchived  Take a product off sale or bring it back.
 * @property {(id: string) => (Object|null)} remove           Delete a product with its stock records and photo.
 */

/**
 * "stockRepository": stock moves. Implementation: infrastructure/repositories/local-first-stock-repository.js, provided by
 * app/container.js. Reach it through features/inventory/repositories/stock-repository.js.
 * @typedef {Object} StockRepositoryPort
 * @property {(change: {moves: Object[], changedProductId?: string}) => void} record  Record moves; changedProductId: a product
 *   whose data changed too (e.g. its cost), uploaded before the moves.
 */

/**
 * "barcodeService": barcodes as print-quality SVG. Implementation: infrastructure/codes/barcode-svg.js (provided by app/container.js).
 * Codes are generated by domain/catalog/barcode.js (generateEan13) and stored on the variant (bc), so scanning finds that variant.
 * @typedef {Object} BarcodeServicePort
 * @property {(code: string, opts?: Object) => string} render   EAN-13 / UPC-A / EAN-8 when the code is a valid one, else Code 128.
 * @property {(code: string) => (string|null)} symbology         "ean13" | "upca" | "ean8" | "code128", or null when unprintable.
 */

/**
 * "qrCodeService": QR codes as SVG. Implementation: infrastructure/codes/qr-svg.js (vendored qrcode-generator, MIT).
 * @typedef {Object} QrCodeServicePort
 * @property {(text: string, opts?: Object) => string} render
 */

/**
 * "files" also has: svgToPng(svg, {scale}) → Promise<Blob>, sha256Hex(blob) → Promise<string>,
 * downscaleImage(file, {maxPx, quality}) → Promise<Blob> (JPEG), readAsBase64(blob) → Promise<string>.
 */

/**
 * "documentExtractionService": reads a supplier bill. Implementation: infrastructure/extraction/bill-extractor.js, which calls
 * the Supabase Edge Function extract-bill (the provider's API key lives there, never in the app).
 * @typedef {Object} DocumentExtractionPort
 * @property {(file: File, opts?: {fileHash?: string}) => Promise<Object>} extract   { supplier, invoice, lines[], warnings[] };
 *   throws AppError (NOT_CONFIGURED when the function has no key, VALIDATION for a bad file, NETWORK …).
 */

/**
 * "inventoryImportService": adds a confirmed supplier bill. Implementation: infrastructure/repositories/local-first-stock-import.js.
 * @typedef {Object} InventoryImportPort
 * @property {(q: {fileHash?: string, invoiceNo?: string}) => Promise<Object[]>} findDuplicates   Earlier imports of that file / invoice.
 * @property {(plan: Object, meta: Object) => Promise<Object>} commit   One all-or-nothing RPC (hangtag_import_stock), then applied on
 *   this device. Throws AppError CONFLICT (details.kind "file"|"invoice") for a likely repeat unless meta.allowDuplicate.
 */

/**
 * "barcodeScanner": the camera reading barcodes/QR codes. Implementation: infrastructure/scanner/camera-scanner.js
 * (rear camera preferred; the browser's BarcodeDetector, else the bundled ZXing decoder).
 * @typedef {Object} BarcodeScannerPort
 * @property {() => boolean} available
 * @property {(video: HTMLVideoElement, handlers: {onCode: (text: string) => void, onError?: Function}) => Promise<{native: boolean}>} start
 *   Opens the camera; onCode runs for every read (often, while one code stays in view). Throws AppError with
 *   details.kind "denied" | "unavailable" | "busy" | "failed".
 * @property {() => void} stop   Releases the camera.
 */

/**
 * "customerRepository": the shop's customers. Implementation: infrastructure/repositories/local-first-customer-repository.js
 * (this device first, then uploaded; the database keeps each shop's customers to itself). Reach it through
 * features/customers/repositories/customer-repository.js.
 * @typedef {Object} CustomerRepositoryPort
 * @property {() => Object[]} list
 * @property {(id: string) => (Object|null)} get
 * @property {(c: {id, name, phone, email, gstin, type, t}) => Object} save
 */
