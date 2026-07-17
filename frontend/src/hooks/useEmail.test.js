import { renderHook, act } from '@testing-library/react';
import { useEmail } from './useEmail';
import { emailKey, mailKey, sameMailItem } from '../utils/mailIdentity';
import * as emailCache from '../utils/emailCache';
import * as apiErrors from '../utils/apiErrors';

// Isolate the hook's identity logic from IndexedDB and error-surfacing side
// effects. emailCache identity behavior is covered in utils/emailCache.test.js.
jest.mock('../utils/emailCache', () => ({
  getCached: jest.fn(),
  setCached: jest.fn(),
  setManyCached: jest.fn(),
  hydrateForIds: jest.fn(),
  maybeEvict: jest.fn(),
  setCachedList: jest.fn(),
  hydrateLists: jest.fn(),
}));
jest.mock('../utils/apiErrors', () => ({
  maybeHandleApiError: jest.fn(),
}));

const ACCT_A = 'acct-aaaa';
const ACCT_B = 'acct-bbbb';
const DUP = 'DUP1';
const THREAD = 'THREAD1';

const CONNECTED = [
  { id: ACCT_A, gmail_email: 'a@a.com', account_name: 'Account A' },
  { id: ACCT_B, gmail_email: 'b@b.com', account_name: 'Account B' },
];

// Fresh fixture each test — two accounts holding the SAME provider-local
// message id (DUP1) and thread id (THREAD1).
const fixture = () => ({
  [ACCT_A]: { primary: [{ id: DUP, threadId: THREAD, accountId: ACCT_A, from: 'alice@a.com', subject: 'Message from A', date: '2026-01-02T00:00:00Z', isRead: false, isStarred: false }] },
  [ACCT_B]: { primary: [{ id: DUP, threadId: THREAD, accountId: ACCT_B, from: 'bob@b.com', subject: 'Message from B', date: '2026-01-01T00:00:00Z', isRead: false, isStarred: false }] },
});
const itemA = () => ({ id: DUP, threadId: THREAD, accountId: ACCT_A, from: 'alice@a.com', subject: 'Message from A', date: '2026-01-02T00:00:00Z', isRead: false });
const itemB = () => ({ id: DUP, threadId: THREAD, accountId: ACCT_B, from: 'bob@b.com', subject: 'Message from B', date: '2026-01-01T00:00:00Z', isRead: false });

const baseProps = (overrides = {}) => ({
  connectedAccounts: CONNECTED,
  activeView: 'everything',
  activeCategory: 'primary',
  searchQuery: '',
  conversationView: false,
  sendDelaySeconds: 0,
  setSuccessToast: jest.fn(),
  setError: jest.fn(),
  setIsAuthed: jest.fn(),
  handleLogout: jest.fn(),
  splitMode: 'vertical',
  setFullPageReaderOpen: jest.fn(),
  setShowMetadata: jest.fn(),
  setReaderCompact: jest.fn(),
  ...overrides,
});

function setup(overrides) {
  const props = baseProps(overrides);
  const view = renderHook((p) => useEmail(p), { initialProps: props });
  act(() => { view.result.current.setEmails(fixture()); });
  return { ...view, props };
}

beforeEach(() => {
  localStorage.clear();
  // CRA's jest config resets mock implementations before each test — re-establish
  // the emailCache/apiErrors stubs so the hook's IDB + error paths are inert.
  emailCache.getCached.mockResolvedValue(null);
  emailCache.setCached.mockResolvedValue(undefined);
  emailCache.setManyCached.mockResolvedValue(undefined);
  emailCache.hydrateForIds.mockResolvedValue({ bodies: {}, headers: {}, attachments: {} });
  emailCache.maybeEvict.mockResolvedValue(undefined);
  emailCache.setCachedList.mockResolvedValue(undefined);
  emailCache.hydrateLists.mockResolvedValue({});
  apiErrors.maybeHandleApiError.mockResolvedValue(false);
  global.fetch = jest.fn(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ body: '<p>body</p>', headers: {}, attachments: [], messages: [] }),
    headers: { get: () => null },
  }));
});

