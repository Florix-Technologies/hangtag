// The global-ready core (src/shared/formatting/regions.js, money.js, dates.js): India stays exactly as it was (₹, lakh and
// crore, en-IN dates, +91), and another region writes money, short money, dates and phone numbers its own way from one
// place. Run: npm run test:unit
import { REGIONS, compactParts, phoneDigits, regionOf } from '../../src/shared/formatting/regions.js';
import { configureMoney, currencySymbol, inr, inrShort, inrx } from '../../src/shared/formatting/money.js';
import { configureDates, dayLab, dayLong } from '../../src/shared/formatting/dates.js';
import { moneyFor } from '../../supabase/functions/send-receipt/core.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); } };

check('India by default: rupees with Indian grouping, paise only when there are paise', inr(1234567.4) === '₹12,34,567' && inrx(-1048.95) === '−₹1,048.95' && inrx(1049) === '₹1,049' && currencySymbol() === '₹');
check('...short money in lakh and crore', inrShort(12345678) === '₹1.2Cr' && inrShort(150000) === '₹1.5L' && inrShort(12400) === '₹12.4k' && inrShort(999) === '₹999' && inrShort(-250000) === '₹-2.5L');
check('...dates the Indian way', dayLab('2026-10-05') === '5 Oct' && /^Mon/.test(dayLong('2026-10-05')));
configureMoney(REGIONS.AE);
check('UAE: dirhams, international grouping, thousand / million', inr(1234567) === 'AED 1,234,567' && inrShort(1500000) === 'AED 1.5M' && inrx(10.5) === 'AED 10.50' && currencySymbol() === 'AED ');
configureMoney(REGIONS.US);
check('US: dollars, and billions', inr(2500) === '$2,500' && inrShort(3.2e9) === '$3.2B' && inrx(0.07) === '$0.07');
configureMoney(REGIONS.GB);
check('UK: pounds', inr(1234567) === '£1,234,567');
configureMoney(REGIONS.IE);
check('Ireland: euro — € on screen, EUR on paper (thermal printers have no €)', inr(1234567) === '€1,234,567' && inrx(10.5) === '€10.50' && currencySymbol() === '€'
  && REGIONS.IE.currency === 'EUR' && REGIONS.IE.printSymbol === 'EUR ' && regionOf('ie') === REGIONS.IE);
{
  const ie = moneyFor('IE'), inn = moneyFor(undefined);
  check('receipts the server sends: in the shop\'s currency (€ for Ireland), India unchanged by default', ie(1234.5) === '€1,234.50' && inn(123456) === '₹1,23,456' && moneyFor('US')(5) === '$5');
}
configureMoney(null);
check('back to India when no region is given', inr(1234567) === '₹12,34,567');
configureDates('en-US');
check('dates follow the region\'s locale (US: month first)', dayLab('2026-10-05') === 'Oct 5');
configureDates('');
check('...and India by default again', dayLab('2026-10-05') === '5 Oct');
check('phone numbers as WhatsApp wants them, India the same as before', phoneDigits('98765 43210') === '919876543210' && phoneDigits('098765 43210') === '919876543210'
  && phoneDigits('+91 98765 43210') === '919876543210' && phoneDigits('12345') === '' && phoneDigits('') === '');
check('...other countries with their own code and length', phoneDigits('050 123 4567', REGIONS.AE) === '971501234567' && phoneDigits('07700 900123', REGIONS.GB) === '447700900123'
  && phoneDigits('(415) 555-0132', REGIONS.US) === '14155550132' && phoneDigits('8123 4567', REGIONS.SG) === '6581234567');
check('a region code is found in any case; an unknown one is India', regionOf('ae').currency === 'AED' && regionOf('xx').code === 'IN' && regionOf(undefined).code === 'IN');
check('every region: a currency with 2 decimals (what the money core counts in), a locale, a dialling code', Object.values(REGIONS).every((r) => r.minor === 2 && r.locale && /^\d+$/.test(r.phoneCode) && r.phoneDigits >= 8));
check('compact parts on their own', compactParts(1e7, REGIONS.IN) === '1Cr' && compactParts(1e6, REGIONS.US) === '1M');

