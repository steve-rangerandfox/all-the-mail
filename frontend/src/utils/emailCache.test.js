// Isolated body/header/attachment hydration across two accounts that share a
// provider-local message id. Uses fake-indexeddb so the real IDB read path
// (openDb / hydrateForIds / getCached) runs in jsdom.
//
// Records are seeded through a raw, commit-awaited transaction (setCached is
// deliberately fire-and-forget, so awaiting it does not guarantee the write has
// flushed). The assertions target the module's READ + key SHAPE — i.e. the C2
// fix: hydrateForIds must return composite (account+id) keys, never bare ids.
import 'fake-indexeddb/auto';
import { getCached, hydrateForIds } from './emailCache';
import { mailKey } from './mailIdentity';

const DB_NAME = 'atm_email_cache';
const ACCT_A = 'acct-aaaa';
const ACCT_B = 'acct-bbbb';
const DUP = 'DUP1';

const entry = (accountId, body, from, attId) => ({
  key: mailKey(accountId, DUP), accountId, messageId: DUP,
  body, headers: { from }, attachments: [{ attachmentId: attId }], ts: Date.now(),
});

// Raw write that creates the schema if needed and resolves only after the
// transaction commits — deterministic, unlike the module's fire-and-forget put.
function seed(entries) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('bodies')) db.createObjectStore('bodies', { keyPath: 'key' }).createIndex('ts', 'ts');
      if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists', { keyPath: 'key' }).createIndex('ts', 'ts');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('bodies', 'readwrite');
      const store = tx.objectStore('bodies');
      for (const e of entries) store.put(e);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe('emailCache — account-scoped identity', () => {
  test('getCached returns the per-account record for a colliding message id', async () => {
    await seed([
      entry(ACCT_A, '<p>body A</p>', 'a@a.com', 'att-a'),
      entry(ACCT_B, '<p>body B</p>', 'b@b.com', 'att-b'),
    ]);
    const a = await getCached(ACCT_A, DUP);
    const b = await getCached(ACCT_B, DUP);
    expect(a.body).toBe('<p>body A</p>');
    expect(b.body).toBe('<p>body B</p>');
    expect(a.headers.from).toBe('a@a.com');
    expect(b.headers.from).toBe('b@b.com');
  });

  test('hydrateForIds returns COMPOSITE-keyed maps, not bare-id (no collapse)', async () => {
    await seed([
      entry(ACCT_A, '<p>body A</p>', 'a@a.com', 'att-a'),
      entry(ACCT_B, '<p>body B</p>', 'b@b.com', 'att-b'),
    ]);
    const { bodies, headers, attachments } = await hydrateForIds([
      { accountId: ACCT_A, messageId: DUP },
      { accountId: ACCT_B, messageId: DUP },
    ]);

    // Both accounts survive under distinct composite keys.
    expect(bodies[mailKey(ACCT_A, DUP)]).toBe('<p>body A</p>');
    expect(bodies[mailKey(ACCT_B, DUP)]).toBe('<p>body B</p>');
    expect(headers[mailKey(ACCT_A, DUP)].from).toBe('a@a.com');
    expect(headers[mailKey(ACCT_B, DUP)].from).toBe('b@b.com');
    expect(attachments[mailKey(ACCT_A, DUP)][0].attachmentId).toBe('att-a');
    expect(attachments[mailKey(ACCT_B, DUP)][0].attachmentId).toBe('att-b');

    // The bare provider id must NOT be a key (that would be the collapse bug).
    expect(bodies[DUP]).toBeUndefined();
    expect(Object.keys(bodies)).toHaveLength(2);
  });
});
