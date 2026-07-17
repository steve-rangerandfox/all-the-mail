// Resolve a Gmail DRAFT id from one of its message ids.
//
// The drafts folder is listed via messages.list, which yields message ids — but
// updating/deleting a draft needs the DRAFT id. The list endpoint enriches rows
// with draftId via a single drafts.list page (fast path, ~100 drafts). When that
// window misses (many drafts, pagination, transient failure), the client falls
// back to this resolver so a reopened draft keeps its canonical provider
// identity instead of being silently reopened as a NEW draft (which would
// orphan/duplicate the original).
//
// Bounded by maxPages so an unusually large mailbox cannot spin indefinitely;
// on exhaustion it returns null and the caller blocks editing with recoverable
// feedback rather than guessing.
export async function resolveDraftId(gmail, messageId, maxPages = 10) {
  if (!messageId) return null;
  let pageToken;
  let pages = 0;
  do {
    const dl = await gmail.users.drafts.list({ userId: 'me', maxResults: 100, pageToken });
    const drafts = dl?.data?.drafts || [];
    const match = drafts.find((d) => d.message && d.message.id === messageId);
    if (match) return match.id;
    pageToken = dl?.data?.nextPageToken;
    pages += 1;
  } while (pageToken && pages < maxPages);
  return null;
}
