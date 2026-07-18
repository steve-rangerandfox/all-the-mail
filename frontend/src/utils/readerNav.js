// Reader navigation — canonical, single-destination step logic.
//
// WHY THIS EXISTS
// ---------------
// One intentional reader-navigation action (J/K or the prev/next arrows) must
// load exactly ONE message: the destination the user is moving to. An earlier
// implementation additionally fired ~15 staggered speculative body loads per
// keypress. With two connected accounts that turned a single J press into ~16
// backend requests, which exhausted the Google API quota; the resulting 429s
// then degraded the reader ("of 0", missing source chip) and the list.
//
// The invariant this module protects:
//   A reader-navigation action produces at most one required provider request
//   for the destination message. There is no unbounded, high-fan-out
//   speculative burst, and rapid repeated navigation cannot multiply requests.
//
// This is intentionally a pure function so the "only the destination is
// loaded" property is unit-testable without React or the network.

import { sameMailItem } from './mailIdentity';

/**
 * Compute the destination for a single reader-navigation step.
 *
 * @param {Array} items      The visible, ordered mail list (filteredEmails).
 * @param {Object|null} current The currently-open reader message, or null when
 *                              no reader is open.
 * @param {'next'|'prev'} direction Which way to move.
 * @returns {{ index: number, destination: Object }|null}
 *          The destination and its index, or null when there is no move to make
 *          (no reader open, current not in the list, or already at the edge).
 *
 * Returns exactly one destination — never a list — so callers physically
 * cannot re-introduce a multi-message prefetch cascade through this path.
 */
export function computeReaderNavigation(items, current, direction) {
  if (!current) return null;
  if (!Array.isArray(items) || items.length === 0) return null;

  const i = items.findIndex(e => sameMailItem(e, current));
  if (i === -1) return null;

  const step = direction === 'next' ? 1 : -1;
  const j = i + step;
  if (j < 0 || j >= items.length) return null;

  return { index: j, destination: items[j] };
}
