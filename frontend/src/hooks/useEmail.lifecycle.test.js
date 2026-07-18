import { renderHook, act } from '@testing-library/react';
import { useEmail } from './useEmail';
import { API_BASE } from '../utils/constants';

// ---------------------------------------------------------------------------
// Request-lifecycle regression tests for the idle-storm fix.
//
// Root cause (fixed): loadEmailsForAccount took `connectedAccounts` as a hook
// dependency. App.js's loadAccounts depends on loadEmailsForAccount and SETS
// connectedAccounts (a fresh array each call), so the dep made loadAccounts
// churn identity, re-run its mount effect, and reload accounts+docs+events+mail
// in a tight loop (~140 req/s idle). loadEmailsForAccount now reads
// connectedAccounts via a ref, so its identity is STABLE across renders — which
// is what breaks the loop at its source. These tests lock that property plus the
// in-flight dedup and last-known-good behavior.
// ---------------------------------------------------------------------------

const listUrls = (fetchMock) =>
  fetchMock.mock.calls
    .map((c) => (typeof c[0] === 'string' ? c[0] : c[0]?.url))
    .filter((u) => u && /\/emails\/[^/]+\?category=/.test(u));

function okList(emails = []) {
  return { ok: true, status: 200, clone() { return this; }, json: async () => ({ emails }) };
}
function res429() {
  return { ok: false, status: 429, clone() { return this; }, json: async () => ({ error: 'Too many requests' }) };
}

const baseProps = {
  activeView: 'A', activeCategory: 'primary', searchQuery: '', conversationView: false,
  sendDelaySeconds: 0, setSuccessToast: () => {}, setError: () => {}, setIsAuthed: () => {},
  handleLogout: () => {}, splitMode: 'none', setFullPageReaderOpen: () => {},
  setShowMetadata: () => {}, setReaderCompact: () => {},
};

afterEach(() => { jest.restoreAllMocks(); delete global.fetch; });

test('loadEmailsForAccount identity is STABLE across renders (breaks the reload loop)', () => {
  global.fetch = jest.fn(async () => okList());
  const accounts = [{ id: 'A', gmail_email: 'a@x.com' }];
  const { result, rerender } = renderHook((props) => useEmail(props), {
    initialProps: { ...baseProps, connectedAccounts: accounts },
  });
  const first = result.current.loadEmailsForAccount;
  // Re-render with a NEW connectedAccounts array of equal content — this is
  // exactly what the old loop did (loadAccounts set a fresh array each cycle).
  rerender({ ...baseProps, connectedAccounts: [{ id: 'A', gmail_email: 'a@x.com' }] });
  expect(result.current.loadEmailsForAccount).toBe(first); // stable → no churn → no loop
});

test('an idle hook (no calls) issues zero list requests', () => {
  global.fetch = jest.fn(async () => okList());
  const accounts = [{ id: 'A', gmail_email: 'a@x.com' }];
  const { rerender } = renderHook((props) => useEmail(props), {
    initialProps: { ...baseProps, connectedAccounts: accounts },
  });
  // Several re-renders (simulating unrelated state churn) must not fetch.
  rerender({ ...baseProps, connectedAccounts: [...accounts] });
  rerender({ ...baseProps, connectedAccounts: [...accounts] });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('concurrent identical list loads collapse to one in-flight request', async () => {
  let resolve;
  global.fetch = jest.fn(() => new Promise((r) => { resolve = () => r(okList()); }));
  const { result } = renderHook(() => useEmail({ ...baseProps, connectedAccounts: [{ id: 'A' }] }));
  await act(async () => {
    result.current.loadEmailsForAccount('A', 'primary');
    result.current.loadEmailsForAccount('A', 'primary'); // duplicate — should dedup
    await Promise.resolve();
  });
  expect(listUrls(global.fetch)).toHaveLength(1);
  await act(async () => { resolve(); await Promise.resolve(); });
});

test('different accounts are never deduplicated together', async () => {
  global.fetch = jest.fn(async () => okList());
  const { result } = renderHook(() => useEmail({ ...baseProps, activeView: 'everything', connectedAccounts: [{ id: 'A' }, { id: 'B' }] }));
  await act(async () => {
    result.current.loadEmailsForAccount('A', 'primary');
    result.current.loadEmailsForAccount('B', 'primary');
    await Promise.resolve();
  });
  const urls = listUrls(global.fetch);
  expect(urls.some((u) => u.includes('/emails/A?'))).toBe(true);
  expect(urls.some((u) => u.includes('/emails/B?'))).toBe(true);
  expect(urls).toHaveLength(2);
});

test('a 429 refresh does NOT clear the already-loaded list (last-known-good)', async () => {
  global.fetch = jest.fn(async () => okList([{ id: 'm1', threadId: 'm1', date: '2024-01-01', subject: 's', from: 'a@x.com', isRead: true }]));
  const { result } = renderHook(() => useEmail({ ...baseProps, connectedAccounts: [{ id: 'A' }] }));
  await act(async () => { await result.current.loadEmailsForAccount('A', 'primary'); });
  expect(result.current.filteredEmails.length).toBe(1);

  // Now the backend starts 429ing; a refresh must retain the existing row.
  global.fetch = jest.fn(async () => res429());
  await act(async () => { await result.current.loadEmailsForAccount('A', 'primary'); });
  expect(result.current.filteredEmails.length).toBe(1); // preserved
  expect(result.current.emails.A.primary.length).toBe(1);
});

test('after a load resolves, the in-flight slot is freed (a later load runs)', async () => {
  global.fetch = jest.fn(async () => okList());
  const { result } = renderHook(() => useEmail({ ...baseProps, connectedAccounts: [{ id: 'A' }] }));
  await act(async () => { await result.current.loadEmailsForAccount('A', 'primary'); });
  await act(async () => { await result.current.loadEmailsForAccount('A', 'primary'); });
  // Two sequential (non-overlapping) loads → two requests (slot freed between).
  expect(listUrls(global.fetch)).toHaveLength(2);
});

test("one account's 429 does not erase another account's loaded data", async () => {
  // Account A returns data; account B 429s. B's failure must not touch A.
  global.fetch = jest.fn(async (url) => {
    const u = typeof url === 'string' ? url : url?.url || '';
    if (u.includes('/emails/B?')) return res429();
    return okList([{ id: 'a1', threadId: 'a1', date: '2024-01-02', subject: 'A', from: 'a@x.com', isRead: true }]);
  });
  const { result } = renderHook(() => useEmail({ ...baseProps, activeView: 'everything', connectedAccounts: [{ id: 'A' }, { id: 'B' }] }));
  await act(async () => {
    await result.current.loadEmailsForAccount('A', 'primary');
    await result.current.loadEmailsForAccount('B', 'primary');
  });
  expect((result.current.emails.A?.primary || []).length).toBe(1); // A intact
  expect((result.current.emails.B?.primary || []).length || 0).toBe(0); // B never populated, but A survives
});