describe('useEmail — account boundary integrity (two accounts, shared DUP1/THREAD1)', () => {
  test('unified search: both accounts\' colliding-id messages survive dedup', () => {
    const { result } = setup({ searchQuery: 'message' });
    const list = result.current.filteredEmails;
    expect(list).toHaveLength(2);
    expect(new Set(list.map(e => e.accountId))).toEqual(new Set([ACCT_A, ACCT_B]));
  });

  test('conversation view: same threadId in two accounts forms TWO separate groups', () => {
    const { result } = setup({ conversationView: true });
    const groups = result.current.getCurrentEmails();
    expect(groups).toHaveLength(2);
    // Each group is a single-account conversation of 1 message.
    expect(groups.every(g => g.threadCount === 1)).toBe(true);
    expect(new Set(groups.map(g => g.accountId))).toEqual(new Set([ACCT_A, ACCT_B]));
  });

  test('star override is isolated to the acted-on account', async () => {
    const { result } = setup();
    await act(async () => { await result.current.starEmail(itemA()); });
    expect(result.current.starredOverrides[emailKey(itemA())]).toBe(true);
    expect(result.current.starredOverrides[emailKey(itemB())]).toBeUndefined();
  });

  test('selection is isolated to the acted-on account', () => {
    const { result } = setup();
    act(() => { result.current.toggleSelectId(itemA()); });
    expect(result.current.selectedIds.has(emailKey(itemA()))).toBe(true);
    expect(result.current.selectedIds.has(emailKey(itemB()))).toBe(false);
  });

  test('batch action targets only the selected account', async () => {
    const { result, props } = setup();
    act(() => { result.current.toggleSelectId(itemA()); });
    act(() => { result.current.batchAction('archive'); });

    // batchAction hands the real network work to the toast's executeFn.
    const toastArg = props.setSuccessToast.mock.calls.at(-1)[0];
    expect(typeof toastArg.executeFn).toBe('function');
    global.fetch.mockClear();
    await act(async () => { await toastArg.executeFn(); });

    const batchUrls = global.fetch.mock.calls.map(c => c[0]).filter(u => String(u).includes('/batch'));
    expect(batchUrls.some(u => u.includes(`/emails/${ACCT_A}/batch`))).toBe(true);
    expect(batchUrls.some(u => u.includes(`/emails/${ACCT_B}/batch`))).toBe(false);
  });

  test('optimistic archive removes only the acted-on account\'s message', () => {
    const { result } = setup();
    act(() => { result.current.archiveEmail(itemA()); });
    expect(result.current.emails[ACCT_A].primary).toHaveLength(0);
    expect(result.current.emails[ACCT_B].primary).toHaveLength(1);
    expect(result.current.emails[ACCT_B].primary[0].id).toBe(DUP);
  });

  test('optimistic read-mark is scoped to the acted-on account', async () => {
    const { result } = setup();
    await act(async () => { await result.current.loadEmailDetails(itemA()); });
    expect(result.current.emails[ACCT_A].primary[0].isRead).toBe(true);
    expect(result.current.emails[ACCT_B].primary[0].isRead).toBe(false);
  });

  test('navigation resolves the selected item by account, not first id match', async () => {
    const { result } = setup();
    // Select account B's message (index 1 in the date-sorted everything list:
    // A is newer so A=0, B=1). navigatePrev must land on A, proving it located
    // B at index 1 rather than matching A at index 0 by bare id.
    act(() => { result.current.setSelectedEmail(itemB()); });
    await act(async () => { result.current.navigatePrev(); });
    expect(result.current.selectedEmail.accountId).toBe(ACCT_A);
  });

  test('arrow-nav anchor: sameMailItem resolves B-DUP1 at its own index, not the first bare-id match', () => {
    // The list-navigation handlers (hook navigatePrev/Next and App.js
    // ArrowUp/ArrowDown) anchor with findIndex(sameMailItem). With A-DUP1 at
    // index 0 (newer) and B-DUP1 at index 1, anchoring from the selected
    // B item must resolve index 1 — the bare-id comparison this replaced
    // would have matched A at index 0.
    const { result } = setup();
    const list = result.current.filteredEmails;
    expect(list).toHaveLength(2);
    expect(list.findIndex(x => sameMailItem(x, itemB()))).toBe(1);
    expect(list.findIndex(x => x.id === itemB().id)).toBe(0); // the bug the fix removes
  });
});

describe('useEmail — single-account (non-everything) view normalization', () => {
  // Backend list objects carry NO accountId. getCurrentEmails is the
  // normalization boundary that must stamp the owning account id in
  // per-account view (activeView === the account id), or reader keys,
  // source chips, thread loading, and batch grouping all lose identity.
  const rawFixture = () => ({
    [ACCT_A]: { primary: [{ id: DUP, threadId: THREAD, from: 'alice@a.com', subject: 'Message from A', date: '2026-01-02T00:00:00Z', isRead: false, isStarred: false }] },
    [ACCT_B]: { primary: [{ id: DUP, threadId: THREAD, from: 'bob@b.com', subject: 'Message from B', date: '2026-01-01T00:00:00Z', isRead: false, isStarred: false }] },
  });

  function setupSingle() {
    const props = baseProps({ activeView: ACCT_A });
    const view = renderHook((p) => useEmail(p), { initialProps: props });
    act(() => { view.result.current.setEmails(rawFixture()); });
    return { ...view, props };
  }

  test('raw backend items are stamped with the view account id', () => {
    const { result } = setupSingle();
    const list = result.current.filteredEmails;
    expect(list).toHaveLength(1);
    expect(list[0].accountId).toBe(ACCT_A);
    expect(emailKey(list[0])).toBe(mailKey(ACCT_A, DUP));
  });

  test('reader/load path stores the body under the correct composite key', async () => {
    const { result } = setupSingle();
    const email = result.current.filteredEmails[0];
    await act(async () => { await result.current.loadEmailDetails(email); });
    // The reader reads emailBodies[emailKey(email)] — the store key must match.
    expect(result.current.emailBodies[mailKey(ACCT_A, DUP)]).toBe('<p>body</p>');
    expect(result.current.emailBodies[mailKey('', DUP)]).toBeUndefined();
    // The fetch hit the correct account's endpoint (derived from the item).
    expect(global.fetch.mock.calls.some(c => String(c[0]).includes(`/emails/${ACCT_A}/${DUP}`))).toBe(true);
  });

  test('batch grouping in single-account view targets the view account', async () => {
    const { result, props } = setupSingle();
    act(() => { result.current.toggleSelectId(result.current.filteredEmails[0]); });
    act(() => { result.current.batchAction('archive'); });
    const toastArg = props.setSuccessToast.mock.calls.at(-1)[0];
    global.fetch.mockClear();
    await act(async () => { await toastArg.executeFn(); });
    const batchUrls = global.fetch.mock.calls.map(c => c[0]).filter(u => String(u).includes('/batch'));
    expect(batchUrls.some(u => u.includes(`/emails/${ACCT_A}/batch`))).toBe(true);
    expect(batchUrls).toHaveLength(1);
  });
});
