// Composition root for ports: provides the infrastructure implementation of each port (contracts in shared/di/ports.js).
import { provide } from '../shared/di/services.js';
import { LS } from '../infrastructure/storage/local-storage.js';
import { downscaleImage, fileToThumb, readAsBase64, saveFile, sha256Hex } from '../infrastructure/browser/files.js';
import { createCloudGateway } from '../infrastructure/supabase/cloud-gateway.js';
import { AUTH_STORE, DEVICE_KEY } from '../features/auth/config.js';
import { sbKey, sbUrl } from '../shared/config/app-config.js';
import { store } from '../shared/state/store.js';
import { createLocalFirstProductRepository } from '../infrastructure/repositories/local-first-product-repository.js';
import { createLocalFirstStockRepository } from '../infrastructure/repositories/local-first-stock-repository.js';
import { dropQueued, enqueue, flushSbQueue } from '../features/sync/services/outbox.js';
import { saveCashMoves, saveDayCloses, saveCatalog, saveCustomers, saveEvents, saveImgs, saveMoves, saveReturns, saveSbQueue } from '../shared/state/persistence.js';
import { enterApp, signOut } from '../features/auth/services/session.js';
import { barcodeSVG } from '../infrastructure/codes/barcode-svg.js';
import { qrSVG } from '../infrastructure/codes/qr-svg.js';
import { svgToPngBlob } from '../infrastructure/codes/png.js';
import { symbologyFor } from '../domain/catalog/barcode.js';
import { createBillExtractor } from '../infrastructure/extraction/bill-extractor.js';
import { createCameraScanner } from '../infrastructure/scanner/camera-scanner.js';
import { createLocalFirstStockImport } from '../infrastructure/repositories/local-first-stock-import.js';
import { createLocalFirstCustomerRepository } from '../infrastructure/repositories/local-first-customer-repository.js';
import { createLocalFirstReturnRepository } from '../infrastructure/repositories/local-first-return-repository.js';
import { createLocalFirstEventRepository } from '../infrastructure/repositories/local-first-event-repository.js';
import { invalidate } from '../features/inventory/services/ledger.js';
import { createEpsonPrinter } from '../infrastructure/printing/epson-epos.js';
import { rasterizeLogo } from '../infrastructure/printing/raster.js';
import { createDeliveryClient } from '../infrastructure/messaging/delivery-client.js';
import { createPaymentGatewayClient } from '../infrastructure/payments/payment-gateway-client.js';
import { createLocalFirstCashRepository } from '../infrastructure/repositories/local-first-cash-repository.js';
import { createTeamClient } from '../infrastructure/team/team-client.js';

/* Called first at start-up (app/main.js), before the state is restored from storage */
export function installContainer(){
  provide("storage", LS);
  const files = { saveFile, fileToThumb, svgToPng: svgToPngBlob, sha256Hex, downscaleImage, readAsBase64 };
  provide("files", files);
  provide("barcodeService", { render: barcodeSVG, symbology: symbologyFor });
  provide("qrCodeService", { render: qrSVG });
  provide("barcodeScanner", createCameraScanner());
  // Sign out / open the shop, for the screens around sign-in (shared/ui/session-actions.js)
  provide("session", { signOut, enterApp });
  // Supabase: the current client is read on every call (it is created at sign-in; tests may replace it). A team member's
  // phone sends its device key with every request (read each time, so enrolling the phone needs no new client).
  const deviceKey = () => { const k = LS.get(DEVICE_KEY, ""); return typeof k === "string" ? k : ""; };
  const cloudGateway = createCloudGateway({ getClient: () => store.sbClient, url: sbUrl, key: sbKey, storageKey: AUTH_STORE, deviceKey });
  provide("cloud", cloudGateway);
  // The shop's team: staff accounts, roles and permissions, enrolled phones (Edge Function team + row-secured reads)
  provide("teamService", createTeamClient({ cloud: cloudGateway }));
  // Local-first repositories: this device's state first, then the upload queue (features/sync/services/outbox.js)
  const outbox = { enqueue, dropQueued };
  provide("productRepository", createLocalFirstProductRepository({ store, persist: { saveCatalog, saveMoves, saveImgs, saveSbQueue }, outbox }));
  provide("stockRepository", createLocalFirstStockRepository({ store, persist: { saveMoves, saveCatalog }, outbox }));
  provide("customerRepository", createLocalFirstCustomerRepository({ store, persist: { saveCustomers }, outbox }));
  provide("returnRepository", createLocalFirstReturnRepository({ store, persist: { saveReturns }, outbox, invalidate }));
  provide("eventRepository", createLocalFirstEventRepository({ store, persist: { saveEvents }, outbox }));
  provide("documentExtractionService", createBillExtractor({ cloud: cloudGateway, files }));
  // Bills out: an Epson thermal printer on the shop's network, and email / WhatsApp / SMS through the send-receipt function
  provide("receiptPrinter", createEpsonPrinter({ rasterize: rasterizeLogo }));
  provide("messageDelivery", createDeliveryClient({ cloud: cloudGateway }));
  provide("paymentGateway", createPaymentGatewayClient({ cloud: cloudGateway }));
  provide("cashRepository", createLocalFirstCashRepository({ store, persist: { saveCashMoves, saveDayCloses }, outbox: { enqueue } }));
  provide("inventoryImportService", createLocalFirstStockImport({ store, cloud: cloudGateway, persist: { saveCatalog, saveMoves }, outbox: { flush: flushSbQueue }, invalidate }));
}
