import { renderHook, act } from '@testing-library/react';
import { useEmail } from './useEmail';
import { API_BASE } from '../utils/constants';

// ---------------------------------------------------------------------------
// Blocker 1 regression tests — reader navigation must load ONLY the destination
// message and must never let a quota (429) failure erase valid inbox/reader
// state or account identity.
//
// These render the real useEmail hook with a mocked global.fetch so we can
// assert on the exact provider requests a single J/K navigation produces.
// ---------------------------------------------------------------------------

const API = API_BASE;

// Count only per-message body GETs: `${API}/emails/<aid>/<mid>` with no suffix.
// (Thread loads end in /thread, read-marks in /read, batch in /batch-bodies.)
const detailGetUrls = (fetchMock) =>
  fetchMock.mock.calls
    .map((c) => (typeof c[0] === 'string' ? c[0] : c[0]?.url))
    .filter((u) => u && /\/emails\/[^/]+\/[^/]+$/.test(u) && !u.endsWith('/thread') && !u.endsWith('/read') && !u.endsWith('/batch-bodies'));

function makeEmails(accountId, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    threadId: `m${i}`,
    accountId,
    from: `Sender ${i} <s${i}@x.com>`,
    subject: `Subject ${i}`,
    snippet: `snippet ${i}`,
    date: new Date(2024, 0, 1, 0, n - i).toISOString(), // strictly descending
    isRead: true, // avoid read-mark POST noise
  }));
}

function okDetail() {
  return {
    ok: true,
    status: 200,
    clone() { return this; },
    json: async () => ({ body: '<p>body</p>', headers: { from: 'a@x.com' }, attachments: [] }),
  };
}
function okThread() {
  return { ok: true, status: 200, clone() { return this; }, json: async () => ({ messages: [] }) };
}
function res429() {
  return { ok: false, status: 429, clone() { return this; }, json: async () => ({ error: 'Too many requests, please try again later' }) };
}

// Route a request URL to the right canned response.
function router(detailImpl = okDetail) {
  return jest.fn(async (url) => {
    const u = typeof url === 'string' ? url : url?.url || '';
    if (u.endsWith('/thread')) return okThread();
    if (u.endsWith('/read')) return { ok: true, status: 200, clone() { return this; }, json: async () => ({}) };
    if (u.endsWith('/batch-bodies')) return { ok: true, status: 200, clone() { return this; }, json: async () => ({ bodies: {} }) };
    // per-message detail GET
    return detailImpl();
  });
}

const baseProps = {
  activeView: 'A',
  activeCategory: 'primary',
  searchQuery: '',
  conversationView: false, // flat list — seeded rows map 1:1 to filteredEmails
  sendDelaySeconds: 0,
  setSuccessToast: () => {},
  setError: () => {},
  setIsAuthed: () => {},
  handleLogout: () => {},
  splitMode: 'none',
  setFullPageReaderOpen: () => {},
  setShowMetadata: () => {},
  setReaderCompact: () => {},
};

function renderEmail(accountId = 'A', n = 20) {
  const connectedAccounts = [{ id: accountId, gmail_email: 'a@x.com' }];
  const { result } = renderHook(() => useEmail({ ...baseProps, activeView: accountId, connectedAccounts }));
  act(() => { result.current.setEmails({ [accountId]: { primary: makeEmails(accountId, n) } }); });
  return result;
}

afterEach(() => { jest.restoreAllMocks(); delete global.fetch; });

test('a single reader navigation loads ONLY the destination message (no cascade)', async () => {
  global.fetch = router();
  const result = renderEmail('A', 20);

  // Open the reader on the first row.
  act(() => { result.current.setSelectedEmail(result.current.filteredEmails[0]); });
  const destKey = result.current.filteredEmails[1].id;

  global.fetch.mockClear();
  await act(async () => { result.current.navigateNext(); await Promise.resolve(); });

  const gets = detailGetUrls(global.fetch);
  // Exactly one destination body load — NOT ~16.
  expect(gets).toHaveLength(1);
  expect(gets[0]).toBe(`${API}/emails/A/${destKey}`);
  expect(result.current.selectedEmail.id).toBe(destKey);
});

test('no 15-message prefetch cascade fires on navigation', async () => {
  global.fetch = router();
  const result = renderEmail('A', 20);
  act(() => { result.current.setSelectedEmail(result.current.filteredEmails[0]); });

  global.fetch.mockClear();
  await act(async () => { result.current.navigateNext(); await Promise.resolve(); });

  // The old code issued 1 + ~15 detail GETs per press. Assert we are far below that.
  expect(detailGetUrls(global.fetch).length).toBeLessThanOrEqual(1);
});

