// Bank accounts (domain/finance/bank-accounts.js): checking an account and an entry, which account UPI and card money lands
// in, one default and one account per method, transfers and adjustments, reversals, and each account's running ledger.
import { bankBalances, bankLedger, checkBankAccount, checkBankMove, exclusiveChanges, methodAccounts, reverseBankMove } from '../../src/domain/finance/bank-accounts.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if(ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };

// ---------- accounts ----------
{
  const ok = checkBankAccount({ name: '  HDFC  Current ', bank: 'HDFC Bank', last4: '4321', opening: '50000.5', openingDate: '2026-10-01', methods: ['upi', 'cash', 'upi'] }, '2026-10-04');
  check('an account: name tidied, last 4, opening in rupees, only UPI / card methods, active by default', ok.account && ok.account.name === 'HDFC Current' && ok.account.last4 === '4321'
    && ok.account.opening === 50000.5 && JSON.stringify(ok.account.methods) === '["upi"]' && ok.account.active === true, ok);
  check('a name is needed', checkBankAccount({ name: ' ' }, '2026-10-04').field === 'name');
  check('only the last 4 digits (never the account number)', checkBankAccount({ name: 'A', last4: '123456789012' }, '2026-10-04').field === 'last4');
  check('the opening balance is a number with at most 2 decimals', checkBankAccount({ name: 'A', opening: 'abc' }, '2026-10-04').field === 'opening' && checkBankAccount({ name: 'A', opening: '1.234' }, '2026-10-04').field === 'opening');
  check('no opening date in the future', checkBankAccount({ name: 'A', openingDate: '2026-12-01' }, '2026-10-04').field === 'openingDate');
  check('an empty opening balance is 0, dated today', JSON.stringify(checkBankAccount({ name: 'A' }, '2026-10-04').account) === JSON.stringify({ id: '', name: 'A', bank: '', last4: '', opening: 0, openingDate: '2026-10-04', active: true, isDefault: false, methods: [] }));
}
// ---------- where money lands ----------
const HDFC = { id: 'hdfc', name: 'HDFC Current', opening: 50000, openingDate: '2026-10-01', active: true, isDefault: true, methods: ['upi'] };
const ICICI = { id: 'icici', name: 'ICICI Savings', opening: 12000, openingDate: '2026-10-01', active: true, isDefault: false, methods: ['card'] };
const OLD = { id: 'old', name: 'Old SBI', opening: 0, openingDate: '2026-10-01', active: false, isDefault: false, methods: [] };
{
  check('UPI → the account that takes it, card → its own', JSON.stringify(methodAccounts([HDFC, ICICI, OLD])) === '{"upi":"hdfc","card":"icici"}');
  check('a method nobody takes goes to the default account', methodAccounts([Object.assign({}, HDFC, { methods: [] }), ICICI]).upi === 'hdfc');
  check('a switched-off account takes nothing', methodAccounts([Object.assign({}, ICICI, { active: false })]).card === null);
  const ch = exclusiveChanges([HDFC, ICICI], { id: 'new', isDefault: true, methods: ['card'] });
  check('a new default with the card takes them off the others', ch.length === 2 && ch.find((a) => a.id === 'hdfc').isDefault === false && JSON.stringify(ch.find((a) => a.id === 'icici').methods) === '[]', ch);
}
// ---------- entries ----------
const accounts = [HDFC, ICICI, OLD];
{
  check('money in / out: an amount and an active account', checkBankMove({ type: 'in', account: 'hdfc', amount: '2500' }, { accounts }).move.amount === 2500
    && checkBankMove({ type: 'out', account: 'hdfc', amount: '0' }, { accounts }).field === 'amount' && checkBankMove({ type: 'in', account: 'old', amount: '5' }, { accounts }).field === 'account');
  check('a transfer goes to another active account', checkBankMove({ type: 'transfer', account: 'hdfc', to: 'hdfc', amount: '5' }, { accounts }).field === 'to'
    && checkBankMove({ type: 'transfer', account: 'hdfc', to: 'old', amount: '5' }, { accounts }).field === 'to' && checkBankMove({ type: 'transfer', account: 'hdfc', to: 'icici', amount: '5' }, { accounts }).move.to === 'icici');
  const adj = checkBankMove({ type: 'adjust', account: 'hdfc', amount: '118', direction: 'down', reason: 'Bank charges' }, { accounts });
  check('an adjustment says why and may take the balance down', checkBankMove({ type: 'adjust', account: 'hdfc', amount: '1' }, { accounts }).field === 'reason' && adj.move.amount === -118, adj);
}
// ---------- the ledger ----------
{
  const moves = [
    { id: 'm1', type: 'in', account: 'hdfc', amount: 2500, t: Date.parse('2026-10-02T10:00:00'), reason: 'Loan' },
    { id: 'm2', type: 'transfer', account: 'hdfc', to: 'icici', amount: 5000, t: Date.parse('2026-10-02T11:00:00') },
    { id: 'm3', type: 'adjust', account: 'hdfc', amount: -118, t: Date.parse('2026-10-03T09:00:00'), reason: 'Bank charges' },
  ];
  const bankEntries = [
    { id: 'bb:1', type: 'receipt', method: 'upi', in: 1000, out: 0, t: Date.parse('2026-10-02T12:00:00'), billNo: 'INV-1', status: 'posted', verification: 'unverified' },
    { id: 'bb:2', type: 'receipt', method: 'card', in: 700, out: 0, t: Date.parse('2026-10-02T12:30:00'), billNo: 'INV-2', status: 'posted' },
    { id: 'bb:3', type: 'refund', method: 'upi', in: 0, out: 200, t: Date.parse('2026-10-03T12:00:00'), billNo: 'INV-1', status: 'posted' },
    { id: 'bb:4', type: 'receipt', method: 'upi', in: 999, out: 0, t: Date.parse('2026-09-20T12:00:00'), billNo: 'INV-0', status: 'posted' },
    { id: 'bb:5', type: 'receipt', method: 'upi', in: 400, out: 0, t: Date.parse('2026-10-03T13:00:00'), billNo: 'INV-3', status: 'cancelled' },
  ];
  const ctx = { accounts, moves, bankEntries };
  const H = bankLedger(HDFC, ctx), I = bankLedger(ICICI, ctx);
  check('HDFC: opening 50,000 + loan 2,500 − transfer 5,000 + UPI 1,000 − refund 200 − charges 118 = 48,182', H.balance === 48182, H.entries.map((e) => [e.label, e.amount, e.balance]));
  check('…UPI before the opening date is not counted; a cancelled bill is listed but not counted', !H.entries.some((e) => e.id === 'bb:4') && H.entries.some((e) => e.id === 'bb:5' && e.status === 'cancelled'));
  check('ICICI: opening 12,000 + transfer 5,000 + card 700 = 17,700', I.balance === 17700 && I.entries.some((e) => e.label === 'Transfer from HDFC Current'), I.entries.map((e) => [e.label, e.amount]));
  const rv = reverseBankMove('m2', 'Entered twice', { moves });
  check('reversing a transfer: the same accounts and amount, with the reason', rv.move && rv.move.type === 'reversal' && rv.move.reverses === 'm2' && rv.move.to === 'icici' && rv.move.amount === 5000, rv);
  const moves2 = [...moves, Object.assign({}, rv.move, { id: 'r2', t: Date.parse('2026-10-03T10:00:00') })];
  check('…puts both balances back', bankLedger(HDFC, { accounts, moves: moves2, bankEntries }).balance === 53182 && bankLedger(ICICI, { accounts, moves: moves2, bankEntries }).balance === 12700);
  check('a reversal needs a reason, happens once, and is never reversed', !!reverseBankMove('m2', 'no', { moves }).error && !!reverseBankMove('m2', 'Again please', { moves: moves2 }).error && !!reverseBankMove('r2', 'Undo it', { moves: moves2 }).error);
  const B = bankBalances(ctx);
  check('balances: active accounts (default first), total of the active ones', B.rows[0].account.id === 'hdfc' && B.rows.at(-1).account.id === 'old' && B.total === 65882, B);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
