// Customers: details rules, duplicates, search by name / mobile, and the SaveCustomer use case with a fake repository.
// Run: npm run test:unit
import { checkCustomer, findDuplicate, mobileKey, searchCustomers, tidyCustomer, typeLabel } from '../../src/domain/customers/customer.js';
import { saveCustomer, setBillCustomer } from '../../src/features/customers/use-cases/save-customer.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}

// ---------- rules ----------
const t = tidyCustomer({ name: '  Meera   Shah ', phone: ' +91 98765 43210 ', email: ' Meera@Mail.COM ', gstin: '27abcde1234f1z5', type: 'business' });
check('details are tidied (single spaces, email lower case, GSTIN upper case)', t.name === 'Meera Shah' && t.email === 'meera@mail.com' && t.gstin === '27ABCDE1234F1Z5' && t.type === 'business');
check('customer type is individual unless it says business', tidyCustomer({ name: 'x' }).type === 'individual' && tidyCustomer({ name: 'x', type: 'hacker' }).type === 'individual' && typeLabel('business') === 'Business');
check('name is required (business name for a business)', checkCustomer(tidyCustomer({})).field === 'name' && /business name/.test(checkCustomer(tidyCustomer({ type: 'business' })).error));
check('mobile needs at least 10 digits', checkCustomer(tidyCustomer({ name: 'A', phone: '12345' })).field === 'phone' && checkCustomer(tidyCustomer({ name: 'A', phone: '98765 43210' })) === null);
check('email and GSTIN are checked when given', checkCustomer(tidyCustomer({ name: 'A', email: 'nope' })).field === 'email' && checkCustomer(tidyCustomer({ name: 'A', gstin: '27ABC' })).field === 'gstin');
check('the same mobile written differently is one number', mobileKey('+91 98765-43210') === mobileKey('9876543210'));
const list = [{ id: 'a', name: 'Meera Shah', phone: '9876543210', t: 1 }, { id: 'b', name: 'Shah Traders', phone: '', gstin: '27ABCDE1234F1Z5', type: 'business', t: 2 }, { id: 'c', name: 'Arjun', phone: '9123456780', t: 3 }];
check('duplicate by mobile (any format)', findDuplicate(list, tidyCustomer({ name: 'M', phone: '+91 98765 43210' })).customer.id === 'a');
check('duplicate by GSTIN', findDuplicate(list, tidyCustomer({ name: 'X', gstin: '27abcde1234f1z5' })).by === 'gstin');
check('editing a customer is not a duplicate of itself', findDuplicate(list, tidyCustomer({ name: 'M', phone: '9876543210' }), 'a') === null);
check('search by name (word start, any case; equal matches most recent first)', JSON.stringify(searchCustomers(list, 'shah').map((c) => c.id)) === '["b","a"]' && searchCustomers(list, 'trad')[0].id === 'b' && searchCustomers(list, 'meera shah')[0].id === 'a');
check('search by mobile (full or last digits)', searchCustomers(list, '9876543210')[0].id === 'a' && searchCustomers(list, '6780')[0].id === 'c');
check('no search → everyone, most recent first', searchCustomers(list, '').map((c) => c.id).join() === 'c,b,a');
check('no match → nothing', searchCustomers(list, 'zzz').length === 0);

// ---------- SaveCustomer with a fake repository ----------
const saved = [], rows = {};
const mem = {};
const undo = override({ storage: { get: (k, f) => (k in mem ? mem[k] : f), set: (k, v) => { mem[k] = v; return true; }, getRaw: (k) => mem[k] ?? null, setRaw: (k, v) => { mem[k] = v; }, remove: (k) => { delete mem[k]; } }, customerRepository: { list: () => Object.values(rows), get: (id) => rows[id] || null, save: (c) => { rows[c.id] = c; saved.push(c.id); return c; } } });
store.cart = []; store.cartCust = null;
let r = saveCustomer({ name: 'Meera Shah', phone: '98765 43210', type: 'individual' });
check('create: saved with an id, individual', r.created && rows[r.customer.id].name === 'Meera Shah' && rows[r.customer.id].type === 'individual' && saved.length === 1);
const meera = r.customer.id;
r = saveCustomer({ name: 'Shah Traders', gstin: '27ABCDE1234F1Z5', type: 'business' });
check('create a business with its GSTIN', r.created && r.customer.type === 'business' && r.customer.gstin === '27ABCDE1234F1Z5');
r = saveCustomer({ name: 'Someone', phone: '+91 9876543210' });
check('a second customer with the same mobile is refused, naming the first', r.error === 'Meera Shah already has this mobile number.' && r.duplicate.id === meera && saved.length === 2);
r = saveCustomer({ name: 'Bad', phone: '12' });
check('invalid details save nothing', r.field === 'phone' && saved.length === 2);
setBillCustomer(rows[meera]);
r = saveCustomer({ name: 'Meera S. Shah', phone: '9876543210', email: 'meera@mail.com', type: 'individual' }, { id: meera });
check('edit: same id, new details, created stays false', !r.created && r.customer.id === meera && rows[meera].name === 'Meera S. Shah' && rows[meera].email === 'meera@mail.com');
check('editing the customer on the open bill updates the bill too', store.cartCust.name === 'Meera S. Shah');
setBillCustomer(null);
check('continue without customer: the bill has none', store.cartCust === null);
undo();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
