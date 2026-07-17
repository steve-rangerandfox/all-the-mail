// Canonical mail-item identity for ALL THE MAIL.
//
// ACCOUNT BOUNDARY INVARIANT
// --------------------------
// A mail item used in any cross-account context is identified by its connected
// *source account* AND its provider-local item ID together. A bare Gmail
// message ID (or thread ID) must NEVER own cross-account state or behavior.
//
// Gmail message/thread IDs are unique only *within* one mailbox — two connected
// accounts can legitimately hold the same provider-local ID. In the unified
// (Everything) view, cross-account search, and batch actions those two items
// coexist, so any map/set/comparison keyed on the bare ID silently collapses
// them: wrong body/headers render, one is hidden from search, a star or
// selection bleeds across accounts, and — worst — a mutation aimed at one
// account's message hits the other account's colliding message.
//
// This module is the single source of truth for that composite key. Everything
// that keys cross-account state (bodies, headers, attachments, prefetch,
// hydration, stars, selection, search dedup, conversation grouping, active-row
// / reader / navigation comparisons) MUST route through these helpers.
//
// IMPORTANT — key format is load-bearing:
//   `mailKey` intentionally produces `${accountId || ''}:${messageId}`, byte-for-
//   byte identical to the historical `emailCache` IndexedDB key. `emailCache`
//   now imports `mailKey`, so previously-persisted body records stay readable —
//   no cache clear or migration is required.
//
// IMPORTANT — never reconstruct targets from a key:
//   A serialized key is for lookup/dedup only. When performing a mutation,
//   derive the target from the original item's own `accountId` + provider ID
//   fields — do NOT split a key string apart. Account IDs are UUIDs and message
//   IDs are hex, so `:` is unambiguous, but parsing is still forbidden because
//   the item already carries the authoritative fields.

/**
 * Composite key for a message in a specific account: `${accountId}:${messageId}`.
 * Matches the legacy emailCache key exactly (do not change the separator —
 * it would orphan persisted IndexedDB records).
 */
export function mailKey(accountId, messageId) {
  return `${accountId || ''}:${messageId}`;
}

/**
 * Composite key for a thread in a specific account: `${accountId}:${threadId}`.
 * Used to group conversations without merging same-threadId threads that
 * belong to different accounts.
 */
export function threadKey(accountId, threadId) {
  return `${accountId || ''}:${threadId}`;
}

/** Composite key derived from an email object (uses its `accountId` + `id`). */
export function emailKey(email) {
  return mailKey(email?.accountId, email?.id);
}

/**
 * Composite thread key derived from an email object. Falls back to the message
 * id when the item has no threadId, matching the existing grouping fallback.
 */
export function emailThreadKey(email) {
  return threadKey(email?.accountId, email?.threadId || email?.id);
}

/**
 * Account-aware equality for two mail items. Two items are the same only when
 * BOTH their provider-local id and their source account match. Nullish account
 * ids compare equal to each other so single-account callers keep working.
 */
export function sameMailItem(a, b) {
  if (!a || !b) return false;
  return a.id === b.id && (a.accountId || null) === (b.accountId || null);
}

/**
 * Persisted snooze key: `${accountId}_${messageId}` (underscore separator).
 *
 * This format predates mailKey and lives in users' browsers (localStorage
 * `atm_snoozed`) and in the snoozed_emails sync path — it MUST stay
 * byte-identical or existing snoozes silently orphan. It is already
 * account-aware (same composite identity as mailKey); only the separator
 * differs, and only for backward compatibility. Do not "normalize" it to `:`.
 */
export function snoozeKey(accountId, messageId) {
  return `${accountId || ''}_${messageId}`;
}
