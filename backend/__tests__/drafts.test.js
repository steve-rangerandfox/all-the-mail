import { jest } from '@jest/globals';
import { resolveDraftId } from '../lib/drafts.js';

// A fake Gmail client whose drafts.list returns the provided pages in order.
function gmailWithPages(pages) {
  let i = 0;
  const calls = [];
  return {
    _calls: calls,
    users: {
      drafts: {
        list: jest.fn(async (params) => {
          calls.push(params);
          const page = pages[Math.min(i, pages.length - 1)];
          i += 1;
          return { data: page };
        }),
      },
    },
  };
}

describe('resolveDraftId — canonical Gmail draft identity', () => {
  test('resolves a draftId found on the first page', async () => {
    const gmail = gmailWithPages([{ drafts: [{ id: 'DRAFT_1', message: { id: 'MSG_1' } }, { id: 'DRAFT_2', message: { id: 'MSG_2' } }] }]);
    expect(await resolveDraftId(gmail, 'MSG_2')).toBe('DRAFT_2');
    expect(gmail.users.drafts.list).toHaveBeenCalledTimes(1);
  });

  test('paginates via nextPageToken to find a draft on a later page', async () => {
    const gmail = gmailWithPages([
      { drafts: [{ id: 'DRAFT_A', message: { id: 'MSG_A' } }], nextPageToken: 'p2' },
      { drafts: [{ id: 'DRAFT_TARGET', message: { id: 'MSG_TARGET' } }] },
    ]);
    expect(await resolveDraftId(gmail, 'MSG_TARGET')).toBe('DRAFT_TARGET');
    expect(gmail.users.drafts.list).toHaveBeenCalledTimes(2);
    // Second call must carry the page token.
    expect(gmail._calls[1].pageToken).toBe('p2');
  });

  test('returns null when the message id is not among any draft', async () => {
    const gmail = gmailWithPages([{ drafts: [{ id: 'DRAFT_X', message: { id: 'MSG_X' } }] }]);
    expect(await resolveDraftId(gmail, 'MSG_MISSING')).toBeNull();
  });

  test('is bounded by maxPages even if nextPageToken never clears', async () => {
    const gmail = gmailWithPages([{ drafts: [], nextPageToken: 'loop' }]);
    expect(await resolveDraftId(gmail, 'MSG_ANY', 3)).toBeNull();
    expect(gmail.users.drafts.list).toHaveBeenCalledTimes(3);
  });

  test('returns null for a missing messageId without calling the API', async () => {
    const gmail = gmailWithPages([{ drafts: [] }]);
    expect(await resolveDraftId(gmail, '')).toBeNull();
    expect(gmail.users.drafts.list).not.toHaveBeenCalled();
  });
});
