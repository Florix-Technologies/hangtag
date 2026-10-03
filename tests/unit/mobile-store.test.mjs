// Mobile storefront: public-link parsing, customer input, unit quantities and cart payloads. The database remains the
// authority for tenant, current price and stock; those trust-boundary rules are covered in supabase/tests/mobile-store.test.mjs.
import { checkMobileCustomer, mobileCartTotal, mobileOrderItems, mobileQty, mobileQtyStep, mobileStoreLink } from '../../src/domain/commerce/mobile-store.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if(ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('store links accept only opaque tokens and the two known modes',
  eq(mobileStoreLink('#s=st_12345678901234567890123456789012&mode=assisted'), { token:'st_12345678901234567890123456789012', mode:'assisted' })
  && mobileStoreLink('#s=short').token === '' && mobileStoreLink('#s=12345678901234567890123456789012').token === ''
  && mobileStoreLink('#s=xx_12345678901234567890123456789012').token === ''
  && mobileStoreLink('#s=st_12345678901234567890123456789012&mode=admin').mode === 'store');

check('customer checkout needs a name, valid mobile, and valid optional email',
  checkMobileCustomer({ name:' Asha  Rao ', phone:'+91 98765 43210', email:'ASHA@EXAMPLE.COM' }).customer.email === 'asha@example.com'
  && checkMobileCustomer({ name:'', phone:'9876543210' }).field === 'name'
  && checkMobileCustomer({ name:'Asha', phone:'123' }).field === 'phone'
  && checkMobileCustomer({ name:'Asha', phone:'9876543210', email:'bad' }).field === 'email');

check('quantities follow the existing unit precision and public per-line limit',
  mobileQtyStep('pcs') === 1 && mobileQtyStep('m') === .01 && mobileQtyStep('kg') === .001
  && mobileQty('2', 'pcs') === 2 && mobileQty('1.25', 'm') === 1.25 && mobileQty('0.375', 'kg') === .375
  && mobileQty('1.2', 'pcs') === null && mobileQty('50.001', 'kg') === null);

const variants = [{ v:'a', unit:'pcs', available:3 }, { v:'b', unit:'kg', available:1.5 }, { v:'c', unit:'pcs', available:0 }];
check('cart payload has only known, available variants and never sends display prices',
  eq(mobileOrderItems({ b:.75, a:2, c:1, missing:1, nope:'x' }, variants), [{ v:'a', q:2 }, { v:'b', q:.75 }]));
check('customer total follows inclusive/exclusive GST and whole-rupee checkout rounding', mobileCartTotal({ a:2 }, [{ v:'a',unit:'pcs',price:99.5,gst:5 }], { taxOn:true,taxInclusive:true }) === 199
  && mobileCartTotal({ a:1 }, [{ v:'a',unit:'pcs',price:99.5,gst:5 }], { taxOn:true,taxInclusive:false }) === 104);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
