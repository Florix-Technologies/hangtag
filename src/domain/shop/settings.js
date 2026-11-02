// Shop billing/stock settings defaults.

export const DEFAULT_SETTINGS={lowStock:3,taxOn:false,taxRate:5,taxIncl:true,prefix:"INV-",invoiceStart:1,invoicePadding:6,invoiceSuffix:"",paper:"80mm",footer:"Thank you for shopping with us!",groupDismissed:[],
  // payments: the shop's own UPI ID (for the QR checked by hand) and how long a verified QR stays open (minutes)
  upiId:"",payExpiry:5,
  // receipts sent by themselves when a bill completes (all off until the shop turns them on)
  autoSend:{whatsapp:false,sms:false,email:false},
  // GST filing preparation: B2C invoices to another state above this value are "B2C large"; the log of exports
  b2clLimit:100000,gstExports:[],
  // batches: days of warning before one expires, and whether expired stock may still be sold (by default it can't)
  expiryDays:30,sellExpired:false,
  // quotations: the document's title, number prefix, footer, default terms for a new quotation, signature line, GST shown
  quoteTitle:"QUOTATION",quotePrefix:"QT",quoteFooter:"",quoteTerms:"",quoteSignature:"",quoteGst:true,
  // Smart reorder's planning (domain/inventory/inventory-intelligence.js): supplier lead time, safety stock, days an order covers
  reorder:{leadDays:7,safetyDays:3,targetCoverDays:21},
  // the receipt page of the app the owner uses (https …/receipt.html): invoice links open it unless the server sets RECEIPT_URL
  receiptUrl:""};
