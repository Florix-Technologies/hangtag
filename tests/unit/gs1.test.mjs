// GS1 (src/domain/catalog/gs1.js): GTINs of any length as one number, element strings (GS1 DataMatrix / GS1-128 / QR /
// DataBar) as scanners type them, GS1 Digital Link, dates, and how the counter and stock-in use them. Run: npm run test:unit
import { gs1Date, gtinKey, parseGs1, sameGtin } from '../../src/domain/catalog/gs1.js';
import { scanCodeError } from '../../src/domain/sales/scan-rules.js';
import { lookupCode } from '../../src/domain/inventory/barcode-intake.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); } };
const GS = '\u001d', G = '09506000134352';

check('GTINs: EAN-13, UPC-A, GTIN-14 and EAN-8 as 14 digits; a wrong check digit or letters are not GTINs', gtinKey('9506000134352') === G && gtinKey(G) === G && gtinKey('012345678905') === '00012345678905'
  && gtinKey('0012345678905') === '00012345678905' && gtinKey('96385074') === '00000096385074' && gtinKey('9506000134353') === null && gtinKey('95060001343A2') === null && gtinKey('123') === null);
check('a case (indicator 1 in front) is another trade item', gtinKey('19506000134359') === '19506000134359' && !sameGtin('9506000134352', '19506000134359') && sameGtin('9506000134352', G));
check('dates: YYMMDD, day 00 is the month\'s last day, impossible dates refused', gs1Date('270131') === '2027-01-31' && gs1Date('280200') === '2028-02-29' && gs1Date('271301') === null && gs1Date('270231') === null && gs1Date('2701') === null);
let g = parseGs1(`]d201${G}17270131` + `10ABC123${GS}21SN0001`);
check('GS1 DataMatrix as a scanner types it (symbology id, GS after the batch)', g && g.source === 'element-string' && g.gtin === G && g.expiry === '2027-01-31' && g.batch === 'ABC123' && g.serial === 'SN0001', g);
check('the same in brackets, and with the scanner stand-ins for GS (<GS>, {GS}, ^])', JSON.stringify(parseGs1(`(01)${G}(17)270131(10)ABC123(21)SN0001`)) === JSON.stringify({ ...g })
  && parseGs1(`01${G}10ABC<GS>21SN1`).serial === 'SN1' && parseGs1(`01${G}10ABC{GS}21SN1`).batch === 'ABC' && parseGs1(`01${G}10ABC^]21SN1`).serial === 'SN1');
g = parseGs1(`01${G}3103001250` + `3922001990`);
check('net weight (3103: kg, 3 decimals) and price (3922: 2 decimals)', g.netWeightKg === 1.25 && g.price === 19.9, g);
g = parseGs1(`https://id.gs1.org/01/${G}/10/ABC123/21/12345?17=270131`);
check('GS1 Digital Link: the path and the query', g && g.source === 'digital-link' && g.gtin === G && g.batch === 'ABC123' && g.serial === '12345' && g.expiry === '2027-01-31', g);
check('...on the brand\'s own domain, with the gtin / lot / ser aliases', parseGs1('https://brand.example/gtin/9506000134352/lot/L9').batch === 'L9' && parseGs1('https://brand.example/gtin/9506000134352/lot/L9').gtin === G);
check('not GS1: a plain barcode, an SKU, a link without a GTIN, a GTIN with a wrong check digit, an unknown AI first', parseGs1('9506000134352') === null && parseGs1('KURTA-M') === null
  && parseGs1('https://example.com/p/123') === null && parseGs1('(01)09506000134353') === null && parseGs1('99ABC') === null && parseGs1('') === null);
check('a GS1 code with its separators is a code the counter can read (not refused as unprintable or too long)', scanCodeError(`]d201${G}17270131` + `10ABC${GS}21SN1`) === null
  && scanCodeError(`https://id.gs1.org/01/${G}/10/${'L'.repeat(20)}/21/${'S'.repeat(20)}?17=270131`) === null && scanCodeError('bad\u0007code') !== null);

// stock-in lookups (the catalog as stock-in sees it: archived products too)
const variantsOf = (p) => p.variants;
const products = [{ id: 'p1', name: 'Paracetamol', variants: [{ id: 'v1', bc: '9506000134352', active: true }] }, { id: 'p2', name: 'Cable', variants: [{ id: 'v2', bc: '012345678905', active: true }] }];
let r = lookupCode(`(01)${G}(17)270131(10)B1`, products, variantsOf);
check('stock-in: a GS1 code finds the product saved with its EAN-13, and keeps what the code says', r.hit && r.hit.v.id === 'v1' && r.gs1.batch === 'B1' && r.gs1.expiry === '2027-01-31', r);
check('...an EAN-13 with a 0 in front finds the UPC-A product', (lookupCode('0012345678905', products, variantsOf).hit || {}).v?.id === 'v2');
r = lookupCode(`]d20108901234567890`, products, variantsOf);
check('...a new GS1 code: the product is made with its GTIN as an EAN-13', r.unknown === '8901234567890' && r.gs1.gtin === '08901234567890', r);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
