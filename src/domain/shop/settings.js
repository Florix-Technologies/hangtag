// Shop billing/stock settings defaults.

export const DEFAULT_SETTINGS={lowStock:3,taxOn:false,taxRate:5,taxIncl:true,prefix:"INV-",paper:"80mm",footer:"Thank you for shopping with us!",groupDismissed:[],
  // payments: the shop's own UPI ID (for the QR checked by hand) and how long a verified QR stays open (minutes)
  upiId:"",payExpiry:5,
  // receipts sent by themselves when a bill completes (all off until the shop turns them on)
  autoSend:{whatsapp:false,sms:false,email:false},
  // GST filing preparation: B2C invoices to another state above this value are "B2C large"; the log of exports
  b2clLimit:100000,gstExports:[]};