test('rapid repeated next navigation does not create overlapping request bursts', async () => {
  global.fetch = router();
  const result = renderEmail('A', 20);
  act(() => { result.current.setSelectedEmail(result.current.filteredEmails[0]); });

  global.fetch.mockClear();
  await act(async () => {
    result.current.navigateNext();
    result.current.navigateNext();
    result.current.navigateNext();
    await Promise.resolve();
  });

  // Three distinct destinations → at most three destination loads, never 3×16.
  const gets = detailGetUrls(global.fetch);
  expect(gets.length).toBeLessThanOrEqual(3);
  expect(new Set(gets).size).toBe(gets.length); // all distinct — no dup bursts
});

test('cached destination content is reused — no refetch', async () => {
  global.fetch = router();
  const result = renderEmail('A', 20);
  act(() => { result.current.setSelectedEmail(result.current.filteredEmails[0]); });

  // First navigation loads + caches the destination body.
  await act(async () => { result.current.navigateNext(); await Promise.resolve(); await Promise.resolve(); });
  // Go back, then forward again to the same message.
  await act(async () => { result.current.navigatePrev(); await Promise.resolve(); });

  global.fetch.mockClear();
  await act(async () => { result.current.navigateNext(); await Promise.resolve(); });

  // The destination body is already in state → no new detail GET.
  expect(detailGetUrls(global.fetch)).toHaveLength(0);
});

test('a destination 429 does not erase the inbox or the reader denominator', async () => {
  global.fetch = router(res429); // every body load fails with quota error
  const result = renderEmail('A', 20);
  const before = result.current.filteredEmails.length;
  act(() => { result.current.setSelectedEmail(result.current.filteredEmails[0]); });

  await act(async () => { result.current.navigateNext(); await Promise.resolve(); await Promise.resolve(); });

  // Inbox list (the "of M" denominator) is intact despite the quota failure.
  expect(result.current.filteredEmails.length).toBe(before);
  expect(result.current.emails.A.primary.length).toBe(before);
});

test('account identity remains stable after a navigation body failure', async () => {
  global.fetch = router(res429);
  const result = renderEmail('A', 20);
  act(() => { result.current.setSelectedEmail(result.current.filteredEmails[0]); });

  await act(async () => { result.current.navigateNext(); await Promise.resolve(); });

  // The open message still belongs to account A — identity is not lost on 429.
  expect(result.current.selectedEmail.accountId).toBe('A');
});

test('J/K cursor movement with no reader open performs no body fetch', async () => {
  global.fetch = router();
  const result = renderEmail('A', 20);
  // No reader open → selectedEmail is null.
  expect(result.current.selectedEmail).toBeNull();

  global.fetch.mockClear();
  await act(async () => { result.current.navigateNext(); result.current.navigatePrev(); await Promise.resolve(); });

  // Navigation is a no-op with no reader open — zero destination loads.
  expect(detailGetUrls(global.fetch)).toHaveLength(0);
});

