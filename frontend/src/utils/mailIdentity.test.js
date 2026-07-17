import { mailKey, threadKey, emailKey, emailThreadKey, sameMailItem } from './mailIdentity';

// Two accounts that intentionally share a provider-local message id (DUP1) and
// thread id (THREAD1) — the core adversarial fixture for the account-boundary
// invariant.
const ACCT_A = 'acct-aaaa';
const ACCT_B = 'acct-bbbb';
const A = { id: 'DUP1', threadId: 'THREAD1', accountId: ACCT_A };
const B = { id: 'DUP1', threadId: 'THREAD1', accountId: ACCT_B };

describe('mailIdentity — composite keys', () => {
  test('mailKey matches the legacy emailCache key format exactly', () => {
    // Load-bearing: must equal `${accountId || ''}:${messageId}` so persisted
    // IndexedDB records stay readable.
    expect(mailKey(ACCT_A, 'DUP1')).toBe('acct-aaaa:DUP1');
    expect(mailKey(undefined, 'DUP1')).toBe(':DUP1');
    expect(mailKey('', 'DUP1')).toBe(':DUP1');
  });

  test('same provider-local id in two accounts yields DISTINCT keys', () => {
    expect(emailKey(A)).not.toBe(emailKey(B));
    expect(emailKey(A)).toBe('acct-aaaa:DUP1');
    expect(emailKey(B)).toBe('acct-bbbb:DUP1');
  });

  test('threadKey / emailThreadKey keep same-threadId threads separate per account', () => {
    expect(threadKey(ACCT_A, 'THREAD1')).not.toBe(threadKey(ACCT_B, 'THREAD1'));
    expect(emailThreadKey(A)).toBe('acct-aaaa:THREAD1');
    expect(emailThreadKey(B)).toBe('acct-bbbb:THREAD1');
  });

  test('emailThreadKey falls back to message id when threadId is absent', () => {
    expect(emailThreadKey({ id: 'DUP1', accountId: ACCT_A })).toBe('acct-aaaa:DUP1');
  });
});

describe('mailIdentity — sameMailItem', () => {
  test('is false for identical provider ids across different accounts', () => {
    expect(sameMailItem(A, B)).toBe(false);
  });

  test('is true only when both account and id match', () => {
    expect(sameMailItem(A, { id: 'DUP1', accountId: ACCT_A })).toBe(true);
  });

  test('handles nullish inputs and nullish account ids', () => {
    expect(sameMailItem(null, A)).toBe(false);
    expect(sameMailItem(A, undefined)).toBe(false);
    expect(sameMailItem({ id: 'x' }, { id: 'x' })).toBe(true);
    expect(sameMailItem({ id: 'x', accountId: ACCT_A }, { id: 'x' })).toBe(false);
  });
});
