// The global-ready core (src/shared/formatting/regions.js, money.js, dates.js): India stays exactly as it was (₹, lakh and
// crore, en-IN dates, +91), and another region writes money, short money, dates and phone numbers its own way from one
// place. Run: npm run test:unit
import { REGIONS, compactParts, phoneDigits, regionOf } from '../../src/shared/formatting/regions.js';
import { configureMoney, currencySymbol, inr, inrShort, inrx } from '../../src/shared/formatting/money.js';
import { configureDates, dayLab, dayLong } from '../../src/shared/formatting/dates.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
