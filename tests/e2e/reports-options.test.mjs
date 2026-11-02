// Variant performance in Reports for any shop (spec Phase 19, item 62): a phone with Colour × Storage, a kurta with Size,
// rice with Pack Size and a cable with no options — "Sold by option" offers each option by the name the shop gave it, its
// chart and table use that name and the shop's order of values, "Product × <option>" follows the choice, and nothing
// says "size" for an option that isn't one. PGlite runs the real schema.sql.
import { createReport } from '../helpers/report.mjs';
import { sleep, startShop } from '../helpers/app.mjs';
import { sellBill } from '../helpers/shop-fixtures.mjs';

const R = createReport();
const S = await startShop({ report: R, uid: 'aaaaaaaa-0000-0000-0000-0000000000c5', email: 'options@example.com', shop: { shop_name: 'Gadget and Grocery', gstin: '' } });
const A = await S.openDevice();
const ids = await A.run(`
  openEditor(null);editor.name="Phone";editor.price="25000";editor.hasOpts=true;edAddOption("Colour");edAddValues(0,["Black","Blue"]);edAddOption("Storage");edAddValues(1,["128GB","256GB"]);edCombos().forEach(c=>{c.cell.stock="5"});saveEditor();
  openEditor(null);editor.name="Kurta";editor.price="1000";editor.hasOpts=true;edAddOption("Size");edAddValues(0,["M","L"]);edCombos().forEach(c=>{c.cell.stock="5"});saveEditor();
  openEditor(null);editor.name="Rice";editor.price="300";editor.hasOpts=true;edAddOption("Pack Size");edAddValues(0,["1kg","5kg"]);edCombos().forEach(c=>{c.cell.stock="9"});saveEditor();
  openEditor(null);editor.name="USB cable";editor.price="299";edCombos()[0].cell.stock="20";saveEditor();
  closeModal();await flushSbQueue();
  const v=(n,o)=>products().find(p=>p.name===n).variants.find(x=>JSON.stringify(x.o)===JSON.stringify(o)).id;
  return { products: { ph256: { variant: v("Phone",["Black","256GB"]) }, ph128: { variant: v("Phone",["Blue","128GB"]) }, kurtaL: { variant: v("Kurta",["L"]) }, rice5: { variant: v("Rice",["5kg"]) },
    usb: { variant: products().find(p=>p.name==="USB cable").variants[0].id } } };`);
for(const b of [{ lines: [['ph256', 2], ['ph128', 1]] }, { lines: [['kurtaL', 1], ['rice5', 3]] }, { lines: [['usb', 4]] }]) await sellBill(A, ids, { ...b, pay: 'cash' });
await A.run('prefs.period="today";savePrefs()'); await A.go('report', 400);

R.section('Sold by option');
const chips = await A.page.$$eval('#v-report [data-repopt]', (b) => b.map((x) => x.textContent.trim()));
R.check('an option chip for each option sold, by the shop\'s own names (most pieces first)', JSON.stringify(chips) === JSON.stringify(['Colour', 'Pack Size', 'Storage', 'Size']), chips);
R.check('no clothing words for what isn\'t clothing: the card is "Sold by option"', /Sold by option/.test(await A.text('#v-report') || '') && !/Sizes that sold/.test(await A.text('#v-report') || ''));
await A.click('#v-report [data-repopt="Storage"]', 400);
await A.click('#v-report [data-table="size"]', 300);
const table = await A.page.$$eval('#chSize tr', (r) => r.map((x) => [...x.children].map((c) => c.textContent.trim())));
R.check('Storage, as a table: the shop\'s order (128GB before 256GB), pieces and share', JSON.stringify(table) === JSON.stringify([['Storage', 'Pieces', 'Share'], ['128GB', '1', '33%'], ['256GB', '2', '67%']]), table);
R.check('…the grid follows: Product × storage, the phone\'s storages as columns', /Product × storage/.test(await A.text('#v-report') || '') && (await A.page.$$eval('#v-report table.hm thead th', (t) => t.map((x) => x.textContent.trim()))).join() === 'Product,128GB,256GB,Pieces,Amount');
await A.click('#v-report [data-repopt="Pack Size"]', 400);
R.check('Pack Size: the rice\'s 5kg packs', /5kg/.test(await A.text('#chSize') || '') && (await A.page.$$eval('#chSize tr', (r) => r.length)) === 2);
await A.click('#v-report [data-table="size"]', 300);
R.check('as a chart again, each bar labelled with the option\'s own name ("Pack Size 5kg")', await A.exists('#chSize svg') && /data-tipl="Pack Size 5kg"/.test(await A.page.$eval('#chSize', (e) => e.innerHTML)));
R.check('the cable (no options) is counted apart, not as "One size"', !/One size/.test(await A.text('#v-report') || ''));
await R.done(() => S.close());