// ---- one money path for every output (screen, PDF, receipt printer), labels, typed money, words ----
{
  const { formatMoney, printText, moneyLabel, currencySign, currencyName, stripMoney, currencyMarkSource, numberText } = await import('../../src/shared/formatting/money.js');
  const { amountInWords } = await import('../../src/domain/invoices/amount-words.js');
  configureMoney(REGIONS.IN);
  check('India, screen: ₹ and Indian grouping (unchanged)', formatMoney(1234567.4) === '₹12,34,567' && formatMoney(1048.95, { exact: true }) === '₹1,048.95');
  check('India, PDF (no ₹ in the built-in fonts): Rs.', formatMoney(1500, { output: 'pdf', decimals: 2 }) === 'Rs.1,500.00' && formatMoney(-20, { output: 'pdf', exact: true }) === '-Rs.20');
  check('India, receipt printer (ASCII): Rs., and figures only for the columns', formatMoney(1049.5, { output: 'thermal', decimals: 2 }) === 'Rs.1,049.50' && formatMoney(1049.5, { output: 'thermal', decimals: 2, symbol: false }) === '1,049.50');
  check('text for a PDF / printer: ₹ in any sentence becomes Rs.; plain text is untouched', printText('Discount ₹50 on ₹1,000', 'pdf') === 'Discount Rs.50 on Rs.1,000' && printText('No money', 'thermal') === 'No money' && printText('₹5', 'screen') === '₹5');
  check('labels and words: "Selling price (₹)", the sign, "rupees", counts in Indian grouping', moneyLabel('Selling price') === 'Selling price (₹)' && currencySign() === '₹' && currencyName() === 'rupees' && numberText(150000) === '1,50,000');
  check('typed money: ₹, Rs., Rs and INR are taken off (any case); "Mrs" is left alone', stripMoney('₹1,099.00') === '1099.00' && stripMoney('Rs. 12.5') === '12.5' && stripMoney('rs499') === '499' && stripMoney('INR 2,000') === '2000' && stripMoney('Mrs 5') === 'Mrs5');
  const re = new RegExp(currencyMarkSource() + '\\s*(\\d+)', 'i');
  check('the marks as a pattern find "Rs 499" and "₹499" in a sentence', re.exec('a phone for Rs 499')[1] === '499' && re.exec('only ₹499')[1] === '499');
  check('amounts in words: India as before (Rupees … Paise, lakh)', amountInWords(150048.5) === 'Rupees One Lakh Fifty Thousand Forty Eight and Fifty Paise Only');
  configureMoney(REGIONS.AE);
  check('UAE, screen and printer: AED with international grouping; PDF keeps AED', formatMoney(1234567) === 'AED 1,234,567' && formatMoney(5, { output: 'thermal', decimals: 2 }) === 'AED 5.00' && formatMoney(5, { output: 'pdf' }) === 'AED 5');
  check('UAE labels and words: "Price (AED)", dirhams, million', moneyLabel('Price') === 'Price (AED)' && currencyName() === 'dirhams' && amountInWords(2500000.25) === 'Dirhams Two Million Five Hundred Thousand and Twenty Five Fils Only');
  check('UAE typed money: AED taken off; a rupee amount is not taken for a number', stripMoney('AED 1,200') === '1200' && stripMoney('₹1,200') === '₹1200');
  configureMoney(REGIONS.GB);
  check('UK: £ on screen and in a PDF (the fonts have £), GBP on a receipt printer', formatMoney(12) === '£12' && formatMoney(12, { output: 'pdf' }) === '£12' && formatMoney(12, { output: 'thermal' }) === 'GBP 12');
  configureMoney(REGIONS.US);
  check('US: $ everywhere, Dollars and Cents in words', formatMoney(1000.5, { output: 'thermal', decimals: 2 }) === '$1,000.50' && amountInWords(1.05) === 'Dollars One and Five Cents Only');
  configureMoney(REGIONS.IN);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
