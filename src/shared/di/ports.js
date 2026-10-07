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
 * @property {(opts?: {message?: string, forgetDevice?: boolean}) => Promise<void>} signOut  Sign out on this device (local data is kept
 *   per account). message: shown on the sign-in screen (e.g. a phone the owner signed out); forgetDevice: drop this phone's team
 *   device key instead of keeping it for the member's next sign-in.
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
 * @property {Function} saveSale  A bill with its lines and payments in one step (RPC hangtag_save_sales; the database checks the
 *   payments add up and posts the financial transactions and cash / bank book entries). Also: setSaleVoid, saveProduct(p, index),
 *   deleteVariants, deleteProduct, saveImage, saveMove, saveReturn, saveCustomer, saveSettings, saveAllSales.
 *   Used by the outbox (features/sync/services/outbox.js) only. An update or delete that row security quietly skipped (a team
 *   member's role doesn't allow it; the rows are still there) throws PERMISSION instead of passing as done.
 * @property {Function} fetchProducts  Also: fetchVariants, fetchImages, fetchMoves, fetchReturns, fetchCustomers, fetchSettings,
 *   fetchSales (bills with lines and payments), fetchSaleLineRows, fetchSalePayments, fetchLogo, fetchDeliveries. Used by downloads
 *   (features/sync/services/pull.js, remote-events.js). A team member's phone (no live updates) polls shopChanges() (one small
 *   fingerprint per part of the shop, RPC hangtag_shop_changes) and downloads only what changed: fetchSalesSince(iso) (bills
 *   saved since, with lines and payments), fetchVoidedSales() ([{ id, reason }]).
 * @property {Function} saveLogo  The receipt logo (hangtag_meta "logo"; queue item "logo"). Also: sendReceipt(body) and
 *   deliveryChannels() (Edge Function send-receipt), used through the "messageDelivery" port only.
 * @property {Function} getProfile  Also: createProfile, updateProfile, saveProfile (the hangtag_profiles row of the signed-in user;
 *   getProfile(shopId) also reads a team member's shop profile).
 * @property {(name: string, body: Object, what: string) => Promise<Object>} callFunction  An Edge Function's answer; throws an AppError.
 * @property {() => Promise<{shopId: (string|null), role: (string|null), deviceId: (string|null)}>} touchDevice  RPC hangtag_touch_device.
 * @property {Function} fetchMembers  Also: fetchDevices, fetchRoles, saveRole({ role, permissions, label }) (the shop's team; used
 *   through the "teamService" port only).
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
 * @property {(x: {products: Object[], moves: Object[]}) => void} addMany  New products (bulk import) and their opening stock
 *   records: saved once, then queued (products before their records).
 */

/**
 * "stockRepository": stock moves. Implementation: infrastructure/repositories/local-first-stock-repository.js, provided by
 * app/container.js. Reach it through features/inventory/repositories/stock-repository.js.
 * @typedef {Object} StockRepositoryPort
 * @property {(change: {moves: Object[], changedProductId?: string}) => void} record  Record moves; changedProductId: a product
 *   whose data changed too (e.g. its cost), uploaded before the moves.
 */

/**
 * "purchaseRepository": suppliers, purchases from them (a supplier's invoice with its stock-in records) and later payments to
 * them. Implementation: infrastructure/repositories/local-first-purchase-repository.js, provided by app/container.js. Reach it
 * through features/inventory/repositories/purchase-repository.js. Kept on the device first, then queued (outbox types
 * "supplier", "purchase" → RPC hangtag_save_purchase, "pcancel" → RPC hangtag_cancel_purchase, "spay").
 * @typedef {Object} PurchaseRepositoryPort
 * @property {() => Object[]} suppliers / purchases / payments           This device's records.
 * @property {(s: Object) => Object} saveSupplier                          Add or change a supplier (never deleted: active = false).
 * @property {(p: {purchase: Object, moves: Object[], cashMove?: Object, changedProductIds?: string[]}) => Object} savePurchase
 *   A purchase, its RESTOCK records (import_id = the purchase) and the cash book entry of cash paid (the database adds the same).
 * @property {(c: {id: string, reason: string, moves: Object[], cashMove?: Object, t: number, dev: string}) => Object} cancelPurchase
 *   Mark it cancelled with the opposite adjustments (pcx:<record>) and the cash coming back (purx:<purchase>).
 * @property {(x: {payment: Object, cashMove?: Object}) => Object} recordPayment   A payment to a supplier or its reversal.
 */

/**
 * "barcodeService": barcodes as print-quality SVG. Implementation: infrastructure/codes/barcode-svg.js (provided by app/container.js).
 * Codes are generated by domain/catalog/barcode.js (generateEan13) and stored on the variant (bc), so scanning finds that variant.
 * @typedef {Object} BarcodeServicePort
 * @property {(code: string, opts?: Object) => string} render   EAN-13 / UPC-A / EAN-8 when the code is a valid one, else Code 128.
 * @property {(code: string) => (string|null)} symbology         "ean13" | "upca" | "ean8" | "code128", or null when unprintable.
 */

/**
 * "voiceInput": optional browser/device speech. Implementation: infrastructure/browser/browser-speech.js.
 * Product search still uses the normal text input and search index; a transcript is only another way to fill it.
 * @typedef {Object} VoiceInputPort
 * @property {() => boolean} available
 * @property {(opts?: {lang?: string}) => Promise<string>} listen
 * @property {() => void} stop
 * @property {() => boolean} canSpeak
 * @property {(text: string, opts?: {lang?: string}) => boolean} speak
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

/**
 * "returnRepository": returns and exchanges. Implementation: infrastructure/repositories/local-first-return-repository.js
 * (this device first, then uploaded through RPC hangtag_save_return; the database refuses returning more than a bill line
 * has left). Reach it through features/returns/repositories/return-repository.js.
 * @typedef {Object} ReturnRepositoryPort
 * @property {() => Object[]} list
 * @property {(id: string) => (Object|null)} get
 * @property {(ret: Object) => Object} record   A new return (with its credit note number, lines and refund).
 */

/**
 * "eventRepository": the shop's events (Event Mode). Implementation: infrastructure/repositories/local-first-event-repository.js
 * (this device first, then uploaded to hangtag_events; the database refuses deleting an event that has bills).
 * Reach it through features/events/repositories/event-repository.js.
 * @typedef {Object} EventRepositoryPort
 * @property {() => Object[]} list
 * @property {(id: string) => (Object|null)} get
 * @property {(ev: {id, name, start, end, place, status, t}) => Object} save
 * @property {(id: string) => void} remove   Only for an event without bills (the use case checks; the database too).
 */

/**
 * "receiptPrinter": a thermal receipt printer. Implementation: infrastructure/printing/epson-epos.js (Epson printers on
 * the shop's network, through their ePOS-Print web service), provided by app/container.js. Used by
 * features/printing/use-cases/print-receipt.js with the printer settings of this device (store.printer).
 * @typedef {Object} ReceiptPrinterPort
 * @property {(doc: {cols: number, logo: string, lines: {text, align, bold, big}[]}, cfg: {host, https, devid, cols}) => Promise<{ok: true}>} print
 *   Resolves only when the printer confirmed the print (ePOS success="true"). Otherwise throws an AppError with code
 *   PRINTER and a message a person can act on (unreachable, cover open, out of paper, timeout …); details.retry is true.
 * @property {(cfg: Object) => Promise<{ok: true}>} test   A short test receipt, same rules.
 */

/**
 * "messageDelivery": sends a finished bill to its customer by email, WhatsApp or SMS. Implementation:
 * infrastructure/messaging/delivery-client.js → Edge Function send-receipt (provider keys live there; the recipient comes
 * from the bill's saved customer). Reach it through features/delivery/repositories/delivery-service.js.
 * @typedef {Object} MessageDeliveryPort
 * @property {() => Promise<({email: boolean, whatsapp: boolean, sms: boolean}|null)>} channels  Which channels have a provider.
 * @property {(req: {channel: string, saleId: string, message: {subject?, html?, text, params?}}) => Promise<{status: "sent", to, provider, id}>} send
 *   Resolves only when the provider accepted the message and returned its id. Otherwise throws an AppError:
 *   NOT_CONFIGURED (no provider), VALIDATION (no contact, cancelled, too many), DELIVERY (the provider refused), NETWORK.
 * @property {(saleId: string) => Promise<Object[]>} history  What was sent from a bill (hangtag_deliveries), newest first.
 * @property {(since: number) => Promise<Object[]>} recent  What was sent from any bill since a time (ms), newest first, at most 500.
 * @property {(saleId: string) => Promise<Object>} refresh  Asks the providers whether the bill's messages were delivered.
 * @property {(saleId: string) => Promise<{url: string}>} link  The bill's secure invoice link (made once, 12 months).
 * @property {(saleId: string) => Promise<void>} revokeLinks  Stops the bill's invoice links working.
 */

/**
 * "paymentGateway": provider-neutral verified UPI (single-use QR for an exact amount) and card payment intents.
 * Implementation: infrastructure/payments/payment-gateway-client.js → Edge Function payment-gateway (provider keys stay
 * server-side; only the provider's verified record makes an intent "verified"). Reach it through
 * features/sales/use-cases/provider-payment.js.
 * @typedef {Object} PaymentGatewayPort
 * @property {() => Promise<{provider: (string|null), upi: boolean, cardLink: boolean}>} config
 * @property {(req: {method: "upi"|"card", amount: number, saleId: string, note?: string, expiryMin?: number}) => Promise<Object>} createPayment
 *   → the intent { id, status: "pending", qrUrl | linkUrl, reference, expiresAt }.
 * @property {(req: {amount: number, saleId: string, note?: string, expiryMin?: number}) => Promise<Object>} createDynamicQr
 * @property {(id: string) => Promise<Object>} getStatus  The intent as the provider sees it now.
 * @property {(id: string) => Promise<Object>} cancelPayment  Closes it ("verified" instead when the money arrived first).
 * @property {(req: {saleId: string, reference: string}) => Promise<{status: string}>} verifyPayment  Matches a UPI payment checked by hand.
 * @property {(req: {returnId: string}) => Promise<{refundId: string}>} refund  A return's refund back onto its bill's verified payment.
 * @property {() => Promise<Object[]>} unmatched  Money received that isn't on any bill.
 * @property {(req: {id: string, resolution: "refund"|"refunded"|"allocated", note?: string}) => Promise<Object>} resolve
 *   Every call throws an AppError when it can't be done: NOT_CONFIGURED, VALIDATION, CONFLICT, NOT_FOUND, AUTH, DELIVERY, NETWORK.
 */

/**
 * "subscriptionService": the shop's Hangtag plan (Plans & Billing, the lock). Implementation:
 * infrastructure/billing/subscription-client.js → database functions of schema.sql section 3t + the subscription Edge Function.
 * @typedef {Object} SubscriptionServicePort
 * @property {() => Promise<Object|null>} status  The shop's plan (hangtag_subscription_status). Throws an AppError when it can't.
 * @property {() => Promise<Object[]>} plans  The plans on sale with their prices (from the database).
 * @property {(plan: string, promo: string) => Promise<Object>} quote  The price, the promo discount and the amount (computed by the database).
 * @property {() => Promise<Object[]>} payments  The owner's plan payments, newest first.
 * @property {() => Promise<{available: boolean, provider: (string|null)}>} config  Whether online payment is set up (never throws).
 * @property {(plan: string, promo: string) => Promise<Object>} checkout  Starts a payment: { payment_id, amount, pay_url } or { free: true, status: "paid" }.
 * @property {(paymentId: string) => Promise<Object>} verify  Asks the provider: { status: "paid"|"pending"|… }.
 */

/**
 * "agentProvider": the Hangtag Agent's optional AI provider. Implementation: infrastructure/ai/agent-provider-client.js →
 * Edge Function agent (the provider's key stays server-side; the function reads no shop data). The tools run on this device
 * (features/assistant/services/agent-tools.js); reach it through features/assistant/services/agent-runner.js.
 * @typedef {Object} AgentProviderPort
 * @property {() => Promise<{available: boolean, provider: (string|null), model: (string|null)}>} config  Not available when it
 *   isn't set up, this account isn't allowed, or the function can't be reached (never throws).
 * @property {(req: {question: string, tools: Object[], transcript: Object[]}) => Promise<Object>} step  One round:
 *   { type: "tool_calls", calls: [{ id, name, input }] } or { type: "answer", text }. Throws an AppError when it can't.
 */

/**
 * "teamService": the shop's team — members (staff accounts), roles and permissions, and the phones they use. Implementation:
 * infrastructure/team/team-client.js: changes → Edge Function team (service role; the database decides the caller is the owner);
 * reads and role permissions → the cloud gateway (REST with row security: the owner reads the whole team, a member only itself).
 * Reach it through features/shop/services/team.js. Every call throws an AppError when it can't be done (VALIDATION with the
 * function's own message, e.g. an expired or used QR code; AUTH; NOT_CONFIGURED when the function isn't deployed; NETWORK).
 * @typedef {Object} TeamServicePort
 * @property {(m: {name, username, role, password?}) => Promise<{userId, shopCode, username, member}>} createMember  Owner only.
 * @property {(m: {userId, name?, role?, status?}) => Promise<{member, revoked}>} updateMember  Disabling revokes every phone of the member
 *   and ends its sign-ins.
 * @property {(m: {userId, password?}) => Promise<{revoked, passwordSet, sessionsEnded}>} resetAccess  Revokes every phone of the member,
 *   ends its sign-ins and always replaces its password (with the new one, or one nobody knows: QR only from then on).
 * @property {(userId: string) => Promise<{ok: true}>} removeMember
 * @property {(userId: string) => Promise<{token: string, expiresAt: number}>} enrollStart  A single-use QR code, 10 minutes.
 * @property {(r: {token, deviceName, platform?}) => Promise<{tokenHash, email, deviceId, deviceKey, shopName, role, name, username}>} enrollRedeem
 *   The new phone (no session): then auth.verifyOtp({ type: "magiclink", token_hash }) signs it in.
 * @property {(r: {deviceName, platform?}) => Promise<{deviceId, deviceKey, shopName, role, name, username}>} registerDevice
 *   A member the owner gave a password, signed in with it in the last 10 minutes (after any reset or revoke), adds this phone.
 * @property {(deviceId: string) => Promise<{ok: true}>} revokeDevice  Also removeDevice(deviceId). Owner only.
 * @property {() => Promise<Object[]>} members  Also devices(), roles() ([{ role, permissions }]).
 * @property {(role: string, permissions: string[], label?: string) => Promise<void>} saveRolePermissions  Owner only (hangtag_roles).
 * @property {() => Promise<{shopId, role, deviceId}>} touch  This phone's standing in its shop (RPC hangtag_touch_device).
 */

/**
 * "weightScale": a weighing scale on this device. Implementation: infrastructure/hardware/weight-scale.js — a scale on a
 * cable through Web Serial (any scale that prints "a number and a unit"; baud rate, bare-number unit and an optional
 * request command from Settings → This device, store.scale), else the manual provider (the weight is typed). Reach it through
 * features/hardware/services/scale.js. Nothing here throws: failures come back as { error } with a message a person can
 * act on, and typing the weight is always possible.
 * @typedef {Object} WeightScalePort
 * @property {() => boolean} supported     This browser can reach a scale on a cable (Web Serial).
 * @property {() => {connected: boolean, kind: "serial"|"manual", name: string}} status
 * @property {() => Promise<{ok: true, name: string}|{error: string}>} connect   Asks the person to choose the port (needs a tap).
 * @property {() => Promise<boolean>} reconnect    Opens the port this browser remembers, without asking (at start-up).
 * @property {() => Promise<void>} disconnect
 * @property {(opts?: {timeoutMs?: number}) => Promise<{value: number, unit: "kg"|"g"|"lb"|"oz"|"l"|"ml", stable: true}|{error: string}>} read
 *   The next settled reading (a scale still settling, or nothing within the time, is an error).
 * @property {(line: string, unit?: string) => ({value, unit, stable}|null)} feed  Gives the manual provider a reading, as a scale would print it.
 */

/**
 * "bizRepository": the commerce batch's records (schema.sql section 3r) by kind — pl price lists, po purchase orders, ei / ew
 * e-invoice / e-way bill readiness, rpk repacks (with their two stock records), gv gift vouchers (the cloud's copy only).
 * Implementation: infrastructure/repositories/local-first-biz-repository.js. Saved here first, then queued ("biz" { kind, id };
 * "bizdel" removes a price list); the upload reads the record as it is then (cloud.saveBiz).
 * @typedef {Object} BizRepositoryPort
 * @property {(kind: string) => Object[]} list
 * @property {(kind: string, id: string) => (Object|null)} get
 * @property {(kind: string, rec: Object) => Object} save        Kept and queued for upload.
 * @property {(kind: string, rec: Object) => Object} keep        The cloud's copy, not uploaded (vouchers).
 * @property {(kind: string, id: string) => (Object|null)} remove
 * @property {(kind: string, id: string, version: number) => void} saved   The version the cloud holds after a save (purchase orders).
 * @property {(rec: Object) => Object} repack                    A repack and its stock records (rec.moves), here at once.
 * @property {(kind: string, map: Object) => void} replace       A download of a kind.
 */

/**
 * "orderRepository": orders (quotations, sales orders, table orders) and held bills. Implementation:
 * infrastructure/repositories/local-first-order-repository.js (this device first, then the upload queue: "order" →
 * cloud.saveOrder (RPC hangtag_save_order, optimistic concurrency), "held" / "helddel" → hangtag_held_carts).
 * Reach it through features/orders/repositories/order-repository.js. Nothing here changes stock.
 * @typedef {Object} OrderRepositoryPort
 * @property {() => Object[]} list  Also get(id).
 * @property {(o: Object) => Object} save  Keeps the order here and queues its upload (the whole order, as it is when it uploads).
 * @property {(id: string, version: number) => void} saved  The version the cloud holds after an upload.
 * @property {() => Object[]} heldList  Also getHeld(id).
 * @property {(h: {id, name, data: {cart, disc, cust, order?, note?}, t, dev}) => Object} hold
 * @property {(id: string) => (Object|null)} removeHeld  Recalled or thrown away: removed here and in the cloud.
 */

/**
 * "creditRepository": payments customers make towards what they owe. Implementation:
 * infrastructure/repositories/local-first-credit-repository.js ("collection" uploads → hangtag_collections; the database
 * posts each to the cash or bank book). Reach it through features/customers/repositories/credit-repository.js.
 * @typedef {Object} CreditRepositoryPort
 * @property {() => Object[]} list  Also get(id).
 * @property {(c: {id, cust, amount, method, ref?, verification, note?, t, dev}) => Object} record
 * @property {(id: string) => (Object|null)} cancel  Owner only (the database refuses anyone else).
 */