test('concurrent duplicate loadEmailDetails calls collapse to one fetch', async () => {
  global.fetch = router();
  const result = renderEmail('A', 20);
  const target = result.current.filteredEmails[5];

  global.fetch.mockClear();
  await act(async () => {
    // Fire two identical loads back-to-back before the first resolves.
    result.current.loadEmailDetails(target);
    result.current.loadEmailDetails(target);
    await Promise.resolve();
  });

  const gets = detailGetUrls(global.fetch).filter((u) => u === `${API}/emails/A/${target.id}`);
  expect(gets).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Reader-OPEN regression tests — clicking a row (onSelectEmail) must load ONLY
// the selected message + its one thread. An earlier implementation additionally
// fired a staggered setTimeout fan-out that prefetched the *next 25* rows'
// bodies on every open; with multiple connected accounts that burst exhausted
// the Google API quota. The canonical visible-inbox prefetch owner is the
// /batch-bodies effect, which remains unchanged. These use fake timers so a
// resurrected setTimeout cascade would be caught even though it fires later.
// ---------------------------------------------------------------------------

// Classify a per-message detail GET as belonging to a specific account+message,
// reusing the same suffix rules as detailGetUrls above.
const isDetailGet = (u) =>
  u && /\/emails\/[^/]+\/[^/]+$/.test(u) && !u.endsWith('/thread') && !u.endsWith('/read') && !u.endsWith('/batch-bodies');
const threadGetUrls = (fetchMock) =>
  fetchMock.mock.calls
    .map((c) => (typeof c[0] === 'string' ? c[0] : c[0]?.url))
    .filter((u) => u && u.endsWith('/thread'));

test('opening a row loads exactly one detail + one thread, with no next-25 fan-out', async () => {
  jest.useFakeTimers();
  try {
    global.fetch = router();
    // Seed well over the historical 25-row prefetch window so any resurrected
    // cascade would be unmistakable (26+ detail GETs instead of 1).
    const result = renderEmail('A', 30);
    const target = result.current.filteredEmails[0];

    global.fetch.mockClear();
    await act(async () => {
      result.current.onSelectEmail(target);
      // Flush the microtask queue so the synchronous detail/thread loads settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Advance well past the old staggered window (25 rows × 50ms = 1.25s).
    await act(async () => { jest.advanceTimersByTime(2000); await Promise.resolve(); });

    const detailGets = detailGetUrls(global.fetch);
    const threadGets = threadGetUrls(global.fetch);

    // Exactly one selected-message detail request...
    expect(detailGets).toEqual([`${API}/emails/A/${target.id}`]);
    // ...and exactly one selected-message thread request.
    expect(threadGets).toEqual([`${API}/emails/A/${target.threadId}/thread`]);
    // No later-row detail requests were emitted speculatively.
    const laterRowGets = detailGets.filter((u) => u !== `${API}/emails/A/${target.id}`);
    expect(laterRowGets).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});

// Account-aware seeding: alternating account A / account B rows that deliberately
// SHARE provider-local message and thread IDs (m0/m1/... in both mailboxes). A
// bare-id keyed prefetch or detail load would let account A's colliding id
// satisfy — or be requested for — account B's selection. The composite
// (account, id) identity must keep them distinct.
function makeAltAccountEmails(n) {
  return Array.from({ length: n }, (_, i) => {
    const accountId = i % 2 === 0 ? 'A' : 'B';
    return {
      id: `m${i}`,
      threadId: `m${i}`,
      accountId,
      from: `Sender ${i} <s${i}@x.com>`,
      subject: `Subject ${i}`,
      snippet: `snippet ${i}`,
      date: new Date(2024, 0, 1, 0, n - i).toISOString(),
      isRead: true,
    };
  });
}

function renderAltAccounts(n = 30) {
  const connectedAccounts = [
    { id: 'A', gmail_email: 'a@x.com' },
    { id: 'B', gmail_email: 'b@x.com' },
  ];
  // Everything view unifies both accounts into one visible list.
  const { result } = renderHook(() =>
    useEmail({ ...baseProps, activeView: 'everything', connectedAccounts })
  );
  const alt = makeAltAccountEmails(n);
  const byAccount = { A: { primary: [] }, B: { primary: [] } };
  alt.forEach((e) => byAccount[e.accountId].primary.push(e));
  act(() => { result.current.setEmails(byAccount); });
  return result;
}

test('opening an account-B row requests only account B detail/thread — no speculative account-A detail', async () => {
  jest.useFakeTimers();
  try {
    global.fetch = router();
    const result = renderAltAccounts(30);

    // Pick a row owned by account B whose provider-local id (mN) also exists in
    // account A's mailbox — the collision that a bare-id path would mishandle.
    const targetB = result.current.filteredEmails.find((e) => e.accountId === 'B');
    expect(targetB).toBeTruthy();

    global.fetch.mockClear();
    await act(async () => {
      result.current.onSelectEmail(targetB);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { jest.advanceTimersByTime(2000); await Promise.resolve(); });

    const detailGets = detailGetUrls(global.fetch);
    const threadGets = threadGetUrls(global.fetch);

    // The selected account-B detail + thread URLs are requested (account-scoped).
    expect(detailGets).toContain(`${API}/emails/B/${targetB.id}`);
    expect(threadGets).toContain(`${API}/emails/B/${targetB.threadId}/thread`);

    // Exactly one detail GET total — the selected message — and it is NOT the
    // colliding account-A message with the same provider-local id.
    expect(detailGets).toEqual([`${API}/emails/B/${targetB.id}`]);
    expect(detailGets).not.toContain(`${API}/emails/A/${targetB.id}`);
    const accountAGets = detailGets.filter((u) => u.startsWith(`${API}/emails/A/`));
    expect(accountAGets).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
