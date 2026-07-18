import { computeReaderNavigation } from './readerNav';

// A small two-account list where two messages share a provider-local id ("dup")
// across accounts — the navigation must stay account-aware.
const list = [
  { id: 'a1', accountId: 'A' },
  { id: 'dup', accountId: 'A' },
  { id: 'b1', accountId: 'B' },
  { id: 'dup', accountId: 'B' },
];

describe('computeReaderNavigation — single destination, no cascade', () => {
  test('next returns exactly one destination object (never a list)', () => {
    const move = computeReaderNavigation(list, list[0], 'next');
    expect(move).toEqual({ index: 1, destination: list[1] });
    // The result is a single destination, not an array of speculative targets.
    expect(Array.isArray(move.destination)).toBe(false);
  });

  test('prev returns the immediately preceding message', () => {
    expect(computeReaderNavigation(list, list[2], 'prev')).toEqual({ index: 1, destination: list[1] });
  });

  test('next at the last row returns null (no move, no load)', () => {
    expect(computeReaderNavigation(list, list[3], 'next')).toBeNull();
  });

  test('prev at the first row returns null (no move, no load)', () => {
    expect(computeReaderNavigation(list, list[0], 'prev')).toBeNull();
  });

  test('no open reader (current null) returns null — cursor mode does not load', () => {
    expect(computeReaderNavigation(list, null, 'next')).toBeNull();
    expect(computeReaderNavigation(list, undefined, 'prev')).toBeNull();
  });

  test('empty or missing list returns null', () => {
    expect(computeReaderNavigation([], list[0], 'next')).toBeNull();
    expect(computeReaderNavigation(null, list[0], 'next')).toBeNull();
  });

  test('current not present in the list returns null', () => {
    expect(computeReaderNavigation(list, { id: 'zzz', accountId: 'A' }, 'next')).toBeNull();
  });

  test('account-aware: same provider id in another account is a distinct row', () => {
    // Moving next from A/dup lands on B/b1, NOT the colliding B/dup.
    const move = computeReaderNavigation(list, { id: 'dup', accountId: 'A' }, 'next');
    expect(move.destination).toEqual({ id: 'b1', accountId: 'B' });
  });

  test('navigating across the full list visits each row once — never fans out', () => {
    // Walk the list start→end and assert every step yields a single neighbor.
    let cur = list[0];
    const visited = [cur];
    for (let step = 0; step < 10; step++) {
      const move = computeReaderNavigation(list, cur, 'next');
      if (!move) break;
      // Each step produces one and only one destination.
      expect(move.destination).toBe(list[visited.length]);
      cur = move.destination;
      visited.push(cur);
    }
    expect(visited).toHaveLength(list.length);
  });
});
